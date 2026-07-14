import { EventEmitter } from "node:events";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

import { eq, sql } from "drizzle-orm";

import type { Database } from "../db/database.ts";
import {
  annotations,
  events,
  files,
  projects,
  sessions,
  sessionStats,
  toolCalls,
} from "../db/schema.ts";
import { env } from "../env.ts";
import { parseClaudeCodeEvent, type NormalizedEvent } from "./claude-code.ts";
import { LineSplitter, type SplitLine } from "./line-splitter.ts";

type ProjectRow = typeof projects.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;

interface PendingEvent {
  line: SplitLine;
  event: NormalizedEvent;
  seq: number;
}

interface SessionMetadata {
  sourceSessionId: string;
  cwd: string | undefined;
  gitBranch: string | undefined;
  version: string | undefined;
  forkedFromSessionId: string | undefined;
  startedAt: number | undefined;
  endedAt: number | undefined;
}

export interface IngestSummary {
  discoveredFiles: number;
  queuedFiles: number;
  processedFiles: number;
  rewrittenFiles: number;
  insertedEvents: number;
  failedFiles: number;
  durationMs: number;
}

export interface SessionUpdatedEvent {
  sessionId: string;
  filePath: string;
  insertedEvents: number;
}

export interface IngestErrorEvent {
  filePath: string;
  error: unknown;
}

export interface ClaudeIngestorOptions {
  root?: string;
  batchSize?: number;
}

function emptySummary(): IngestSummary {
  return {
    discoveredFiles: 0,
    queuedFiles: 0,
    processedFiles: 0,
    rewrittenFiles: 0,
    insertedEvents: 0,
    failedFiles: 0,
    durationMs: 0,
  };
}

