import { EventEmitter } from "node:events";
import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createZstdDecompress } from "node:zlib";

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
import { CodexEventParser } from "./codex.ts";
import { deriveSessions } from "./derive.ts";
import type { IngestErrorEvent, IngestSummary, SessionUpdatedEvent } from "./ingestor.ts";
import { LineSplitter, type SplitLine } from "./line-splitter.ts";

type ProjectRow = typeof projects.$inferSelect;
type SessionRow = typeof sessions.$inferSelect;
type Compression = (typeof files.$inferSelect)["compression"];

interface PendingEvent {
  line: SplitLine;
  event: ReturnType<CodexEventParser["parse"]>;
  seq: number;
}

interface CodexSessionMetadata {
  sourceSessionId: string;
  parentSessionId: string | undefined;
  forkedFromSessionId: string | undefined;
  agentId: string | undefined;
  clientName: string | undefined;
  clientVersion: string | undefined;
  cwd: string | undefined;
  gitBranch: string | undefined;
  startedAt: number | undefined;
  endedAt: number | undefined;
}

export interface CodexIngestorOptions {
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

function sourceSessionIdFromPath(filePath: string) {
  const matches = basename(filePath).match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  );
  return matches?.at(-1) ?? basename(filePath, extname(filePath));
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function compressionForPath(filePath: string): Compression {
  return filePath.endsWith(".zst") ? "zstd" : "none";
}

function openSource(filePath: string, compression: Compression, start = 0) {
  const file = createReadStream(filePath, compression === "none" ? { start } : undefined);
  const stream = compression === "zstd" ? file.pipe(createZstdDecompress()) : file;
  return { file, stream };
}

function updateMetadata(metadata: CodexSessionMetadata, event: PendingEvent["event"]) {
  if (event.parentSessionId !== undefined) metadata.parentSessionId ??= event.parentSessionId;
  if (event.forkedFromSessionId !== undefined) {
    metadata.forkedFromSessionId ??= event.forkedFromSessionId;
  }
  if (event.agentId !== undefined) metadata.agentId ??= event.agentId;
  if (event.clientName !== undefined) metadata.clientName ??= event.clientName;
  if (event.version !== undefined) metadata.clientVersion ??= event.version;
  if (event.cwd !== undefined) metadata.cwd ??= event.cwd;
  if (event.gitBranch !== undefined) metadata.gitBranch ??= event.gitBranch;
  if (event.timestampMs !== undefined) {
    metadata.startedAt = Math.min(metadata.startedAt ?? event.timestampMs, event.timestampMs);
    metadata.endedAt = Math.max(metadata.endedAt ?? event.timestampMs, event.timestampMs);
  }
}

export function codexSessionId(sourceSessionId: string) {
  return `codex:${sourceSessionId}`;
}

function rawCodexSessionId(sessionId: string | null | undefined) {
  return sessionId?.startsWith("codex:") === true ? sessionId.slice("codex:".length) : sessionId;
}

export class CodexIngestor extends EventEmitter {
  readonly root: string;
  readonly #db: Database;
  readonly #batchSize: number;
  readonly #dirty = new Map<string, true>();
  readonly #parentByThread = new Map<string, string>();
  #draining: Promise<IngestSummary> | undefined;

  constructor(
    db: Database,
    { root = env.codexHomePath, batchSize = 250 }: CodexIngestorOptions = {},
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
    const sourceDirectory = localPath.split(sep)[0];
    if (
      !["sessions", "archived_sessions"].includes(sourceDirectory ?? "") ||
      (!resolved.endsWith(".jsonl") && !resolved.endsWith(".jsonl.zst")) ||
      localPath.startsWith(`..${sep}`)
    ) {
      return false;
    }
    this.#dirty.set(resolved, true);
    return true;
  }

  async scan() {
    const started = performance.now();
    this.#refreshStateEdges();
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
    const paths: string[] = [];
    for (const directory of [join(this.root, "sessions"), join(this.root, "archived_sessions")]) {
      let entries;
      try {
        entries = await readdir(directory, { recursive: true, withFileTypes: true });
      } catch (error) {
        if (isMissingFile(error)) continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = resolve(entry.parentPath, entry.name);
        if (this.enqueue(filePath)) {
          this.#dirty.delete(filePath);
          paths.push(filePath);
        }
      }
    }
    return paths.sort();
  }

  #refreshStateEdges() {
    this.#parentByThread.clear();
    const statePath = join(this.root, "state_5.sqlite");
    if (!existsSync(statePath)) return;
    let state: DatabaseSync | undefined;
    try {
      state = new DatabaseSync(statePath, { readOnly: true });
      const rows = state
        .prepare("SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges")
        .all();
      for (const row of rows) {
        const parent = row["parent_thread_id"];
        const child = row["child_thread_id"];
        if (typeof parent === "string" && typeof child === "string") {
          this.#parentByThread.set(child, parent);
        }
      }
    } catch {
      // Rollout metadata remains the source of truth when optional state is unavailable.
    } finally {
      state?.close();
    }
  }

