import { readFileSync } from "node:fs";

import { asc, eq, inArray } from "drizzle-orm";

import type { Database } from "../db/database.ts";
import { events, files, modelPricing, sessionStats, toolCalls } from "../db/schema.ts";
import {
  parseClaudeCodeEvent,
  type NormalizedEvent,
  type NormalizedToolUse,
} from "./claude-code.ts";

type EventRow = typeof events.$inferSelect;
type ToolCallInsert = typeof toolCalls.$inferInsert;

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
  const calls: ToolCallInsert[] = [];
  let latestInterruptSeq = -1;

  for (const event of derivedEvents) {
    if (event.normalized.isInterrupt) latestInterruptSeq = event.row.seq;
    for (const tool of event.normalized.toolUses) {
      if (!pending.has(tool.toolUseId)) pending.set(tool.toolUseId, { source: event, tool });
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

  for (const { row, normalized } of derivedEvents) {
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
    updatedAt: endedAt ?? startedAt ?? 0,
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
  const rows = db
    .select()
    .from(events)
    .where(eq(events.sessionId, sessionId))
    .orderBy(asc(events.seq))
    .all();
  const sourceFiles = new Map(
    db
      .select()
      .from(files)
      .all()
      .map((file) => [file.id, file]),
  );
  const buffers = new Map<number, Buffer>();

  return rows.map((row) => {
    const file = sourceFiles.get(row.fileId);
    if (file === undefined) throw new Error(`Missing source file ${row.fileId}`);
    if (file.compression !== "none") {
      throw new Error(`Unsupported source compression: ${file.compression}`);
    }
    let buffer = buffers.get(file.id);
    if (buffer === undefined) {
      buffer = readFileSync(file.path);
      buffers.set(file.id, buffer);
    }
    const line = buffer.subarray(row.byteOffset, row.byteOffset + row.byteLength).toString("utf8");
    return { row, normalized: parseClaudeCodeEvent(line) } satisfies DerivedEvent;
  });
}

export function deriveSession(db: Database, sessionId: string): DerivationSummary {
  const derivedEvents = normalizedEvents(db, sessionId);
  const deadEventIds = findDeadBranchEvents(derivedEvents);
  const { calls, activeCount } = toolCallRows(derivedEvents, deadEventIds);
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

  return {
    sessionId,
    deadBranchEvents: deadEventIds.size,
    toolCalls: calls.length,
    unmatchedToolCalls: calls.filter(({ status }) => status !== "completed" && status !== "error")
      .length,
  };
}

export function deriveAllSessions(db: Database) {
  const usageDuplicates = markUsageDuplicates(db);
  const sessionIds = db
    .selectDistinct({ sessionId: events.sessionId })
    .from(events)
    .orderBy(asc(events.sessionId))
    .all()
    .map(({ sessionId }) => sessionId);
  const summaries = sessionIds.map((sessionId) => deriveSession(db, sessionId));
  return { usageDuplicates, summaries };
}
