import {
  and,
  asc,
  countDistinct,
  desc,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
  type SQL,
} from "drizzle-orm";

import type { Database } from "./db/database.ts";
import {
  activeToolCalls,
  activeUsageEvents,
  annotations,
  events,
  projects,
  sessionLinks,
  sessionReadModel,
} from "./db/schema.ts";

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  deadBranch: number;
}

export interface Overview {
  projectCount: number;
  sessionCount: number;
  rootSessionCount: number;
  subagentSessionCount: number;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  startedAt: number | null;
  endedAt: number | null;
  tokens: TokenTotals;
  costUsd: number;
}

export interface ProjectSummary extends Omit<Overview, "projectCount"> {
  id: number;
  name: string;
  path: string;
}

export interface SessionSummary {
  id: string;
  sourceSessionId: string;
  projectId: number;
  projectName: string;
  projectPath: string;
  parentId: string | null;
  forkOf: string | null;
  agentId: string | null;
  source: "claude" | "codex";
  clientName: string | null;
  clientVersion: string | null;
  cwd: string;
  gitBranch: string | null;
  claudeVersion: string | null;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  startedAt: number | null;
  endedAt: number | null;
  durationMs: number | null;
  tokens: TokenTotals;
  costUsd: number;
  updatedAt: number;
}

export interface DailyUsage {
  date: string;
  tokens: Omit<TokenTotals, "deadBranch">;
}

export interface ModelUsage {
  model: string;
  sessionCount: number;
  tokens: Omit<TokenTotals, "deadBranch">;
}

export interface ToolUsage {
  name: string;
  calls: number;
  completed: number;
  errors: number;
  interrupted: number;
  unmatched: number;
  pending: number;
  durationSamples: number;
  averageDurationMs: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
}

export interface SessionGraphNode {
  eventId: number;
  seq: number;
  uuid: string | null;
  parentUuid: string | null;
  timestampMs: number | null;
  kind: (typeof events.$inferSelect)["kind"];
  type: string;
  model: string | null;
  totalTokens: number;
  isSidechain: boolean;
  isUsageDuplicate: boolean;
  isDeadBranch: boolean;
  isMeta: boolean;
  isInterrupt: boolean;
}

export interface SessionGraphEdge {
  sourceEventId: number;
  targetEventId: number;
}

export interface SessionGraph {
  nodes: SessionGraphNode[];
  edges: SessionGraphEdge[];
}

export interface SessionLink {
  id: number;
  direction: "outgoing" | "incoming";
  kind: (typeof sessionLinks.$inferSelect)["kind"];
  method: (typeof sessionLinks.$inferSelect)["method"];
  sourceEventId: number | null;
  related: SessionSummary;
}

export interface SessionAnnotation {
  id: number;
  eventId: number | null;
  kind: (typeof annotations.$inferSelect)["kind"];
  value: string;
  createdAt: number;
}

export interface SessionDetail {
  summary: SessionSummary;
  annotations: SessionAnnotation[];
  links: SessionLink[];
  models: ModelUsage[];
  tools: ToolUsage[];
  graph: SessionGraph;
}

export interface SessionListOptions {
  projectId?: number | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface BreakdownOptions {
  projectId?: number | undefined;
  sessionId?: string | undefined;
}

export interface DailyUsageOptions extends BreakdownOptions {
  timeZone?: string | undefined;
}

function tokens(
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
  deadBranch = 0,
): TokenTotals {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    deadBranch,
  };
}

function activeTokens(input: number, output: number, cacheRead: number, cacheWrite: number) {
  const { deadBranch: _deadBranch, ...active } = tokens(input, output, cacheRead, cacheWrite);
  return active;
}

function earliest(left: number | null, right: number | null) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function latest(left: number | null, right: number | null) {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function finiteInteger(value: number, name: string, minimum: number) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
  return value;
}

function optionalProjectId(projectId: number | undefined) {
  return projectId === undefined ? undefined : finiteInteger(projectId, "projectId", 1);
}