  async #readHeader(filePath: string, compression: Compression) {
    const parser = new CodexEventParser();
    const splitter = new LineSplitter();
    const { file, stream } = openSource(filePath, compression);
    stream.pipe(splitter);
    try {
      for await (const value of splitter) {
        return parser.parse((value as SplitLine).line);
      }
    } finally {
      stream.destroy();
      file.destroy();
      splitter.destroy();
    }
    return undefined;
  }

  async #drainLoop() {
    const summary = emptySummary();
    const started = performance.now();
    const updates: SessionUpdatedEvent[] = [];
    const sessionsToDerive = new Set<string>();

    while (this.#dirty.size > 0) {
      const filePath = this.#dirty.keys().next().value as string;
      this.#dirty.delete(filePath);
      try {
        const result = await this.#ingestFile(filePath);
        if (result === undefined) continue;
        summary.processedFiles++;
        summary.insertedEvents += result.insertedEvents;
        if (result.rewritten) summary.rewrittenFiles++;
        if (result.insertedEvents > 0 || result.rewritten) {
          sessionsToDerive.add(result.sessionId);
        }
        if (result.insertedEvents > 0) {
          updates.push({
            sessionId: result.sessionId,
            filePath,
            insertedEvents: result.insertedEvents,
          });
        }
      } catch (error) {
        summary.failedFiles++;
        this.emit("ingest:error", { filePath, error } satisfies IngestErrorEvent);
      }
    }

    if (sessionsToDerive.size > 0) {
      deriveSessions(this.#db, sessionsToDerive, { refreshUsageDuplicates: false });
    }
    for (const update of updates) this.emit("session:updated", update);
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

    const compression = compressionForPath(filePath);
    const header = await this.#readHeader(filePath, compression);
    const pathSessionId = sourceSessionIdFromPath(filePath);
    const sourceSessionId = isUuid(pathSessionId)
      ? pathSessionId
      : (header?.sessionId ?? pathSessionId);
    const existingFile = this.#db.query.files.findFirst({ where: { path: filePath } }).sync();
    const existingSession =
      existingFile?.sessionId == null
        ? undefined
        : this.#db.query.sessions.findFirst({ where: { id: existingFile.sessionId } }).sync();
    const metadata: CodexSessionMetadata = {
      sourceSessionId: existingSession?.sourceSessionId ?? sourceSessionId,
      parentSessionId: header?.parentSessionId ?? undefined,
      forkedFromSessionId:
        header?.forkedFromSessionId ?? rawCodexSessionId(existingSession?.forkOf) ?? undefined,
      agentId: header?.agentId ?? existingSession?.agentId ?? undefined,
      clientName: header?.clientName ?? existingSession?.clientName ?? undefined,
      clientVersion: header?.version ?? existingSession?.clientVersion ?? undefined,
      cwd: header?.cwd ?? existingSession?.cwd,
      gitBranch: header?.gitBranch ?? existingSession?.gitBranch ?? undefined,
      startedAt: existingSession?.startedAt ?? undefined,
      endedAt: existingSession?.endedAt ?? undefined,
    };
    metadata.parentSessionId ??= this.#parentByThread.get(metadata.sourceSessionId);
    metadata.cwd ??= this.root;

    let { file, project } = this.#ensureFile(filePath, metadata.cwd, compression);
    let rewritten = false;
    if (
      (compression !== "none" && file.parsedOffset > 0) ||
      (compression === "none" && sourceStat.size < file.parsedOffset)
    ) {
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

    project = this.#updateProject(project, metadata.cwd);
    let session = this.#upsertSession(project, metadata);
    this.#db.update(files).set({ sessionId: session.id }).where(eq(files.id, file.id)).run();
    const parser = new CodexEventParser();
    let nextSeq = file.parsedOffset === 0 ? 0 : this.#nextSequence(file.id);
    let insertedEvents = 0;
    let batch: Array<typeof events.$inferInsert> = [];
    let lastCompleteOffset = file.parsedOffset;
    let previousUuid = this.#latestConversationUuid(file.id);

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
          .set({ parsedOffset, sessionId: session.id })
          .where(eq(files.id, file.id))
          .run();
      });
      batch = [];
    };

    const queueEvent = ({ line, event, seq }: PendingEvent) => {
      const uuid = event.isMeta ? null : `${session.id}:event:${line.byteOffset}`;
      const parentUuid = uuid === null ? null : previousUuid;
      if (uuid !== null) previousUuid = uuid;
      batch.push({
        fileId: file.id,
        sessionId: session.id,
        seq,
        byteOffset: line.byteOffset,
        byteLength: line.byteLength,
        uuid,
        parentUuid,
        timestampMs: event.timestampMs ?? null,
        kind: event.kind,
        type: event.type,
        model: event.model ?? null,
        messageId: event.messageId ?? null,
        requestId: event.requestId ?? null,
        hasUsage: event.hasUsage,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cacheReadTokens: event.usage.cacheReadTokens,
        cacheWriteTokens: event.usage.cacheWriteTokens,
        isSidechain: event.isSidechain,
        isUsageDuplicate: false,
        isDeadBranch: false,
        isMeta: event.isMeta,
        isInterrupt: event.isInterrupt,
      });
      lastCompleteOffset = line.byteOffset + line.byteLength;
      if (batch.length >= this.#batchSize) flush();
    };

    const shouldRead = compression !== "none" || sourceStat.size > file.parsedOffset;
    if (shouldRead) {
      const splitter = new LineSplitter({
        byteOffset: compression === "none" ? file.parsedOffset : 0,
      });
      const { stream } = openSource(
        filePath,
        compression,
        compression === "none" ? file.parsedOffset : 0,
      );
      stream.pipe(splitter);
      for await (const value of splitter) {
        const line = value as SplitLine;
        const event = parser.parse(line.line);
        updateMetadata(metadata, event);
        queueEvent({ line, event, seq: nextSeq++ });
      }
      flush();
      lastCompleteOffset = splitter.remainderByteOffset;
    }

    metadata.parentSessionId ??= this.#parentByThread.get(metadata.sourceSessionId);
    session = this.#upsertSession(project, metadata);
    this.#db
      .update(files)
      .set({
        sessionId: session.id,
        parsedOffset: lastCompleteOffset,
        compression,
        mtimeMs: Math.trunc(sourceStat.mtimeMs),
        size: sourceStat.size,
        lastIngestedAt: Date.now(),
      })
      .where(eq(files.id, file.id))
      .run();
    return { insertedEvents, rewritten, sessionId: session.id };
  }

  #ensureFile(filePath: string, cwd: string, compression: Compression) {
    let project = this.#db.query.projects.findFirst({ where: { path: cwd } }).sync();
    if (project === undefined) {
      const now = Date.now();
      project = this.#db
        .insert(projects)
        .values({ path: cwd, name: basename(cwd) || cwd, createdAt: now, updatedAt: now })
        .returning()
        .get();
    }

    let file = this.#db.query.files.findFirst({ where: { path: filePath } }).sync();
    if (file === undefined) {
      file = this.#db
        .insert(files)
        .values({ projectId: project.id, path: filePath, compression, mtimeMs: 0, size: 0 })
        .returning()
        .get();
    } else if (file.projectId !== project.id || file.compression !== compression) {
      this.#db
        .update(files)
        .set({ projectId: project.id, compression })
        .where(eq(files.id, file.id))
        .run();
      file = { ...file, projectId: project.id, compression };
    }
    return { file, project };
  }

  #updateProject(project: ProjectRow, cwd: string) {
    if (project.path === cwd) return project;
    const conflict = this.#db.query.projects.findFirst({ where: { path: cwd } }).sync();
    return conflict ?? project;
  }

  #upsertSession(project: ProjectRow, metadata: CodexSessionMetadata) {
    const id = codexSessionId(metadata.sourceSessionId);
    const parentId =
      metadata.parentSessionId === undefined ? null : codexSessionId(metadata.parentSessionId);
    const rawForkOf = metadata.forkedFromSessionId;
    const forkOf =
      rawForkOf === undefined || rawForkOf === metadata.sourceSessionId
        ? null
        : codexSessionId(rawForkOf);

    for (const related of [
      parentId === null ? undefined : { id: parentId, rawId: metadata.parentSessionId },
      forkOf === null ? undefined : { id: forkOf, rawId: rawForkOf },
    ]) {
      if (related?.rawId === undefined || related.id === id) continue;
      this.#writeSession({
        id: related.id,
        sourceSessionId: related.rawId,
        projectId: project.id,
        parentId: null,
        forkOf: null,
        agentId: null,
        source: "codex",
        clientName: metadata.clientName ?? null,
        clientVersion: metadata.clientVersion ?? null,
        cwd: metadata.cwd ?? project.path,
        gitBranch: metadata.gitBranch ?? null,
        claudeVersion: null,
        startedAt: null,
        endedAt: null,
      });
    }

    return this.#writeSession({
      id,
      sourceSessionId: metadata.sourceSessionId,
      projectId: project.id,
      parentId,
      forkOf,
      agentId: metadata.agentId ?? (parentId === null ? null : "subagent"),
      source: "codex",
      clientName: metadata.clientName ?? null,
      clientVersion: metadata.clientVersion ?? null,
      cwd: metadata.cwd ?? project.path,
      gitBranch: metadata.gitBranch ?? null,
      claudeVersion: null,
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
      parentId: candidate.parentId ?? existing.parentId,
      forkOf: candidate.forkOf ?? existing.forkOf,
      agentId: candidate.agentId ?? existing.agentId,
      clientName: candidate.clientName ?? existing.clientName,
      clientVersion: candidate.clientVersion ?? existing.clientVersion,
      gitBranch: candidate.gitBranch ?? existing.gitBranch,
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

  #latestConversationUuid(fileId: number) {
    const row = this.#db.$client
      .prepare(
        "SELECT uuid FROM events WHERE file_id = ? AND uuid IS NOT NULL ORDER BY seq DESC LIMIT 1",
      )
      .get(fileId);
    return typeof row?.["uuid"] === "string" ? row["uuid"] : null;
  }
}