function isMissingFile(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function earlier(left: number | null | undefined, right: number | undefined) {
  if (left == null) return right ?? null;
  if (right === undefined) return left;
  return Math.min(left, right);
}

function later(left: number | null | undefined, right: number | undefined) {
  if (left == null) return right ?? null;
  if (right === undefined) return left;
  return Math.max(left, right);
}

function agentIdentity(filePath: string) {
  const filename = basename(filePath, extname(filePath));
  const isAgent = filename.startsWith("agent-") && basename(dirname(filePath)) === "subagents";
  return {
    agentId: isAgent ? filename : undefined,
    sourceSessionId: isAgent ? basename(dirname(dirname(filePath))) : filename,
  };
}

function updateSessionMetadata(metadata: SessionMetadata, event: NormalizedEvent, locked: boolean) {
  if (!locked && event.sessionId !== undefined) metadata.sourceSessionId = event.sessionId;
  if (event.cwd !== undefined) metadata.cwd = event.cwd;
  if (event.gitBranch !== undefined) metadata.gitBranch = event.gitBranch;
  if (event.version !== undefined) metadata.version = event.version;
  if (event.forkedFromSessionId !== undefined) {
    metadata.forkedFromSessionId = event.forkedFromSessionId;
  }
  if (event.timestampMs !== undefined) {
    metadata.startedAt = Math.min(metadata.startedAt ?? event.timestampMs, event.timestampMs);
    metadata.endedAt = Math.max(metadata.endedAt ?? event.timestampMs, event.timestampMs);
  }
}

export class ClaudeIngestor extends EventEmitter {
  readonly root: string;
  readonly #db: Database;
  readonly #batchSize: number;
  readonly #dirty = new Map<string, true>();
  #draining: Promise<IngestSummary> | undefined;

  constructor(
    db: Database,
    { root = env.claudeProjectsPath, batchSize = 250 }: ClaudeIngestorOptions = {},
  ) {
    super();
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new RangeError("batchSize must be a positive safe integer");
    }

    this.#db = db;
    this.root = resolve(root);
    this.#batchSize = batchSize;
  }

  enqueue(filePath: string) {
    const resolved = resolve(filePath);
    const localPath = relative(this.root, resolved);
    if (
      extname(resolved) !== ".jsonl" ||
      localPath === "" ||
      localPath === ".." ||
      localPath.startsWith(`..${sep}`)
    ) {
      return false;
    }

    this.#dirty.set(resolved, true);
    return true;
  }

  async scan() {
    const started = performance.now();
    const paths = await this.#discoverFiles();
    let queuedFiles = 0;

    for (const filePath of paths) {
      let sourceStat;
      try {
        sourceStat = await stat(filePath);
      } catch (error) {
        if (isMissingFile(error)) continue;
        throw error;
      }
      if (!sourceStat.isFile()) continue;

      const existing = this.#db.query.files.findFirst({ where: { path: filePath } }).sync();
      const mtimeMs = Math.trunc(sourceStat.mtimeMs);
      if (
        existing === undefined ||
        existing.mtimeMs !== mtimeMs ||
        existing.size !== sourceStat.size
      ) {
        if (this.enqueue(filePath)) queuedFiles++;
      }
    }

    const summary = await this.drain();
    summary.discoveredFiles = paths.length;
    summary.queuedFiles = queuedFiles;
    summary.durationMs = Math.round(performance.now() - started);
    return summary;
  }

  async reindex() {
    this.#db.transaction((tx) => {
      tx.delete(toolCalls).run();
      tx.delete(annotations).run();
      tx.delete(sessionStats).run();
      tx.delete(events).run();
      tx.update(files)
        .set({
          sessionId: null,
          parsedOffset: 0,
          mtimeMs: 0,
          size: 0,
          lastIngestedAt: null,
        })
        .run();
      tx.run(
        sql.raw(
          "DELETE FROM sqlite_sequence WHERE name IN ('events', 'tool_calls', 'annotations', 'session_stats')",
        ),
      );
    });
    return this.scan();
  }

  drain() {
    this.#draining ??= this.#drainLoop().finally(() => {
      this.#draining = undefined;
    });
    return this.#draining;
  }

  async #discoverFiles() {
    let entries;
    try {
      entries = await readdir(this.root, { recursive: true, withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw error;
    }

    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => resolve(entry.parentPath, entry.name))
      .sort((left, right) => {
        const depth = left.split(sep).length - right.split(sep).length;
        return depth === 0 ? left.localeCompare(right) : depth;
      });
  }

  async #drainLoop() {
    const summary = emptySummary();
    const started = performance.now();

    while (this.#dirty.size > 0) {
      const filePath = this.#dirty.keys().next().value as string;
      this.#dirty.delete(filePath);

      try {
        const result = await this.#ingestFile(filePath);
        if (result === undefined) continue;
        summary.processedFiles++;
        summary.insertedEvents += result.insertedEvents;
        if (result.rewritten) summary.rewrittenFiles++;
        if (result.sessionId !== undefined && result.insertedEvents > 0) {
          this.emit("session:updated", {
            sessionId: result.sessionId,
            filePath,
            insertedEvents: result.insertedEvents,
          } satisfies SessionUpdatedEvent);
        }
      } catch (error) {
        summary.failedFiles++;
        this.emit("ingest:error", { filePath, error } satisfies IngestErrorEvent);
      }
    }

    summary.durationMs = Math.round(performance.now() - started);
    return summary;
  }

  async #ingestFile(filePath: string) {
    let sourceStat;
    try {
      sourceStat = await stat(filePath);
    } catch (error) {
      if (isMissingFile(error)) return undefined;
      throw error;
    }
    if (!sourceStat.isFile()) return undefined;

    let { file, project } = this.#ensureFile(filePath);
    let rewritten = false;
    if (sourceStat.size < file.parsedOffset) {
      rewritten = true;
      const previousSessionId = file.sessionId;
      this.#db.transaction((tx) => {
        if (previousSessionId !== null) {
          tx.delete(toolCalls).where(eq(toolCalls.sessionId, previousSessionId)).run();
          tx.delete(annotations).where(eq(annotations.sessionId, previousSessionId)).run();
          tx.delete(sessionStats).where(eq(sessionStats.sessionId, previousSessionId)).run();
        }
        tx.delete(events).where(eq(events.fileId, file.id)).run();
        tx.update(files)
          .set({ sessionId: null, parsedOffset: 0, mtimeMs: 0, size: 0, lastIngestedAt: null })
          .where(eq(files.id, file.id))
          .run();
      });
      file = { ...file, sessionId: null, parsedOffset: 0, mtimeMs: 0, size: 0 };
    }

    const existingSession =
      file.sessionId === null
        ? undefined
        : this.#db.query.sessions.findFirst({ where: { id: file.sessionId } }).sync();
    const identity = agentIdentity(filePath);
    const metadata: SessionMetadata = {
      sourceSessionId: existingSession?.sourceSessionId ?? identity.sourceSessionId,
      cwd: existingSession?.cwd,
      gitBranch: existingSession?.gitBranch ?? undefined,
      version: existingSession?.claudeVersion ?? undefined,
      forkedFromSessionId: existingSession?.forkOf ?? undefined,
      startedAt: existingSession?.startedAt ?? undefined,
      endedAt: existingSession?.endedAt ?? undefined,
    };
    let sessionId = existingSession?.id;
    let identityLocked = sessionId !== undefined;
    let nextSeq = file.parsedOffset === 0 ? 0 : this.#nextSequence(file.id);
    let insertedEvents = 0;
    let batch: Array<typeof events.$inferInsert> = [];
    const buffered: PendingEvent[] = [];
    let lastCompleteOffset = file.parsedOffset;

    const establishSession = () => {
      if (sessionId !== undefined) return;
      metadata.cwd ??= project.path;
      project = this.#updateProjectFromSession(project, metadata.cwd);
      sessionId = this.#upsertSession(project, metadata, identity.agentId).id;
      identityLocked = true;
      this.#db.update(files).set({ sessionId }).where(eq(files.id, file.id)).run();
    };

    const flush = () => {
      if (batch.length === 0) return;
      const parsedOffset = lastCompleteOffset;
      this.#db.transaction((tx) => {
        const result = tx
          .insert(events)
          .values(batch)
          .onConflictDoNothing({ target: [events.sessionId, events.seq] })
          .run();
        insertedEvents += Number(result.changes);
        tx.update(files)
          .set({ parsedOffset, sessionId: sessionId ?? null })
          .where(eq(files.id, file.id))
          .run();
      });
      batch = [];
    };

    const queueEvent = ({ line, event, seq }: PendingEvent) => {
      if (sessionId === undefined) throw new Error("Session identity was not established");
      batch.push({
        fileId: file.id,
        sessionId,
        seq,
        byteOffset: line.byteOffset,
        byteLength: line.byteLength,
        uuid: event.uuid ?? null,
        parentUuid: event.parentUuid ?? null,
        timestampMs: event.timestampMs ?? null,
        kind: event.kind,
        type: event.type,
        model: event.model ?? null,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cacheReadTokens: event.usage.cacheReadTokens,
        cacheWriteTokens: event.usage.cacheWriteTokens,
        isSidechain: event.isSidechain,
        isDeadBranch: false,
        isMeta: event.isMeta,
        isInterrupt: event.isInterrupt,
      });
      lastCompleteOffset = line.byteOffset + line.byteLength;
      if (batch.length >= this.#batchSize) flush();
    };

    if (sourceStat.size > file.parsedOffset) {
      const splitter = new LineSplitter({ byteOffset: file.parsedOffset });
      createReadStream(filePath, { start: file.parsedOffset, end: sourceStat.size - 1 }).pipe(
        splitter,
      );

      for await (const value of splitter) {
        const line = value as SplitLine;
        const event = parseClaudeCodeEvent(line.line);
        updateSessionMetadata(metadata, event, identityLocked);
        const pending = { line, event, seq: nextSeq++ } satisfies PendingEvent;

        if (sessionId === undefined) {
          buffered.push(pending);
          if (metadata.cwd === undefined) continue;
          establishSession();
          for (const bufferedEvent of buffered) queueEvent(bufferedEvent);
          buffered.length = 0;
        } else {
          queueEvent(pending);
        }
      }

      if (buffered.length > 0) {
        establishSession();
        for (const bufferedEvent of buffered) queueEvent(bufferedEvent);
      }
      flush();
      lastCompleteOffset = splitter.remainderByteOffset;
    }

    if (sessionId !== undefined) {
      metadata.cwd ??= project.path;
      this.#upsertSession(project, metadata, identity.agentId);
    }
    this.#db
      .update(files)
      .set({
        sessionId: sessionId ?? null,
        parsedOffset: lastCompleteOffset,
        mtimeMs: Math.trunc(sourceStat.mtimeMs),
        size: sourceStat.size,
        lastIngestedAt: Date.now(),
      })
      .where(eq(files.id, file.id))
      .run();

    return { insertedEvents, rewritten, sessionId };
  }

  #ensureFile(filePath: string) {
    const localPath = relative(this.root, filePath);
    const projectDirectoryName = localPath.split(sep)[0];
    if (!projectDirectoryName) throw new Error(`Cannot determine project for ${filePath}`);
    const sourcePath = join(this.root, projectDirectoryName);
    let project = this.#db.query.projects.findFirst({ where: { sourcePath } }).sync();
    project ??= this.#db.query.projects.findFirst({ where: { path: sourcePath } }).sync();

    if (project === undefined) {
      const now = Date.now();
      project = this.#db
        .insert(projects)
        .values({
          sourcePath,
          path: sourcePath,
          name: basename(sourcePath),
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .get();
    } else if (project.sourcePath === null) {
      this.#db.update(projects).set({ sourcePath }).where(eq(projects.id, project.id)).run();
      project = { ...project, sourcePath };
    }

    let file = this.#db.query.files.findFirst({ where: { path: filePath } }).sync();
    if (file === undefined) {
      file = this.#db
        .insert(files)
        .values({ projectId: project.id, path: filePath, mtimeMs: 0, size: 0 })
        .returning()
        .get();
    } else if (file.projectId !== project.id) {
      this.#db.update(files).set({ projectId: project.id }).where(eq(files.id, file.id)).run();
      file = { ...file, projectId: project.id };
    }

    return { file, project };
  }

  #updateProjectFromSession(project: ProjectRow, cwd: string) {
    if (project.path === cwd) return project;
    const conflict = this.#db.query.projects.findFirst({ where: { path: cwd } }).sync();
    if (conflict !== undefined && conflict.id !== project.id) return project;

    const name = basename(cwd) || cwd;
    const updatedAt = Date.now();
    this.#db
      .update(projects)
      .set({ path: cwd, name, updatedAt })
      .where(eq(projects.id, project.id))
      .run();
    return { ...project, path: cwd, name, updatedAt };
  }

  #upsertSession(project: ProjectRow, metadata: SessionMetadata, agentId: string | undefined) {
    const cwd = metadata.cwd ?? project.path;
    const sessionId =
      agentId === undefined
        ? metadata.sourceSessionId
        : `${metadata.sourceSessionId}:agent:${agentId}`;
    const parentId = agentId === undefined ? null : metadata.sourceSessionId;

    if (parentId !== null) {
      this.#writeSession({
        id: parentId,
        sourceSessionId: metadata.sourceSessionId,
        projectId: project.id,
        parentId: null,
        forkOf: null,
        agentId: null,
        cwd,
        gitBranch: metadata.gitBranch ?? null,
        claudeVersion: metadata.version ?? null,
        startedAt: null,
        endedAt: null,
      });
    }

    let forkOf = metadata.forkedFromSessionId;
    if (forkOf === sessionId) forkOf = undefined;
    if (forkOf !== undefined) {
      this.#writeSession({
        id: forkOf,
        sourceSessionId: forkOf,
        projectId: project.id,
        parentId: null,
        forkOf: null,
        agentId: null,
        cwd,
        gitBranch: metadata.gitBranch ?? null,
        claudeVersion: metadata.version ?? null,
        startedAt: null,
        endedAt: null,
      });
    }

    return this.#writeSession({
      id: sessionId,
      sourceSessionId: metadata.sourceSessionId,
      projectId: project.id,
      parentId,
      forkOf: forkOf ?? null,
      agentId: agentId ?? null,
      cwd,
      gitBranch: metadata.gitBranch ?? null,
      claudeVersion: metadata.version ?? null,
      startedAt: metadata.startedAt ?? null,
      endedAt: metadata.endedAt ?? null,
    });
  }

  #writeSession(candidate: typeof sessions.$inferInsert): SessionRow {
    const existing = this.#db.query.sessions.findFirst({ where: { id: candidate.id } }).sync();
    if (existing === undefined) {
      return this.#db.insert(sessions).values(candidate).returning().get();
    }

    const updated: typeof sessions.$inferInsert = {
      ...candidate,
      gitBranch: candidate.gitBranch ?? existing.gitBranch,
      claudeVersion: candidate.claudeVersion ?? existing.claudeVersion,
      startedAt: earlier(existing.startedAt, candidate.startedAt ?? undefined),
      endedAt: later(existing.endedAt, candidate.endedAt ?? undefined),
    };
    this.#db.update(sessions).set(updated).where(eq(sessions.id, existing.id)).run();
    return { ...existing, ...updated } as SessionRow;
  }

  #nextSequence(fileId: number) {
    const row = this.#db.$client
      .prepare("SELECT coalesce(max(seq), -1) + 1 AS next_seq FROM events WHERE file_id = ?")
      .get(fileId);
    const value = row?.["next_seq"];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      throw new Error(`Invalid next sequence for file ${fileId}`);
    }
    return value;
  }
}
