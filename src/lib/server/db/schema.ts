import { defineRelations } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  numeric,
  snakeCase,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const compressionValues = ["none", "gzip", "zstd"] as const;
export const eventKindValues = [
  "user",
  "assistant",
  "system",
  "summary",
  "attachment",
  "file_history_snapshot",
  "permission_mode",
  "queue_operation",
  "unknown",
  "parse_error",
] as const;
export const toolCallStatusValues = [
  "pending",
  "completed",
  "error",
  "interrupted",
  "unmatched",
] as const;
export const annotationKindValues = ["skill", "scratchpad", "worktree", "unknown"] as const;

export const projects = snakeCase.table(
  "projects",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    path: text().notNull(),
    name: text().notNull(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (table) => [uniqueIndex("projects_path_unique").on(table.path)],
);

export const sessions = snakeCase.table(
  "sessions",
  {
    id: text().primaryKey(),
    sourceSessionId: text().notNull(),
    projectId: integer()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    parentId: text(),
    forkOf: text(),
    agentId: text(),
    cwd: text().notNull(),
    gitBranch: text(),
    claudeVersion: text(),
    startedAt: integer(),
    endedAt: integer(),
  },
  (table) => [
    foreignKey({
      columns: [table.parentId],
      foreignColumns: [table.id],
      name: "sessions_parent_id_sessions_id_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.forkOf],
      foreignColumns: [table.id],
      name: "sessions_fork_of_sessions_id_fk",
    }).onDelete("set null"),
    index("sessions_project_id_idx").on(table.projectId),
    index("sessions_source_session_id_idx").on(table.sourceSessionId),
    index("sessions_parent_id_idx").on(table.parentId),
  ],
);

export const files = snakeCase.table(
  "files",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    projectId: integer()
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sessionId: text().references(() => sessions.id, { onDelete: "set null" }),
    path: text().notNull(),
    mtimeMs: integer().notNull(),
    size: integer().notNull(),
    parsedOffset: integer().notNull().default(0),
    compression: text({ enum: compressionValues }).notNull().default("none"),
    lastIngestedAt: integer(),
  },
  (table) => [
    uniqueIndex("files_path_unique").on(table.path),
    index("files_project_id_idx").on(table.projectId),
    index("files_session_id_idx").on(table.sessionId),
  ],
);

export const events = snakeCase.table(
  "events",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    fileId: integer()
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    sessionId: text()
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    byteOffset: integer().notNull(),
    byteLength: integer().notNull(),
    uuid: text(),
    parentUuid: text(),
    timestampMs: integer(),
    kind: text({ enum: eventKindValues }).notNull(),
    type: text().notNull(),
    model: text(),
    inputTokens: integer().notNull().default(0),
    outputTokens: integer().notNull().default(0),
    cacheReadTokens: integer().notNull().default(0),
    cacheWriteTokens: integer().notNull().default(0),
    isSidechain: integer({ mode: "boolean" }).notNull().default(false),
    isDeadBranch: integer({ mode: "boolean" }).notNull().default(false),
    isMeta: integer({ mode: "boolean" }).notNull().default(false),
    isInterrupt: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("events_session_id_seq_unique").on(table.sessionId, table.seq),
    index("events_file_id_idx").on(table.fileId),
    index("events_session_id_timestamp_ms_idx").on(table.sessionId, table.timestampMs),
    index("events_session_id_uuid_idx").on(table.sessionId, table.uuid),
    index("events_session_id_parent_uuid_idx").on(table.sessionId, table.parentUuid),
  ],
);

export const toolCalls = snakeCase.table(
  "tool_calls",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    sessionId: text()
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    sourceEventId: integer()
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    resultEventId: integer().references(() => events.id, { onDelete: "set null" }),
    toolUseId: text().notNull(),
    name: text().notNull(),
    inputSummary: text(),
    targetPath: text(),
    startedAt: integer(),
    endedAt: integer(),
    durationMs: integer(),
    status: text({ enum: toolCallStatusValues }).notNull().default("pending"),
    isError: integer({ mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("tool_calls_session_id_tool_use_id_unique").on(table.sessionId, table.toolUseId),
    index("tool_calls_source_event_id_idx").on(table.sourceEventId),
    index("tool_calls_result_event_id_idx").on(table.resultEventId),
  ],
);

export const annotations = snakeCase.table(
  "annotations",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    sessionId: text()
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    eventId: integer().references(() => events.id, { onDelete: "cascade" }),
    kind: text({ enum: annotationKindValues }).notNull(),
    value: text().notNull(),
    createdAt: integer().notNull(),
  },
  (table) => [
    index("annotations_session_id_idx").on(table.sessionId),
    index("annotations_event_id_idx").on(table.eventId),
  ],
);

export const modelPricing = snakeCase.table(
  "model_pricing",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    model: text().notNull(),
    effectiveFrom: integer().notNull(),
    inputUsdPerMtok: numeric({ mode: "number" }).notNull(),
    outputUsdPerMtok: numeric({ mode: "number" }).notNull(),
    cacheReadUsdPerMtok: numeric({ mode: "number" }).notNull(),
    cacheWriteUsdPerMtok: numeric({ mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("model_pricing_model_effective_from_unique").on(table.model, table.effectiveFrom),
  ],
);

export const sessionStats = snakeCase.table("session_stats", {
  sessionId: text()
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  userTurns: integer().notNull().default(0),
  assistantTurns: integer().notNull().default(0),
  toolCalls: integer().notNull().default(0),
  startedAt: integer(),
  endedAt: integer(),
  durationMs: integer(),
  tokInput: integer().notNull().default(0),
  tokOutput: integer().notNull().default(0),
  tokCacheRead: integer().notNull().default(0),
  tokCacheWrite: integer().notNull().default(0),
  tokDeadBranch: integer().notNull().default(0),
  costUsd: numeric({ mode: "number" }).notNull().default(0),
  updatedAt: integer().notNull(),
});

export const schema = {
  projects,
  sessions,
  files,
  events,
  toolCalls,
  annotations,
  modelPricing,
  sessionStats,
};

export const relations = defineRelations(schema);
