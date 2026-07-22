import assert from "node:assert/strict";
import test from "node:test";

import fc from "fast-check";

import { CodexEventParser, parseCodexEvent } from "./codex.ts";

await test("extracts Codex session and subagent metadata without retaining instructions", () => {
  const event = parseCodexEvent(
    JSON.stringify({
      timestamp: "2026-07-14T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "metadata-item",
        session_id: "thread-child",
        cwd: "/tmp/project",
        cli_version: "0.144.3",
        originator: "Claude Code",
        agent_nickname: "Kepler",
        agent_role: "worker",
        base_instructions: "PRIVATE_BASE_INSTRUCTIONS",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: "thread-parent",
              depth: 1,
              agent_nickname: "Kepler",
              agent_role: "worker",
            },
          },
        },
        git: { branch: "main", commit_hash: "private" },
      },
    }),
  );

  assert.equal(event.sessionId, "thread-child");
  assert.equal(event.parentSessionId, "thread-parent");
  assert.equal(event.agentId, "Kepler");
  assert.equal(event.agentRole, "worker");
  assert.equal(event.clientName, "Claude Code");
  assert.equal(event.version, "0.144.3");
  assert.equal(event.cwd, "/tmp/project");
  assert.equal(event.gitBranch, "main");
  assert.equal(JSON.stringify(event).includes("PRIVATE_BASE_INSTRUCTIONS"), false);
});

await test("deduplicates message envelopes and keeps visible turns body-free", () => {
  const user = parseCodexEvent(
    JSON.stringify({
      timestamp: "2026-07-14T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "PRIVATE_USER_MESSAGE" },
    }),
  );
  const assistant = parseCodexEvent(
    JSON.stringify({
      timestamp: "2026-07-14T10:00:02.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "PRIVATE_AGENT_MESSAGE" },
    }),
  );
  const duplicate = parseCodexEvent(
    JSON.stringify({
      timestamp: "2026-07-14T10:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "PRIVATE_DUPLICATE_MESSAGE" }],
      },
    }),
  );

  assert.equal(user.kind, "user");
  assert.equal(user.isMeta, false);
  assert.deepEqual(user.content, { format: "string", blockCount: 0 });
  assert.equal(assistant.kind, "assistant");
  assert.equal(assistant.isMeta, false);
  assert.equal(duplicate.kind, "unknown");
  assert.equal(duplicate.isMeta, true);
  const normalized = JSON.stringify([user, assistant, duplicate]);
  assert.equal(normalized.includes("PRIVATE_USER_MESSAGE"), false);
  assert.equal(normalized.includes("PRIVATE_AGENT_MESSAGE"), false);
  assert.equal(normalized.includes("PRIVATE_DUPLICATE_MESSAGE"), false);
});

await test("maps incremental token usage to disjoint columns and carries the turn model", () => {
  const parser = new CodexEventParser();
  parser.parse(
    JSON.stringify({
      timestamp: "2026-07-14T10:00:00.000Z",
      type: "turn_context",
      payload: { model: "gpt-test", cwd: "/tmp/project" },
    }),
  );
  const usage = parser.parse(
    JSON.stringify({
      timestamp: "2026-07-14T10:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 60,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120,
          },
        },
      },
    }),
  );

  assert.equal(usage.hasUsage, true);
  assert.equal(usage.model, "gpt-test");
  assert.deepEqual(usage.usage, {
    inputTokens: 40,
    outputTokens: 20,
    cacheReadTokens: 60,
    cacheWriteTokens: 0,
  });
});

await test("summarizes Codex tool arguments and matches result status without retaining bodies", () => {
  const call = parseCodexEvent(
    JSON.stringify({
      timestamp: "2026-07-14T10:00:04.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call-1",
        name: "exec_command",
        arguments: JSON.stringify({
          command: "PRIVATE_TOOL_COMMAND",
          cwd: "/tmp/project",
          flags: ["one", "two"],
        }),
      },
    }),
  );
  const result = parseCodexEvent(
    JSON.stringify({
      timestamp: "2026-07-14T10:00:05.000Z",
      type: "event_msg",
      payload: {
        type: "exec_command_end",
        call_id: "call-1",
        exit_code: 1,
        stdout: "PRIVATE_TOOL_OUTPUT",
      },
    }),
  );

  assert.deepEqual(call.toolUses, [
    {
      toolUseId: "call-1",
      name: "exec_command",
      inputSummary: "command: string(20 bytes), cwd: path, flags: array(2)",
      targetPath: "/tmp/project",
    },
  ]);
  assert.equal(call.sessionId, undefined);
  assert.deepEqual(result.toolResults, [{ toolUseId: "call-1", isError: true }]);
  const normalized = JSON.stringify([call, result]);
  assert.equal(normalized.includes("PRIVATE_TOOL_COMMAND"), false);
  assert.equal(normalized.includes("PRIVATE_TOOL_OUTPUT"), false);
});

await test("returns body-free parse errors and is total for arbitrary JSON objects", () => {
  assert.equal(parseCodexEvent("PRIVATE invalid json").kind, "parse_error");
  assert.equal(parseCodexEvent("[]").kind, "parse_error");
  assert.equal(parseCodexEvent("{}").kind, "parse_error");
  assert.equal(JSON.stringify(parseCodexEvent("PRIVATE invalid json")).includes("PRIVATE"), false);

  fc.assert(
    fc.property(
      fc.dictionary(fc.string({ maxLength: 20 }), fc.jsonValue(), { maxKeys: 30 }),
      (value) => {
        const event = parseCodexEvent(JSON.stringify(value));
        assert.equal(typeof event.kind, "string");
        assert.equal(typeof event.type, "string");
      },
    ),
    { numRuns: 500 },
  );
});
