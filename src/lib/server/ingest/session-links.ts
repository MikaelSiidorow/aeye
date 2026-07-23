import { closeSync, openSync, readSync } from "node:fs";

import { sql } from "drizzle-orm";

import type { Database } from "../db/database.ts";
import { sessionLinks } from "../db/schema.ts";

type LinkKind = (typeof sessionLinks.$inferInsert)["kind"];
type LinkMethod = (typeof sessionLinks.$inferInsert)["method"];

interface InvocationRow {
  toolCallId: number;
  sessionId: string;
  sourceEventId: number;
  startedAt: number | null;
  endedAt: number | null;
  cwd: string;
  sourcePath: string;
  sourceOffset: number;
  sourceLength: number;
  resultPath: string | null;
  resultOffset: number | null;
  resultLength: number | null;
}

interface CodexSessionRow {
  id: string;
  sourceSessionId: string;
  cwd: string;
  startedAt: number | null;
}

interface PluginCall {
  toolCallId: number;
  sessionId: string;
  sourceEventId: number;
  startedAt: number | null;
  endedAt: number | null;
  cwd: string;
  action: string;
  kind: LinkKind | null;
  jobIds: Set<string>;
  threadIds: Set<string>;
}

interface DerivedLink {
  sourceSessionId: string;
  targetSessionId: string;
  sourceEventId: number;
  kind: LinkKind;
  method: LinkMethod;
  createdAt: number;
}

export interface SessionLinkSummary {
  pluginCalls: number;
  links: number;
  threadIdLinks: number;
  jobIdLinks: number;
  timeWindowLinks: number;
}

const jobIdPattern = /\b(?:task|review)-[a-z0-9]+-[a-z0-9]+\b/gi;
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const timeWindowGraceMs = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSlice(path: string, offset: number, length: number) {
  const file = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(file, buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(file);
  }
}

