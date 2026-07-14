type JsonRecord = Record<string, unknown>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ContentSummary {
  format: "string" | "blocks" | "missing" | "invalid";
  blockCount: number;
}

export interface NormalizedToolUse {
  toolUseId: string;
  name: string;
  inputSummary: string;
  targetPath: string | undefined;
}

export interface NormalizedToolResult {
  toolUseId: string;
  isError: boolean;
}

interface NormalizedEventBase {
  sessionId: string | undefined;
  uuid: string | undefined;
  parentUuid: string | undefined;
  timestampMs: number | undefined;
  cwd: string | undefined;
  gitBranch: string | undefined;
  version: string | undefined;
  model: string | undefined;
  isSidechain: boolean;
  isMeta: boolean;
  isInterrupt: boolean;
  usage: TokenUsage;
  content: ContentSummary;
  toolUses: NormalizedToolUse[];
  toolResults: NormalizedToolResult[];
}

export interface NormalizedUserEvent extends NormalizedEventBase {
  kind: "user";
  type: "user";
  role: "user";
}

export interface NormalizedAssistantEvent extends NormalizedEventBase {
  kind: "assistant";
  type: "assistant";
  role: "assistant";
  stopReason: string | undefined;
}

export interface NormalizedSystemEvent extends NormalizedEventBase {
  kind: "system";
  type: "system";
  subtype: string | undefined;
}

export interface NormalizedSummaryEvent extends NormalizedEventBase {
  kind: "summary";
  type: "summary";
  leafUuid: string | undefined;
}

export interface NormalizedAttachmentEvent extends NormalizedEventBase {
  kind: "attachment";
  type: "attachment";
}

export interface NormalizedFileHistorySnapshotEvent extends NormalizedEventBase {
  kind: "file_history_snapshot";
  type: "file-history-snapshot";
}

export interface NormalizedPermissionModeEvent extends NormalizedEventBase {
  kind: "permission_mode";
  type: "permission-mode";
  permissionMode: string | undefined;
}

export interface NormalizedQueueOperationEvent extends NormalizedEventBase {
  kind: "queue_operation";
  type: "queue-operation";
  operation: string | undefined;
}

export interface NormalizedUnknownEvent extends NormalizedEventBase {
  kind: "unknown";
  type: string;
}

export interface NormalizedParseErrorEvent extends NormalizedEventBase {
  kind: "parse_error";
  type: "parse_error";
  parseError: "invalid_json" | "not_object" | "missing_type";
}

export type NormalizedEvent =
  | NormalizedUserEvent
  | NormalizedAssistantEvent
  | NormalizedSystemEvent
  | NormalizedSummaryEvent
  | NormalizedAttachmentEvent
  | NormalizedFileHistorySnapshotEvent
  | NormalizedPermissionModeEvent
  | NormalizedQueueOperationEvent
  | NormalizedUnknownEvent
  | NormalizedParseErrorEvent;

export const triagedUnknownTypeValues = [
  "agent-name",
  "ai-title",
  "custom-title",
  "last-prompt",
  "mode",
];

