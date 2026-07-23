import { readFileSync } from "node:fs";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database } from "../db/database.ts";
import {
  annotations,
  events,
  files,
  modelPricing,
  sessions,
  sessionStats,
  toolCalls,
} from "../db/schema.ts";
import {
  annotationIdentifier,
  parseClaudeCodeEvent,
  type NormalizedEvent,
  type NormalizedToolUse,
} from "./claude-code.ts";
import { CodexEventParser } from "./codex.ts";

type EventRow = typeof events.$inferSelect;
type ToolCallInsert = typeof toolCalls.$inferInsert;
type AnnotationInsert = typeof annotations.$inferInsert;
type SessionRow = typeof sessions.$inferSelect;

interface DerivedEvent {
  row: EventRow;
  normalized: NormalizedEvent;
}

interface PendingToolCall {
  source: DerivedEvent;
  tool: NormalizedToolUse;
}

interface UsageRepresentative {
  id: number;
  messageId: string;
  requestId: string | null;
  isSidechain: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface DerivationSummary {
  sessionId: string;
  deadBranchEvents: number;
  toolCalls: number;
  unmatchedToolCalls: number;
  annotations: number;
}

function structuralPathSegments(value: string) {
  return value.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

function scratchpadValue(targetPath: string) {
  return structuralPathSegments(targetPath).includes("scratchpad") ? "scratchpad" : undefined;
}

function worktreeValue(cwd: string) {
  const segments = structuralPathSegments(cwd);
  const worktreesIndex = segments.lastIndexOf("worktrees");
  if (worktreesIndex < 0) return undefined;
  const owner = segments[worktreesIndex - 1];
  if (owner === ".t3") return "t3";
  if (owner === ".claude") return "claude";
  return "worktree";
}

function sidecarSkill(db: Database, session: SessionRow) {
  if (session.source !== "claude" || session.agentId === null) return undefined;
  const sourceFiles = db
    .select({ path: files.path })
    .from(files)
    .where(eq(files.sessionId, session.id))
    .orderBy(asc(files.path))
    .all();

  for (const sourceFile of sourceFiles) {
    if (!sourceFile.path.endsWith(".jsonl")) continue;
    const sidecarPath = `${sourceFile.path.slice(0, -".jsonl".length)}.meta.json`;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(sidecarPath, "utf8"));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
    const sidecar = parsed as Record<string, unknown>;
    const agentType = annotationIdentifier(sidecar["agentType"]);
    if (agentType?.includes(":") !== true) continue;
    const toolUseId = annotationIdentifier(sidecar["toolUseId"]);
    const spawn =
      toolUseId === undefined || session.parentId === null
        ? undefined
        : db
            .select({
              sourceEventId: toolCalls.sourceEventId,
              startedAt: toolCalls.startedAt,
            })
            .from(toolCalls)
            .where(
              and(eq(toolCalls.sessionId, session.parentId), eq(toolCalls.toolUseId, toolUseId)),
            )
            .limit(1)
            .get();
    return {
      agentType,
      eventId: spawn?.sourceEventId ?? null,
      createdAt: spawn?.startedAt ?? session.startedAt ?? 0,
    };
  }
  return undefined;
}

function annotationRows(
  db: Database,
  session: SessionRow,
  derivedEvents: DerivedEvent[],
): AnnotationInsert[] {
  const candidates: AnnotationInsert[] = [];
  const push = (candidate: AnnotationInsert) => {
    if (
      candidates.some(
        (existing) =>
          existing.eventId === candidate.eventId &&
          existing.kind === candidate.kind &&
          existing.value === candidate.value,
      )
    ) {
      return;
    }
    candidates.push(candidate);
  };

  for (const event of derivedEvents) {
    const createdAt = event.row.timestampMs ?? session.startedAt ?? 0;
    for (const annotation of event.normalized.annotations) {
      push({
        sessionId: session.id,
        eventId: event.row.id,
        kind: annotation.kind,
        value: annotation.value,
        createdAt,
      });
    }
    for (const tool of event.normalized.toolUses) {
      if (tool.targetPath === undefined) continue;
      const value = scratchpadValue(tool.targetPath);
      if (value === undefined) continue;
      push({
        sessionId: session.id,
        eventId: event.row.id,
        kind: "scratchpad",
        value,
        createdAt,
      });
    }
  }

  const worktree = worktreeValue(session.cwd);
  if (worktree !== undefined) {
    push({
      sessionId: session.id,
      eventId: null,
      kind: "worktree",
      value: worktree,
      createdAt: session.startedAt ?? 0,
    });
  }

  const skill = sidecarSkill(db, session);
  if (skill !== undefined) {
    push({
      sessionId: session.id,
      eventId: skill.eventId,
      kind: "skill",
      value: skill.agentType,
      createdAt: skill.createdAt,
    });
  }

  return candidates.sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      (left.eventId ?? -1) - (right.eventId ?? -1) ||
      left.kind.localeCompare(right.kind) ||
      left.value.localeCompare(right.value),
  );
}