function parseEvent(path: string | null, offset: number | null, length: number | null) {
  if (path === null || offset === null || length === null) return undefined;
  try {
    const value: unknown = JSON.parse(readSlice(path, offset, length));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function messageContent(event: Record<string, unknown> | undefined) {
  const message = event?.["message"];
  return isRecord(message) && Array.isArray(message["content"]) ? message["content"] : [];
}

function toolUseCommand(event: Record<string, unknown> | undefined, toolUseId: string) {
  for (const block of messageContent(event)) {
    if (!isRecord(block) || block["type"] !== "tool_use" || block["id"] !== toolUseId) continue;
    const input = block["input"];
    if (!isRecord(input)) return "";
    const command = input["command"];
    return typeof command === "string" ? command : "";
  }
  return "";
}

function toolResultText(event: Record<string, unknown> | undefined, toolUseId: string) {
  for (const block of messageContent(event)) {
    if (!isRecord(block) || block["type"] !== "tool_result" || block["tool_use_id"] !== toolUseId) {
      continue;
    }
    const content = block["content"];
    if (typeof content === "string") return content;
    return content === undefined ? "" : JSON.stringify(content);
  }
  return "";
}

function splitShellArguments(raw: string) {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const character of raw) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (escaping) current += "\\";
  if (current.length > 0) tokens.push(current);
  return tokens;
}

function pluginAction(command: string) {
  const tokens = splitShellArguments(command);
  const scriptIndex = tokens.findIndex(
    (token) => token === "scripts/codex-companion.mjs" || token.endsWith("/codex-companion.mjs"),
  );
  return scriptIndex === -1 ? undefined : tokens[scriptIndex + 1];
}

function linkKind(action: string): LinkKind | null {
  if (action === "task") return "delegate";
  if (action === "review" || action === "adversarial-review") return "review";
  if (action === "transfer") return "transfer";
  return null;
}

function matches(value: string, pattern: RegExp) {
  return new Set(value.match(pattern) ?? []);
}

function loadPluginCalls(db: Database, codexSessionIds: Map<string, string>) {
  const rows = db.$client
    .prepare(
      `SELECT
         tc.id AS toolCallId,
         tc.session_id AS sessionId,
         tc.tool_use_id AS toolUseId,
         tc.source_event_id AS sourceEventId,
         tc.started_at AS startedAt,
         tc.ended_at AS endedAt,
         s.cwd AS cwd,
         source_file.path AS sourcePath,
         source_event.byte_offset AS sourceOffset,
         source_event.byte_length AS sourceLength,
         result_file.path AS resultPath,
         result_event.byte_offset AS resultOffset,
         result_event.byte_length AS resultLength
       FROM tool_calls tc
       INNER JOIN sessions s ON s.id = tc.session_id
       INNER JOIN events source_event ON source_event.id = tc.source_event_id
       INNER JOIN files source_file ON source_file.id = source_event.file_id
       LEFT JOIN events result_event ON result_event.id = tc.result_event_id
       LEFT JOIN files result_file ON result_file.id = result_event.file_id
       WHERE s.source = 'claude' AND tc.name = 'Bash'
       ORDER BY tc.started_at, tc.id`,
    )
    .all() as unknown as (InvocationRow & { toolUseId: string })[];
  const calls: PluginCall[] = [];

  for (const row of rows) {
    const sourceEvent = parseEvent(row.sourcePath, row.sourceOffset, row.sourceLength);
    const command = toolUseCommand(sourceEvent, row.toolUseId);
    const action = pluginAction(command);
    if (action === undefined) continue;

    const resultEvent = parseEvent(row.resultPath, row.resultOffset, row.resultLength);
    const resultText = toolResultText(resultEvent, row.toolUseId);
    const kind = linkKind(action);
    const threadIds = new Set<string>();
    for (const sourceThreadId of matches(resultText, uuidPattern)) {
      const sessionId = codexSessionIds.get(sourceThreadId);
      if (sessionId !== undefined) threadIds.add(sessionId);
    }

    calls.push({
      toolCallId: row.toolCallId,
      sessionId: row.sessionId,
      sourceEventId: row.sourceEventId,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      cwd: row.cwd,
      action,
      kind,
      jobIds:
        kind === null
          ? new Set([...matches(command, jobIdPattern), ...matches(resultText, jobIdPattern)])
          : matches(resultText, jobIdPattern),
      threadIds,
    });
  }

  return calls;
}

function methodRank(method: LinkMethod) {
  if (method === "thread_id") return 0;
  if (method === "job_id") return 1;
  return 2;
}

function addLink(links: Map<string, DerivedLink>, link: DerivedLink) {
  const key = `${link.sourceSessionId}\0${link.targetSessionId}\0${link.kind}`;
  const existing = links.get(key);
  if (
    existing === undefined ||
    methodRank(link.method) < methodRank(existing.method) ||
    (link.method === existing.method && link.sourceEventId < existing.sourceEventId)
  ) {
    links.set(key, link);
  }
}

function linkFromCall(call: PluginCall, targetSessionId: string, method: LinkMethod) {
  return {
    sourceSessionId: call.sessionId,
    targetSessionId,
    sourceEventId: call.sourceEventId,
    kind: call.kind as LinkKind,
    method,
    createdAt: call.startedAt ?? 0,
  } satisfies DerivedLink;
}

export function deriveSessionLinks(db: Database): SessionLinkSummary {
  const codexSessions = db.$client
    .prepare(
      `SELECT id, source_session_id AS sourceSessionId, cwd, started_at AS startedAt
       FROM sessions
       WHERE source = 'codex' AND client_name = 'Claude Code'
       ORDER BY started_at, id`,
    )
    .all() as unknown as CodexSessionRow[];
  const codexSessionIds = new Map(
    codexSessions.map((session) => [session.sourceSessionId, session.id]),
  );
  const calls = loadPluginCalls(db, codexSessionIds);
  const sources = calls.filter((call) => call.kind !== null);
  const threadsByJob = new Map<string, Set<string>>();

  for (const call of calls) {
    for (const jobId of call.jobIds) {
      const jobKey = `${call.cwd}\0${jobId}`;
      const threadIds = threadsByJob.get(jobKey) ?? new Set<string>();
      for (const threadId of call.threadIds) threadIds.add(threadId);
      threadsByJob.set(jobKey, threadIds);
    }
  }

  const links = new Map<string, DerivedLink>();
  const matchedCalls = new Set<number>();
  const matchedTargets = new Set<string>();

  for (const call of sources) {
    const directTargets = call.threadIds;
    if (directTargets.size === 1) {
      const targetSessionId = [...directTargets][0] as string;
      addLink(links, linkFromCall(call, targetSessionId, "thread_id"));
      matchedCalls.add(call.toolCallId);
      matchedTargets.add(targetSessionId);
      continue;
    }

    const jobTargets = new Set<string>();
    for (const jobId of call.jobIds) {
      for (const threadId of threadsByJob.get(`${call.cwd}\0${jobId}`) ?? []) {
        jobTargets.add(threadId);
      }
    }
    if (jobTargets.size !== 1) continue;
    const targetSessionId = [...jobTargets][0] as string;
    addLink(links, linkFromCall(call, targetSessionId, "job_id"));
    matchedCalls.add(call.toolCallId);
    matchedTargets.add(targetSessionId);
  }

  const unmatchedCalls = sources.filter(
    (call) =>
      !matchedCalls.has(call.toolCallId) && call.startedAt !== null && call.kind !== "transfer",
  );
  const unmatchedTargets = codexSessions.filter(
    (session) => !matchedTargets.has(session.id) && session.startedAt !== null,
  );
  const targetsByCall = new Map<number, CodexSessionRow[]>();
  const callsByTarget = new Map<string, PluginCall[]>();

  for (const call of unmatchedCalls) {
    const latest = (call.endedAt ?? (call.startedAt as number)) + timeWindowGraceMs;
    const targets = unmatchedTargets.filter(
      (target) =>
        target.cwd === call.cwd &&
        (target.startedAt as number) >= (call.startedAt as number) &&
        (target.startedAt as number) <= latest,
    );
    targetsByCall.set(call.toolCallId, targets);
    for (const target of targets) {
      const targetCalls = callsByTarget.get(target.id) ?? [];
      targetCalls.push(call);
      callsByTarget.set(target.id, targetCalls);
    }
  }

  for (const call of unmatchedCalls) {
    const targets = targetsByCall.get(call.toolCallId) ?? [];
    if (targets.length !== 1) continue;
    const target = targets[0] as CodexSessionRow;
    if (callsByTarget.get(target.id)?.length !== 1) continue;
    addLink(links, linkFromCall(call, target.id, "time_window"));
  }

  const orderedLinks = [...links.values()].sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.sourceSessionId.localeCompare(right.sourceSessionId) ||
      left.targetSessionId.localeCompare(right.targetSessionId),
  );
  db.transaction((tx) => {
    tx.delete(sessionLinks).run();
    tx.run(sql.raw("DELETE FROM sqlite_sequence WHERE name = 'session_links'"));
    if (orderedLinks.length > 0) tx.insert(sessionLinks).values(orderedLinks).run();
  });

  return {
    pluginCalls: calls.length,
    links: orderedLinks.length,
    threadIdLinks: orderedLinks.filter(({ method }) => method === "thread_id").length,
    jobIdLinks: orderedLinks.filter(({ method }) => method === "job_id").length,
    timeWindowLinks: orderedLinks.filter(({ method }) => method === "time_window").length,
  };
}