function breakdownCondition({ projectId, sessionId }: BreakdownOptions): SQL | undefined {
  const conditions = [];
  const validProjectId = optionalProjectId(projectId);
  if (validProjectId !== undefined)
    conditions.push(eq(activeUsageEvents.projectId, validProjectId));
  if (sessionId !== undefined) {
    if (sessionId.length === 0) throw new RangeError("sessionId must not be empty");
    conditions.push(eq(activeUsageEvents.sessionId, sessionId));
  }
  return and(...conditions);
}

function toolCondition({ projectId, sessionId }: BreakdownOptions): SQL | undefined {
  const conditions = [];
  const validProjectId = optionalProjectId(projectId);
  if (validProjectId !== undefined) conditions.push(eq(activeToolCalls.projectId, validProjectId));
  if (sessionId !== undefined) {
    if (sessionId.length === 0) throw new RangeError("sessionId must not be empty");
    conditions.push(eq(activeToolCalls.sessionId, sessionId));
  }
  return and(...conditions);
}

function dateFormatter(timeZone: string) {
  return new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function dateKey(formatter: Intl.DateTimeFormat, timestampMs: number) {
  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestampMs))
      .filter(({ type }) => type !== "literal")
      .map(({ type, value }) => [type, value]),
  );
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}`;
}

type SessionRow = typeof sessionReadModel.$inferSelect;

function sessionSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    sourceSessionId: row.sourceSessionId,
    projectId: row.projectId,
    projectName: row.projectName,
    projectPath: row.projectPath,
    parentId: row.parentId,
    forkOf: row.forkOf,
    agentId: row.agentId,
    source: row.source,
    clientName: row.clientName,
    clientVersion: row.clientVersion,
    cwd: row.cwd,
    gitBranch: row.gitBranch,
    claudeVersion: row.claudeVersion,
    userTurns: row.userTurns,
    assistantTurns: row.assistantTurns,
    toolCalls: row.toolCalls,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationMs: row.durationMs,
    tokens: tokens(
      row.tokInput,
      row.tokOutput,
      row.tokCacheRead,
      row.tokCacheWrite,
      row.tokDeadBranch,
    ),
    costUsd: row.costUsd,
    updatedAt: row.updatedAt,
  };
}

export class AeyeReadModel {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  listProjects(): ProjectSummary[] {
    const rows = this.#db
      .select({
        id: projects.id,
        name: projects.name,
        path: projects.path,
        sessionCount: sql<number>`count(${sessionReadModel.id})`.mapWith(Number),
        rootSessionCount:
          sql<number>`coalesce(sum(case when ${sessionReadModel.id} is not null and ${sessionReadModel.agentId} is null then 1 else 0 end), 0)`.mapWith(
            Number,
          ),
        subagentSessionCount:
          sql<number>`coalesce(sum(case when ${sessionReadModel.agentId} is not null then 1 else 0 end), 0)`.mapWith(
            Number,
          ),
        userTurns: sql<number>`coalesce(sum(${sessionReadModel.userTurns}), 0)`.mapWith(Number),
        assistantTurns: sql<number>`coalesce(sum(${sessionReadModel.assistantTurns}), 0)`.mapWith(
          Number,
        ),
        toolCalls: sql<number>`coalesce(sum(${sessionReadModel.toolCalls}), 0)`.mapWith(Number),
        startedAt: sql<number | null>`min(${sessionReadModel.startedAt})`,
        endedAt: sql<number | null>`max(${sessionReadModel.endedAt})`,
        tokInput: sql<number>`coalesce(sum(${sessionReadModel.tokInput}), 0)`.mapWith(Number),
        tokOutput: sql<number>`coalesce(sum(${sessionReadModel.tokOutput}), 0)`.mapWith(Number),
        tokCacheRead: sql<number>`coalesce(sum(${sessionReadModel.tokCacheRead}), 0)`.mapWith(
          Number,
        ),
        tokCacheWrite: sql<number>`coalesce(sum(${sessionReadModel.tokCacheWrite}), 0)`.mapWith(
          Number,
        ),
        tokDeadBranch: sql<number>`coalesce(sum(${sessionReadModel.tokDeadBranch}), 0)`.mapWith(
          Number,
        ),
        costUsd: sql<number>`coalesce(sum(${sessionReadModel.costUsd}), 0)`.mapWith(Number),
      })
      .from(projects)
      .leftJoin(sessionReadModel, eq(projects.id, sessionReadModel.projectId))
      .groupBy(projects.id)
      .orderBy(desc(sql`coalesce(max(${sessionReadModel.endedAt}), 0)`), asc(projects.name))
      .all();

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      path: row.path,
      sessionCount: row.sessionCount,
      rootSessionCount: row.rootSessionCount,
      subagentSessionCount: row.subagentSessionCount,
      userTurns: row.userTurns,
      assistantTurns: row.assistantTurns,
      toolCalls: row.toolCalls,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      tokens: tokens(
        row.tokInput,
        row.tokOutput,
        row.tokCacheRead,
        row.tokCacheWrite,
        row.tokDeadBranch,
      ),
      costUsd: row.costUsd,
    }));
  }

  overview(): Overview {
    const projectRows = this.listProjects();
    const summary = projectRows.reduce<Overview>(
      (result, project) => {
        result.sessionCount += project.sessionCount;
        result.rootSessionCount += project.rootSessionCount;
        result.subagentSessionCount += project.subagentSessionCount;
        result.userTurns += project.userTurns;
        result.assistantTurns += project.assistantTurns;
        result.toolCalls += project.toolCalls;
        result.startedAt = earliest(result.startedAt, project.startedAt);
        result.endedAt = latest(result.endedAt, project.endedAt);
        result.tokens.input += project.tokens.input;
        result.tokens.output += project.tokens.output;
        result.tokens.cacheRead += project.tokens.cacheRead;
        result.tokens.cacheWrite += project.tokens.cacheWrite;
        result.tokens.total += project.tokens.total;
        result.tokens.deadBranch += project.tokens.deadBranch;
        result.costUsd += project.costUsd;
        return result;
      },
      {
        projectCount: projectRows.length,
        sessionCount: 0,
        rootSessionCount: 0,
        subagentSessionCount: 0,
        userTurns: 0,
        assistantTurns: 0,
        toolCalls: 0,
        startedAt: null,
        endedAt: null,
        tokens: tokens(0, 0, 0, 0),
        costUsd: 0,
      } satisfies Overview,
    );
    return summary;
  }

  listSessions({ projectId, limit = 100, offset = 0 }: SessionListOptions = {}) {
    const validProjectId = optionalProjectId(projectId);
    const validLimit = finiteInteger(limit, "limit", 1);
    const validOffset = finiteInteger(offset, "offset", 0);
    if (validLimit > 500) throw new RangeError("limit must not exceed 500");

    return this.#db
      .select()
      .from(sessionReadModel)
      .where(
        validProjectId === undefined ? undefined : eq(sessionReadModel.projectId, validProjectId),
      )
      .orderBy(
        desc(sql`coalesce(${sessionReadModel.endedAt}, ${sessionReadModel.startedAt}, 0)`),
        asc(sessionReadModel.id),
      )
      .limit(validLimit)
      .offset(validOffset)
      .all()
      .map(sessionSummary);
  }

  usageByDay({ projectId, sessionId, timeZone = "UTC" }: DailyUsageOptions = {}): DailyUsage[] {
    const formatter = dateFormatter(timeZone);
    const rows = this.#db
      .select({
        timestampMs: activeUsageEvents.timestampMs,
        inputTokens: activeUsageEvents.inputTokens,
        outputTokens: activeUsageEvents.outputTokens,
        cacheReadTokens: activeUsageEvents.cacheReadTokens,
        cacheWriteTokens: activeUsageEvents.cacheWriteTokens,
      })
      .from(activeUsageEvents)
      .where(
        and(breakdownCondition({ projectId, sessionId }), isNotNull(activeUsageEvents.timestampMs)),
      )
      .orderBy(asc(activeUsageEvents.timestampMs))
      .all();
    const daily = new Map<string, ReturnType<typeof activeTokens>>();

    for (const row of rows) {
      if (row.timestampMs === null) continue;
      const date = dateKey(formatter, row.timestampMs);
      const current = daily.get(date) ?? activeTokens(0, 0, 0, 0);
      current.input += row.inputTokens;
      current.output += row.outputTokens;
      current.cacheRead += row.cacheReadTokens;
      current.cacheWrite += row.cacheWriteTokens;
      current.total +=
        row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens;
      daily.set(date, current);
    }

    return [...daily].map(([date, tokenTotals]) => ({ date, tokens: tokenTotals }));
  }

  usageByModel(options: BreakdownOptions = {}): ModelUsage[] {
    const model = sql<string>`coalesce(${activeUsageEvents.model}, 'unknown')`;
    return this.#db
      .select({
        model,
        sessionCount: countDistinct(activeUsageEvents.sessionId).mapWith(Number),
        tokInput: sql<number>`sum(${activeUsageEvents.inputTokens})`.mapWith(Number),
        tokOutput: sql<number>`sum(${activeUsageEvents.outputTokens})`.mapWith(Number),
        tokCacheRead: sql<number>`sum(${activeUsageEvents.cacheReadTokens})`.mapWith(Number),
        tokCacheWrite: sql<number>`sum(${activeUsageEvents.cacheWriteTokens})`.mapWith(Number),
      })
      .from(activeUsageEvents)
      .where(breakdownCondition(options))
      .groupBy(activeUsageEvents.model)
      .orderBy(
        desc(
          sql`sum(${activeUsageEvents.inputTokens} + ${activeUsageEvents.outputTokens} + ${activeUsageEvents.cacheReadTokens} + ${activeUsageEvents.cacheWriteTokens})`,
        ),
        asc(model),
      )
      .all()
      .map((row) => ({
        model: row.model,
        sessionCount: row.sessionCount,
        tokens: activeTokens(row.tokInput, row.tokOutput, row.tokCacheRead, row.tokCacheWrite),
      }));
  }

  toolUsage(options: BreakdownOptions = {}): ToolUsage[] {
    return this.#db
      .select({
        name: activeToolCalls.name,
        calls: sql<number>`count(*)`.mapWith(Number),
        completed:
          sql<number>`sum(case when ${activeToolCalls.status} = 'completed' then 1 else 0 end)`.mapWith(
            Number,
          ),
        errors:
          sql<number>`sum(case when ${activeToolCalls.status} = 'error' then 1 else 0 end)`.mapWith(
            Number,
          ),
        interrupted:
          sql<number>`sum(case when ${activeToolCalls.status} = 'interrupted' then 1 else 0 end)`.mapWith(
            Number,
          ),
        unmatched:
          sql<number>`sum(case when ${activeToolCalls.status} = 'unmatched' then 1 else 0 end)`.mapWith(
            Number,
          ),
        pending:
          sql<number>`sum(case when ${activeToolCalls.status} = 'pending' then 1 else 0 end)`.mapWith(
            Number,
          ),
        durationSamples: sql<number>`count(${activeToolCalls.durationMs})`.mapWith(Number),
        averageDurationMs: sql<number | null>`avg(${activeToolCalls.durationMs})`,
        p50DurationMs: sql<number | null>`percentile_cont(${activeToolCalls.durationMs}, 0.5)`,
        p95DurationMs: sql<number | null>`percentile_cont(${activeToolCalls.durationMs}, 0.95)`,
      })
      .from(activeToolCalls)
      .where(toolCondition(options))
      .groupBy(activeToolCalls.name)
      .orderBy(desc(sql`count(*)`), asc(activeToolCalls.name))
      .all();
  }

  getSessionGraph(sessionId: string): SessionGraph {
    if (sessionId.length === 0) throw new RangeError("sessionId must not be empty");
    const rows = this.#db
      .select({
        eventId: events.id,
        seq: events.seq,
        uuid: events.uuid,
        parentUuid: events.parentUuid,
        timestampMs: events.timestampMs,
        kind: events.kind,
        type: events.type,
        model: events.model,
        inputTokens: events.inputTokens,
        outputTokens: events.outputTokens,
        cacheReadTokens: events.cacheReadTokens,
        cacheWriteTokens: events.cacheWriteTokens,
        isSidechain: events.isSidechain,
        isUsageDuplicate: events.isUsageDuplicate,
        isDeadBranch: events.isDeadBranch,
        isMeta: events.isMeta,
        isInterrupt: events.isInterrupt,
      })
      .from(events)
      .where(eq(events.sessionId, sessionId))
      .orderBy(asc(events.seq))
      .all();
    const nodes = rows.map(
      ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, ...row }) => ({
        ...row,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      }),
    );
    const byUuid = new Map(
      nodes.flatMap((node) => (node.uuid === null ? [] : [[node.uuid, node.eventId] as const])),
    );
    const edges = nodes.flatMap((node) => {
      if (node.parentUuid === null) return [];
      const sourceEventId = byUuid.get(node.parentUuid);
      return sourceEventId === undefined ? [] : [{ sourceEventId, targetEventId: node.eventId }];
    });
    return { nodes, edges };
  }

  getSessionLinks(sessionId: string): SessionLink[] {
    if (sessionId.length === 0) throw new RangeError("sessionId must not be empty");
    const links = this.#db
      .select()
      .from(sessionLinks)
      .where(
        or(
          eq(sessionLinks.sourceSessionId, sessionId),
          eq(sessionLinks.targetSessionId, sessionId),
        ),
      )
      .orderBy(asc(sessionLinks.createdAt), asc(sessionLinks.id))
      .all();
    const relatedIds = [
      ...new Set(
        links.map((link) =>
          link.sourceSessionId === sessionId ? link.targetSessionId : link.sourceSessionId,
        ),
      ),
    ];
    if (relatedIds.length === 0) return [];

    const relatedById = new Map(
      this.#db
        .select()
        .from(sessionReadModel)
        .where(inArray(sessionReadModel.id, relatedIds))
        .all()
        .map((row) => [row.id, sessionSummary(row)]),
    );

    return links.flatMap((link) => {
      const outgoing = link.sourceSessionId === sessionId;
      const related = relatedById.get(outgoing ? link.targetSessionId : link.sourceSessionId);
      if (related === undefined) return [];
      return [
        {
          id: link.id,
          direction: outgoing ? "outgoing" : "incoming",
          kind: link.kind,
          method: link.method,
          sourceEventId: link.sourceEventId,
          related,
        } satisfies SessionLink,
      ];
    });
  }

  getSessionAnnotations(sessionId: string): SessionAnnotation[] {
    if (sessionId.length === 0) throw new RangeError("sessionId must not be empty");
    return this.#db
      .select({
        id: annotations.id,
        eventId: annotations.eventId,
        kind: annotations.kind,
        value: annotations.value,
        createdAt: annotations.createdAt,
      })
      .from(annotations)
      .where(eq(annotations.sessionId, sessionId))
      .orderBy(asc(annotations.createdAt), asc(annotations.id))
      .all();
  }

  getSession(sessionId: string): SessionDetail | null {
    if (sessionId.length === 0) throw new RangeError("sessionId must not be empty");
    const row = this.#db
      .select()
      .from(sessionReadModel)
      .where(eq(sessionReadModel.id, sessionId))
      .limit(1)
      .get();
    if (row === undefined) return null;

    return {
      summary: sessionSummary(row),
      annotations: this.getSessionAnnotations(sessionId),
      links: this.getSessionLinks(sessionId),
      models: this.usageByModel({ sessionId }),
      tools: this.toolUsage({ sessionId }),
      graph: this.getSessionGraph(sessionId),
    };
  }
}