function annotationKey(annotation: Pick<AnnotationInsert, "eventId" | "kind" | "value">) {
  return JSON.stringify([annotation.eventId ?? null, annotation.kind, annotation.value]);
}

function reconcileAnnotations(db: Database, sessionId: string, desiredRows: AnnotationInsert[]) {
  const desired = new Map(desiredRows.map((row) => [annotationKey(row), row]));
  const existing = db
    .select()
    .from(annotations)
    .where(eq(annotations.sessionId, sessionId))
    .orderBy(asc(annotations.id))
    .all();
  const retained = new Set<string>();
  const deleteIds: number[] = [];
  const updateTimes: Array<{ id: number; createdAt: number }> = [];

  for (const row of existing) {
    const key = annotationKey(row);
    const candidate = desired.get(key);
    if (candidate === undefined || retained.has(key)) {
      deleteIds.push(row.id);
      continue;
    }
    retained.add(key);
    if (row.createdAt !== candidate.createdAt) {
      updateTimes.push({ id: row.id, createdAt: candidate.createdAt });
    }
  }
  const inserts = [...desired].flatMap(([key, row]) => (retained.has(key) ? [] : [row]));

  db.transaction((tx) => {
    for (let index = 0; index < deleteIds.length; index += 500) {
      tx.delete(annotations)
        .where(inArray(annotations.id, deleteIds.slice(index, index + 500)))
        .run();
    }
    for (const update of updateTimes) {
      tx.update(annotations)
        .set({ createdAt: update.createdAt })
        .where(eq(annotations.id, update.id))
        .run();
    }
    for (let index = 0; index < inserts.length; index += 250) {
      tx.insert(annotations)
        .values(inserts.slice(index, index + 250))
        .run();
    }
  });
}

function findDeadBranchEvents(derivedEvents: DerivedEvent[]) {
  const nodes = derivedEvents.filter(({ row }) => row.uuid !== null);
  if (nodes.length === 0) return new Set<number>();

  const byUuid = new Map(nodes.map((event) => [event.row.uuid as string, event]));
  const parentsWithChildren = new Set(
    nodes.flatMap(({ row }) => (row.parentUuid === null ? [] : [row.parentUuid])),
  );
  const leaves = nodes.filter(({ row }) => !parentsWithChildren.has(row.uuid as string));
  const latestLeaf = (leaves.length === 0 ? nodes : leaves).reduce((latest, event) =>
    event.row.seq > latest.row.seq ? event : latest,
  );
  const activeUuids = new Set<string>();
  let current: DerivedEvent | undefined = latestLeaf;

  while (current?.row.uuid !== null && current?.row.uuid !== undefined) {
    if (activeUuids.has(current.row.uuid)) break;
    activeUuids.add(current.row.uuid);
    current = current.row.parentUuid === null ? undefined : byUuid.get(current.row.parentUuid);
  }

  return new Set(
    nodes.filter(({ row }) => !activeUuids.has(row.uuid as string)).map(({ row }) => row.id),
  );
}

