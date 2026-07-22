import {
  extractTargetPath,
  summarizeToolInput,
  type ContentSummary,
  type NormalizedEvent,
  type NormalizedToolResult,
  type NormalizedToolUse,
  type TokenUsage,
} from "./claude-code.ts";

type JsonRecord = Record<string, unknown>;

const emptyUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
} satisfies TokenUsage;

const missingContent = {
  format: "missing",
  blockCount: 0,
} satisfies ContentSummary;

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

function timestampMs(value: JsonRecord) {
  const timestamp = value["timestamp"];
  if (typeof timestamp === "number" && Number.isSafeInteger(timestamp)) return timestamp;
  if (typeof timestamp !== "string") return undefined;
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function contentSummary(value: unknown): ContentSummary {
  if (typeof value === "string") return { format: "string", blockCount: 0 };
  if (Array.isArray(value)) return { format: "blocks", blockCount: value.length };
  return value === undefined ? missingContent : { format: "invalid", blockCount: 0 };
}

function usageFromTokenCount(payload: JsonRecord): TokenUsage {
  const info = payload["info"];
  if (!isRecord(info) || !isRecord(info["last_token_usage"])) return emptyUsage;
  const usage = info["last_token_usage"];
  const totalInput = integerField(usage, "input_tokens");
  const cachedInput = Math.min(totalInput, integerField(usage, "cached_input_tokens"));
  return {
    inputTokens: totalInput - cachedInput,
    outputTokens: integerField(usage, "output_tokens"),
    cacheReadTokens: cachedInput,
    cacheWriteTokens: 0,
  };
}

function decodedToolInput(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function qualifiedToolName(payload: JsonRecord) {
  const name = stringField(payload, "name");
  if (name === undefined) return undefined;
  const namespace = stringField(payload, "namespace");
  return namespace === undefined ? name : `${namespace}.${name}`;
}

function toolUse(payload: JsonRecord, inputKey: "arguments" | "input") {
  const toolUseId = stringField(payload, "call_id") ?? stringField(payload, "id");
  const name = qualifiedToolName(payload);
  if (toolUseId === undefined || name === undefined) return [];
  const input = decodedToolInput(payload[inputKey]);
  return [
    {
      toolUseId,
      name,
      inputSummary: summarizeToolInput(input),
      targetPath: extractTargetPath(input),
    } satisfies NormalizedToolUse,
  ];
}

function toolResult(payload: JsonRecord, isError = false) {
  const toolUseId = stringField(payload, "call_id");
  return toolUseId === undefined ? [] : [{ toolUseId, isError } satisfies NormalizedToolResult];
}

function resultIsError(payload: JsonRecord) {
  const status = stringField(payload, "status")?.toLowerCase();
  const exitCode = payload["exit_code"];
  return (
    payload["success"] === false ||
    (typeof exitCode === "number" && exitCode !== 0) ||
    (status !== undefined && !["completed", "success", "ok", "closed"].includes(status))
  );
}

function sessionRelationships(payload: JsonRecord) {
  const source = payload["source"];
  let parentSessionId: string | undefined;
  let agentId = stringField(payload, "agent_nickname");
  let agentRole = stringField(payload, "agent_role");

  if (isRecord(source) && isRecord(source["subagent"])) {
    const threadSpawn = source["subagent"]["thread_spawn"];
    if (isRecord(threadSpawn)) {
      parentSessionId = stringField(threadSpawn, "parent_thread_id");
      agentId ??= stringField(threadSpawn, "agent_nickname");
      agentRole ??= stringField(threadSpawn, "agent_role");
    }
  } else if (isRecord(source) && typeof source["subagent"] === "string") {
    agentId ??= source["subagent"];
  }

  const forkedFromSessionId = stringField(payload, "forked_from_id");
  if (parentSessionId === undefined && agentId !== undefined) {
    parentSessionId = forkedFromSessionId;
  }
  return { parentSessionId, agentId, agentRole, forkedFromSessionId };
}

function baseEvent(envelope: JsonRecord, payload: JsonRecord, carriesSessionMetadata = false) {
  const relationships = sessionRelationships(payload);
  const git = payload["git"];
  return {
    sessionId: carriesSessionMetadata
      ? (stringField(payload, "session_id") ?? stringField(payload, "id"))
      : undefined,
    ...relationships,
    clientName: stringField(payload, "originator"),
    uuid: stringField(payload, "id") ?? stringField(payload, "call_id"),
    parentUuid: undefined,
    timestampMs: timestampMs(envelope),
    cwd: stringField(payload, "cwd"),
    gitBranch: isRecord(git) ? stringField(git, "branch") : undefined,
    version: stringField(payload, "cli_version"),
    model: stringField(payload, "model"),
    messageId: stringField(payload, "id"),
    requestId: stringField(payload, "turn_id"),
    hasUsage: false,
    isSidechain: relationships.parentSessionId !== undefined,
    isMeta: true,
    isInterrupt: false,
    usage: emptyUsage,
    content: missingContent,
    toolUses: [] as NormalizedToolUse[],
    toolResults: [] as NormalizedToolResult[],
  };
}

function parseError(parseError: "invalid_json" | "not_object" | "missing_type"): NormalizedEvent {
  return {
    kind: "parse_error",
    type: "parse_error",
    parseError,
    ...baseEvent({}, {}),
  };
}

export function parseCodexEvent(line: string): NormalizedEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return parseError("invalid_json");
  }
  if (!isRecord(parsed)) return parseError("not_object");
  const envelopeType = stringField(parsed, "type");
  if (envelopeType === undefined) return parseError("missing_type");
  const payload = isRecord(parsed["payload"]) ? parsed["payload"] : {};
  const payloadType = stringField(payload, "type");
  const rawType = payloadType === undefined ? envelopeType : `${envelopeType}:${payloadType}`;
  const base = baseEvent(parsed, payload, envelopeType === "session_meta");

  if (envelopeType === "event_msg" && payloadType === "user_message") {
    return {
      ...base,
      kind: "user",
      type: "user",
      role: "user",
      isMeta: false,
      content: contentSummary(payload["message"]),
    };
  }
  if (envelopeType === "event_msg" && payloadType === "agent_message") {
    return {
      ...base,
      kind: "assistant",
      type: "assistant",
      role: "assistant",
      stopReason: undefined,
      isMeta: false,
      content: contentSummary(payload["message"]),
    };
  }
  if (envelopeType === "event_msg" && payloadType === "token_count") {
    const usage = usageFromTokenCount(payload);
    return {
      ...base,
      kind: "unknown",
      type: rawType,
      hasUsage: isRecord(payload["info"]) && isRecord(payload["info"]["last_token_usage"]),
      usage,
    };
  }
  if (envelopeType === "event_msg" && payloadType === "turn_aborted") {
    return { ...base, kind: "unknown", type: rawType, isInterrupt: true };
  }
  if (envelopeType === "event_msg" && payloadType?.endsWith("_end") === true) {
    return {
      ...base,
      kind: "unknown",
      type: rawType,
      toolResults: toolResult(payload, resultIsError(payload)),
    };
  }
  if (envelopeType === "response_item" && payloadType === "function_call") {
    return {
      ...base,
      kind: "unknown",
      type: rawType,
      isMeta: false,
      toolUses: toolUse(payload, "arguments"),
    };
  }
  if (envelopeType === "response_item" && payloadType === "custom_tool_call") {
    return {
      ...base,
      kind: "unknown",
      type: rawType,
      isMeta: false,
      toolUses: toolUse(payload, "input"),
    };
  }
  if (
    envelopeType === "response_item" &&
    (payloadType === "function_call_output" || payloadType === "custom_tool_call_output")
  ) {
    return {
      ...base,
      kind: "unknown",
      type: rawType,
      isMeta: false,
      toolResults: toolResult(payload),
    };
  }
  if (envelopeType === "response_item" && payloadType === "web_search_call") {
    const toolUseId = stringField(payload, "call_id") ?? stringField(payload, "id");
    const input = decodedToolInput(payload["action"]);
    return {
      ...base,
      kind: "unknown",
      type: rawType,
      isMeta: false,
      toolUses:
        toolUseId === undefined
          ? []
          : [
              {
                toolUseId,
                name: "WebSearch",
                inputSummary: summarizeToolInput(input),
                targetPath: undefined,
              },
            ],
    };
  }
  if (envelopeType === "compacted") {
    return { ...base, kind: "summary", type: "summary", leafUuid: undefined };
  }

  return { ...base, kind: "unknown", type: rawType };
}

export class CodexEventParser {
  #model: string | undefined;

  parse(line: string) {
    const event = parseCodexEvent(line);
    if (event.type === "turn_context" || event.type === "codex:turn_context") {
      this.#model = event.model;
    } else if (event.model !== undefined && event.isMeta) {
      this.#model = event.model;
    }
    if (event.hasUsage && event.model === undefined && this.#model !== undefined) {
      event.model = this.#model;
    }
    return event;
  }
}