const metaTypes = new Set([
  ...triagedUnknownTypeValues,
  "attachment",
  "file-history-snapshot",
  "permission-mode",
  "queue-operation",
  "summary",
]);
const targetPathKeys = ["file_path", "path", "notebook_path", "target_path", "cwd"];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: JsonRecord, key: string) {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function integerField(value: JsonRecord, key: string) {
  const field = value[key];
  return typeof field === "number" && Number.isSafeInteger(field) && field >= 0 ? field : 0;
}

function messageRecord(value: JsonRecord) {
  const message = value["message"];
  return isRecord(message) ? message : undefined;
}

function contentValue(value: JsonRecord) {
  return messageRecord(value)?.["content"] ?? value["content"];
}

function summarizeContent(value: unknown): ContentSummary {
  if (typeof value === "string") return { format: "string", blockCount: 0 };
  if (Array.isArray(value)) return { format: "blocks", blockCount: value.length };
  if (value === undefined) return { format: "missing", blockCount: 0 };
  return { format: "invalid", blockCount: 0 };
}

function timestampMs(value: JsonRecord) {
  const timestamp = value["timestamp"];
  if (typeof timestamp === "number" && Number.isSafeInteger(timestamp)) return timestamp;
  if (typeof timestamp !== "string") return undefined;

  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function tokenUsage(value: JsonRecord): TokenUsage {
  const usage = messageRecord(value)?.["usage"];
  if (!isRecord(usage)) {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  }

  let cacheWriteTokens = integerField(usage, "cache_creation_input_tokens");
  if (cacheWriteTokens === 0 && isRecord(usage["cache_creation"])) {
    cacheWriteTokens =
      integerField(usage["cache_creation"], "ephemeral_5m_input_tokens") +
      integerField(usage["cache_creation"], "ephemeral_1h_input_tokens");
  }

  return {
    inputTokens: integerField(usage, "input_tokens"),
    outputTokens: integerField(usage, "output_tokens"),
    cacheReadTokens: integerField(usage, "cache_read_input_tokens"),
    cacheWriteTokens,
  };
}

function inputValueSummary(key: string, value: unknown) {
  if (targetPathKeys.includes(key) && typeof value === "string") return `${key}: path`;
  if (typeof value === "string") return `${key}: string(${Buffer.byteLength(value)} bytes)`;
  if (typeof value === "number") return `${key}: number`;
  if (typeof value === "boolean") return `${key}: boolean`;
  if (Array.isArray(value)) return `${key}: array(${value.length})`;
  if (isRecord(value)) return `${key}: object(${Object.keys(value).length})`;
  if (value === null) return `${key}: null`;
  return `${key}: ${typeof value}`;
}

export function summarizeToolInput(input: unknown) {
  if (!isRecord(input)) return `input: ${input === null ? "null" : typeof input}`;

  const entries = Object.entries(input).sort(([left], [right]) => left.localeCompare(right));
  const visible = entries.slice(0, 12).map(([key, value]) => inputValueSummary(key, value));
  if (entries.length > visible.length)
    visible.push(`additional keys: ${entries.length - visible.length}`);
  return visible.length === 0 ? "empty input" : visible.join(", ");
}

export function extractTargetPath(input: unknown) {
  if (!isRecord(input)) return undefined;

  for (const key of targetPathKeys) {
    const value = input[key];
    if (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 4096 &&
      !value.includes("\n")
    ) {
      return value;
    }
  }

  return undefined;
}

function extractTools(value: JsonRecord) {
  const content = messageRecord(value)?.["content"];
  const toolUses: NormalizedToolUse[] = [];
  const toolResults: NormalizedToolResult[] = [];
  if (!Array.isArray(content)) return { toolUses, toolResults };

  for (const block of content) {
    if (!isRecord(block)) continue;

    if (block["type"] === "tool_use") {
      const toolUseId = stringField(block, "id");
      const name = stringField(block, "name");
      if (toolUseId === undefined || name === undefined) continue;

      toolUses.push({
        toolUseId,
        name,
        inputSummary: summarizeToolInput(block["input"]),
        targetPath: extractTargetPath(block["input"]),
      });
    }

    if (block["type"] === "tool_result") {
      const toolUseId = stringField(block, "tool_use_id");
      if (toolUseId === undefined) continue;
      toolResults.push({ toolUseId, isError: block["is_error"] === true });
    }
  }

  return { toolUses, toolResults };
}

function hasInterruptMarker(value: unknown): boolean {
  if (typeof value === "string") {
    return /^\[request interrupted by user(?:[^\]]*)\]$/i.test(value.trim());
  }
  if (!Array.isArray(value)) return false;

  return value.some((block) => {
    if (!isRecord(block) || block["type"] === "tool_use") return false;
    return hasInterruptMarker(block["text"] ?? block["content"]);
  });
}

function baseEvent(value: JsonRecord, rawType: string): NormalizedEventBase {
  const message = messageRecord(value);
  const tools = extractTools(value);
  const stopReason =
    stringField(value, "stopReason") ??
    (message === undefined ? undefined : stringField(message, "stop_reason"));

  return {
    sessionId: stringField(value, "sessionId") ?? stringField(value, "session_id"),
    uuid: stringField(value, "uuid"),
    parentUuid: stringField(value, "parentUuid"),
    timestampMs: timestampMs(value),
    cwd: stringField(value, "cwd"),
    gitBranch: stringField(value, "gitBranch"),
    version: stringField(value, "version"),
    model: message === undefined ? undefined : stringField(message, "model"),
    isSidechain: value["isSidechain"] === true,
    isMeta: value["isMeta"] === true || metaTypes.has(rawType),
    isInterrupt:
      value["isInterrupted"] === true ||
      value["interrupted"] === true ||
      stringField(value, "interruptedMessageId") !== undefined ||
      stopReason?.toLowerCase().includes("interrupt") === true ||
      hasInterruptMarker(contentValue(value)),
    usage: tokenUsage(value),
    content: summarizeContent(contentValue(value)),
    ...tools,
  };
}

function parseError(
  parseError: NormalizedParseErrorEvent["parseError"],
): NormalizedParseErrorEvent {
  return {
    kind: "parse_error",
    type: "parse_error",
    parseError,
    ...baseEvent({}, "parse_error"),
  };
}

export function parseClaudeCodeEvent(line: string): NormalizedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return parseError("invalid_json");
  }

  if (!isRecord(parsed)) return parseError("not_object");
  const rawType = stringField(parsed, "type");
  if (rawType === undefined) return parseError("missing_type");

  const base = baseEvent(parsed, rawType);
  switch (rawType) {
    case "user":
      return { kind: "user", type: "user", role: "user", ...base };
    case "assistant":
      return {
        kind: "assistant",
        type: "assistant",
        role: "assistant",
        stopReason: stringField(messageRecord(parsed) ?? {}, "stop_reason"),
        ...base,
      };
    case "system":
      return { kind: "system", type: "system", subtype: stringField(parsed, "subtype"), ...base };
    case "summary":
      return {
        kind: "summary",
        type: "summary",
        leafUuid: stringField(parsed, "leafUuid"),
        ...base,
      };
    case "attachment":
      return { kind: "attachment", type: "attachment", ...base };
    case "file-history-snapshot":
      return { kind: "file_history_snapshot", type: "file-history-snapshot", ...base };
    case "permission-mode":
      return {
        kind: "permission_mode",
        type: "permission-mode",
        permissionMode: stringField(parsed, "permissionMode"),
        ...base,
      };
    case "queue-operation":
      return {
        kind: "queue_operation",
        type: "queue-operation",
        operation: stringField(parsed, "operation"),
        ...base,
      };
    default:
      return { kind: "unknown", type: rawType, ...base };
  }
}