function toolCallRows(derivedEvents: DerivedEvent[], deadEventIds: Set<number>) {
  const pending = new Map<string, PendingToolCall>();
  const seenToolUseIds = new Set<string>();
  const calls: ToolCallInsert[] = [];
  let latestInterruptSeq = -1;

  for (const event of derivedEvents) {
    if (event.normalized.isInterrupt) latestInterruptSeq = event.row.seq;
    for (const tool of event.normalized.toolUses) {
      if (seenToolUseIds.has(tool.toolUseId)) continue;
      seenToolUseIds.add(tool.toolUseId);
      pending.set(tool.toolUseId, { source: event, tool });
    }
    for (const result of event.normalized.toolResults) {
      const match = pending.get(result.toolUseId);
      if (match === undefined) continue;
      pending.delete(result.toolUseId);
      const startedAt = match.source.row.timestampMs;
      const endedAt = event.row.timestampMs;
      calls.push({
        sessionId: event.row.sessionId,
        sourceEventId: match.source.row.id,
        resultEventId: event.row.id,
        toolUseId: match.tool.toolUseId,
        name: match.tool.name,
        inputSummary: match.tool.inputSummary,
        targetPath: match.tool.targetPath ?? null,
        startedAt,
        endedAt,
        durationMs:
          startedAt !== null && endedAt !== null && endedAt >= startedAt
            ? endedAt - startedAt
            : null,
        status: result.isError ? "error" : "completed",
        isError: result.isError,
      });
    }
  }

  const latestSeq = derivedEvents.at(-1)?.row.seq ?? -1;
  for (const { source, tool } of pending.values()) {
    const status =
      latestInterruptSeq > source.row.seq
        ? "interrupted"
        : latestSeq === source.row.seq
          ? "pending"
          : "unmatched";
    calls.push({
      sessionId: source.row.sessionId,
      sourceEventId: source.row.id,
      resultEventId: null,
      toolUseId: tool.toolUseId,
      name: tool.name,
      inputSummary: tool.inputSummary,
      targetPath: tool.targetPath ?? null,
      startedAt: source.row.timestampMs,
      endedAt: null,
      durationMs: null,
      status,
      isError: false,
    });
  }

  const eventById = new Map(derivedEvents.map(({ row }) => [row.id, row]));
  const activeCount = calls.filter((call) => {
    const source = eventById.get(call.sourceEventId);
    return !deadEventIds.has(call.sourceEventId) && source?.isUsageDuplicate !== true;
  }).length;
  return { calls, activeCount };
}

function calculateCost(
  derivedEvents: DerivedEvent[],
  deadEventIds: Set<number>,
  pricing: Array<typeof modelPricing.$inferSelect>,
) {
  let cost = 0;
  for (const { row } of derivedEvents) {
    if (row.isUsageDuplicate || deadEventIds.has(row.id) || row.model === null) continue;
    const timestamp = row.timestampMs ?? Number.MAX_SAFE_INTEGER;
    const price = pricing
      .filter((candidate) => candidate.model === row.model && candidate.effectiveFrom <= timestamp)
      .sort((left, right) => right.effectiveFrom - left.effectiveFrom)[0];
    if (price === undefined) continue;
    cost +=
      (row.inputTokens * price.inputUsdPerMtok +
        row.outputTokens * price.outputUsdPerMtok +
        row.cacheReadTokens * price.cacheReadUsdPerMtok +
        row.cacheWriteTokens * price.cacheWriteUsdPerMtok) /
      1_000_000;
  }
  return cost;
}

function sessionStatistics(
  sessionId: string,
  derivedEvents: DerivedEvent[],
  deadEventIds: Set<number>,
  activeToolCalls: number,
  costUsd: number,
) {
  let userTurns = 0;
  let assistantTurns = 0;
  let tokInput = 0;
  let tokOutput = 0;
  let tokCacheRead = 0;
  let tokCacheWrite = 0;
  let tokDeadBranch = 0;
  let startedAt: number | undefined;
  let endedAt: number | undefined;
  let latestEventAt: number | undefined;

  for (const { row, normalized } of derivedEvents) {
    if (row.timestampMs !== null) {
      latestEventAt = Math.max(latestEventAt ?? row.timestampMs, row.timestampMs);
    }
    if (row.isUsageDuplicate) continue;
    if (deadEventIds.has(row.id)) {
      tokDeadBranch +=
        row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
      continue;
    }

    tokInput += row.inputTokens;
    tokOutput += row.outputTokens;
    tokCacheRead += row.cacheReadTokens;
    tokCacheWrite += row.cacheWriteTokens;
    if (!row.isMeta && normalized.kind === "user" && normalized.toolResults.length === 0) {
      userTurns++;
    }
    if (!row.isMeta && normalized.kind === "assistant") assistantTurns++;
    if (!row.isMeta && row.timestampMs !== null) {
      startedAt = Math.min(startedAt ?? row.timestampMs, row.timestampMs);
      endedAt = Math.max(endedAt ?? row.timestampMs, row.timestampMs);
    }
  }

  return {
    sessionId,
    userTurns,
    assistantTurns,
    toolCalls: activeToolCalls,
    startedAt: startedAt ?? null,
    endedAt: endedAt ?? null,
    durationMs:
      startedAt !== undefined && endedAt !== undefined ? Math.max(0, endedAt - startedAt) : null,
    tokInput,
    tokOutput,
    tokCacheRead,
    tokCacheWrite,
    tokDeadBranch,
    costUsd,
    updatedAt: latestEventAt ?? endedAt ?? startedAt ?? 0,
  } satisfies typeof sessionStats.$inferInsert;
}

function usageTotal(event: UsageRepresentative) {
  return event.inputTokens + event.outputTokens + event.cacheReadTokens + event.cacheWriteTokens;
}

function exactUsageKey(messageId: string, requestId: string | null) {
  return JSON.stringify([messageId, requestId]);
}

function addIndex(indexes: Map<string, number[]>, key: string, index: number) {
  const bucket = indexes.get(key) ?? [];
  if (!bucket.includes(index)) bucket.push(index);
  indexes.set(key, bucket);
}

export function markUsageDuplicates(db: Database) {
  const usageEvents = db
    .select({
      id: events.id,
      messageId: events.messageId,
      requestId: events.requestId,
      isSidechain: events.isSidechain,
      inputTokens: events.inputTokens,
      outputTokens: events.outputTokens,
      cacheReadTokens: events.cacheReadTokens,
      cacheWriteTokens: events.cacheWriteTokens,
    })
    .from(events)
    .innerJoin(files, eq(events.fileId, files.id))
    .where(eq(events.hasUsage, true))
    .orderBy(asc(files.path), asc(events.seq))
    .all();
  const representatives: UsageRepresentative[] = [];
  const exactIndexes = new Map<string, number[]>();
  const messageIndexes = new Map<string, number[]>();
  const duplicateIds = new Set<number>();

  for (const candidate of usageEvents) {
    if (candidate.messageId === null) continue;
    const event = { ...candidate, messageId: candidate.messageId } satisfies UsageRepresentative;
    const exactKey = exactUsageKey(event.messageId, event.requestId);
    let representativeIndex = exactIndexes.get(exactKey)?.find((index) => {
      const existing = representatives[index];
      return existing?.messageId === event.messageId && existing.requestId === event.requestId;
    });
    representativeIndex ??= messageIndexes.get(event.messageId)?.find((index) => {
      const existing = representatives[index];
      return existing?.messageId === event.messageId && (event.isSidechain || existing.isSidechain);
    });

    if (representativeIndex !== undefined) {
      const existing = representatives[representativeIndex];
      if (existing === undefined) throw new Error("Missing usage representative");
      const replace =
        event.isSidechain !== existing.isSidechain
          ? existing.isSidechain
          : usageTotal(event) > usageTotal(existing);
      if (replace) {
        duplicateIds.add(existing.id);
        representatives[representativeIndex] = event;
        addIndex(exactIndexes, exactKey, representativeIndex);
        addIndex(messageIndexes, event.messageId, representativeIndex);
      } else {
        duplicateIds.add(event.id);
      }
      continue;
    }

    const index = representatives.length;
    representatives.push(event);
    addIndex(exactIndexes, exactKey, index);
    addIndex(messageIndexes, event.messageId, index);
  }

  db.transaction((tx) => {
    tx.update(events).set({ isUsageDuplicate: false }).run();
    const ids = [...duplicateIds];
    for (let index = 0; index < ids.length; index += 500) {
      tx.update(events)
        .set({ isUsageDuplicate: true })
        .where(inArray(events.id, ids.slice(index, index + 500)))
        .run();
    }
  });

  return duplicateIds.size;
}

function normalizedEvents(db: Database, sessionId: string) {
  const session = db.query.sessions.findFirst({ where: { id: sessionId } }).sync();
  if (session === undefined) throw new Error(`Missing session ${sessionId}`);
  const rows = db
    .select()
    .from(events)
    .where(eq(events.sessionId, sessionId))
    .orderBy(asc(events.seq))
    .all();
  const fileIds = [...new Set(rows.map(({ fileId }) => fileId))];
  const sourceFiles = new Map(
    (fileIds.length === 0
      ? []
      : db.select().from(files).where(inArray(files.id, fileIds)).all()
    ).map((file) => [file.id, file]),
  );
  const buffers = new Map<number, Buffer>();
  const codexParsers = new Map<number, CodexEventParser>();

  const derivedEvents = rows.map((row) => {
    const file = sourceFiles.get(row.fileId);
    if (file === undefined) throw new Error(`Missing source file ${row.fileId}`);
    let buffer = buffers.get(file.id);
    if (buffer === undefined) {
      const source = readFileSync(file.path);
      buffer =
        file.compression === "zstd"
          ? zstdDecompressSync(source)
          : file.compression === "gzip"
            ? gunzipSync(source)
            : source;
      buffers.set(file.id, buffer);
    }
    const line = buffer.subarray(row.byteOffset, row.byteOffset + row.byteLength).toString("utf8");
    let normalized: NormalizedEvent;
    if (session.source === "codex") {
      let parser = codexParsers.get(file.id);
      if (parser === undefined) {
        parser = new CodexEventParser();
        codexParsers.set(file.id, parser);
      }
      normalized = parser.parse(line);
    } else {
      normalized = parseClaudeCodeEvent(line);
    }
    return { row, normalized } satisfies DerivedEvent;
  });
  return { session, derivedEvents };
}

export function deriveSession(db: Database, sessionId: string): DerivationSummary {
  const { session, derivedEvents } = normalizedEvents(db, sessionId);
  const deadEventIds = findDeadBranchEvents(derivedEvents);
  const { calls, activeCount } = toolCallRows(derivedEvents, deadEventIds);
  const derivedAnnotations = annotationRows(db, session, derivedEvents);
  const pricing = db.select().from(modelPricing).all();
  const stats = sessionStatistics(
    sessionId,
    derivedEvents,
    deadEventIds,
    activeCount,
    calculateCost(derivedEvents, deadEventIds, pricing),
  );

  db.transaction((tx) => {
    tx.update(events).set({ isDeadBranch: false }).where(eq(events.sessionId, sessionId)).run();
    const deadIds = [...deadEventIds];
    for (let index = 0; index < deadIds.length; index += 500) {
      tx.update(events)
        .set({ isDeadBranch: true })
        .where(inArray(events.id, deadIds.slice(index, index + 500)))
        .run();
    }
    tx.delete(toolCalls).where(eq(toolCalls.sessionId, sessionId)).run();
    for (let index = 0; index < calls.length; index += 250) {
      tx.insert(toolCalls)
        .values(calls.slice(index, index + 250))
        .run();
    }
    tx.insert(sessionStats)
      .values(stats)
      .onConflictDoUpdate({ target: sessionStats.sessionId, set: stats })
      .run();
  });
  reconcileAnnotations(db, sessionId, derivedAnnotations);

  return {
    sessionId,
    deadBranchEvents: deadEventIds.size,
    toolCalls: calls.length,
    unmatchedToolCalls: calls.filter(({ status }) => status !== "completed" && status !== "error")
      .length,
    annotations: derivedAnnotations.length,
  };
}

export function deriveSessionAnnotations(db: Database, sessionId: string) {
  const { session, derivedEvents } = normalizedEvents(db, sessionId);
  const rows = annotationRows(db, session, derivedEvents);
  reconcileAnnotations(db, sessionId, rows);
  return rows.length;
}

export function deriveAllAnnotations(db: Database) {
  const sessionIds = db
    .selectDistinct({ sessionId: events.sessionId })
    .from(events)
    .orderBy(asc(events.sessionId))
    .all()
    .map(({ sessionId }) => sessionId);
  return sessionIds.map((sessionId) => ({
    sessionId,
    annotations: deriveSessionAnnotations(db, sessionId),
  }));
}

export function backfillAnnotations(db: Database) {
  const row = db.$client
    .prepare(
      `SELECT
         EXISTS(SELECT 1 FROM events LIMIT 1) AS hasEvents,
         EXISTS(SELECT 1 FROM annotations LIMIT 1) AS hasAnnotations`,
    )
    .get() as { hasEvents: number; hasAnnotations: number } | undefined;
  return row?.hasEvents === 1 && row.hasAnnotations === 0 ? deriveAllAnnotations(db) : [];
}

export function deriveAllSessions(db: Database) {
  const sessionIds = db
    .selectDistinct({ sessionId: events.sessionId })
    .from(events)
    .orderBy(asc(events.sessionId))
    .all()
    .map(({ sessionId }) => sessionId);
  return deriveSessions(db, sessionIds);
}

export function deriveStaleSessions(db: Database) {
  const sessionIds = (
    db.$client
      .prepare(
        `SELECT source.session_id AS sessionId
         FROM (
           SELECT
             session_id,
             max(coalesce(timestamp_ms, 0)) AS latest_event_at,
             max(case when is_meta = 0 then coalesce(timestamp_ms, 0) end) AS latest_non_meta_at
           FROM events
           GROUP BY session_id
         ) source
         LEFT JOIN session_stats stats ON stats.session_id = source.session_id
         WHERE stats.session_id IS NULL
            OR (
              stats.updated_at < source.latest_event_at
              AND (
                stats.updated_at > coalesce(stats.ended_at, stats.started_at, 0)
                OR coalesce(stats.ended_at, -1) < coalesce(source.latest_non_meta_at, -1)
              )
            )
         ORDER BY source.session_id`,
      )
      .all() as unknown as Array<{ sessionId: string }>
  ).map(({ sessionId }) => sessionId);
  const result =
    sessionIds.length === 0
      ? { usageDuplicates: 0, summaries: [] }
      : deriveSessions(db, sessionIds);
  db.$client
    .prepare(
      `UPDATE session_stats
       SET updated_at = (
         SELECT max(coalesce(events.timestamp_ms, 0))
         FROM events
         WHERE events.session_id = session_stats.session_id
       )
       WHERE updated_at < (
         SELECT max(coalesce(events.timestamp_ms, 0))
         FROM events
         WHERE events.session_id = session_stats.session_id
       )`,
    )
    .run();
  return result;
}

export function deriveSessions(
  db: Database,
  sessionIds: Iterable<string>,
  { refreshUsageDuplicates = true } = {},
) {
  const usageDuplicates = refreshUsageDuplicates ? markUsageDuplicates(db) : 0;
  const summaries = [...new Set(sessionIds)]
    .sort()
    .map((sessionId) => deriveSession(db, sessionId));
  return { usageDuplicates, summaries };
}
