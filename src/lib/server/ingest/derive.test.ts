import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import { modelPricing } from "../db/schema.ts";
import { deriveSession } from "./derive.ts";
import { ClaudeIngestor } from "./ingestor.ts";

function line(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

await test("derives branch liveness, tool matches, tokens, turns, and cost", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aeye-derive-"));
  const root = join(directory, "projects");
  const project = join(root, "-tmp-forked-project");
  const sessionPath = join(project, "forked-session.jsonl");
  const cwd = "/tmp/forked-project";
  mkdirSync(project, { recursive: true });

  writeFileSync(
    sessionPath,
    line({
      type: "user",
      sessionId: "forked-session",
      cwd,
      uuid: "user-root",
      parentUuid: null,
      timestamp: "2026-07-14T10:00:00.000Z",
      message: { role: "user", content: "PRIVATE_ROOT_PROMPT" },
    }) +
      line({
        type: "assistant",
        sessionId: "forked-session",
        cwd,
        uuid: "assistant-tool",
        parentUuid: "user-root",
        timestamp: "2026-07-14T10:00:01.000Z",
        message: {
          role: "assistant",
          model: "claude-priced",
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_input_tokens: 2,
            cache_creation_input_tokens: 3,
          },
          content: [
            {
              type: "tool_use",
              id: "completed-tool",
              name: "Read",
              input: { file_path: "/tmp/file.ts", secret: "PRIVATE_TOOL_INPUT" },
            },
          ],
        },
      }) +
      line({
        type: "user",
        sessionId: "forked-session",
        cwd,
        uuid: "tool-result",
        parentUuid: "assistant-tool",
        timestamp: "2026-07-14T10:00:01.500Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "completed-tool",
              content: "PRIVATE_TOOL_RESULT",
            },
          ],
        },
      }) +
      line({
        type: "assistant",
        sessionId: "forked-session",
        cwd,
        uuid: "dead-leaf",
        parentUuid: "user-root",
        timestamp: "2026-07-14T10:00:02.000Z",
        message: {
          role: "assistant",
          model: "claude-priced",
          usage: { input_tokens: 100, output_tokens: 100 },
          content: [
            {
              type: "tool_use",
              id: "dead-tool",
              name: "Bash",
              input: { command: "PRIVATE_DEAD_COMMAND" },
            },
          ],
        },
      }) +
      line({
        type: "assistant",
        sessionId: "forked-session",
        cwd,
        uuid: "active-leaf",
        parentUuid: "tool-result",
        timestamp: "2026-07-14T10:00:03.000Z",
        message: {
          role: "assistant",
          model: "claude-priced",
          usage: {
            input_tokens: 20,
            output_tokens: 7,
            cache_read_input_tokens: 1,
            cache_creation_input_tokens: 2,
          },
          content: [
            {
              type: "tool_use",
              id: "unmatched-tool",
              name: "Grep",
              input: { pattern: "PRIVATE_PATTERN" },
            },
          ],
        },
      }) +
      line({
        type: "system",
        sessionId: "forked-session",
        cwd,
        isMeta: true,
        subtype: "turn_duration",
        timestamp: "2026-07-14T10:00:04.000Z",
        content: "PRIVATE_SYSTEM_CONTENT",
      }),
  );

  const db = openDatabase(join(directory, "test.sqlite"));
  db.insert(modelPricing)
    .values({
      model: "claude-priced",
      effectiveFrom: 0,
      inputUsdPerMtok: 1,
      outputUsdPerMtok: 2,
      cacheReadUsdPerMtok: 0.5,
      cacheWriteUsdPerMtok: 1.5,
    })
    .run();

  try {
    const ingestor = new ClaudeIngestor(db, { root });
    const summary = await ingestor.scan();
    assert.equal(summary.insertedEvents, 6);

    const dead = db.$client
      .prepare("SELECT uuid FROM events WHERE is_dead_branch = 1 ORDER BY seq")
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(dead, [{ uuid: "dead-leaf" }]);

    const calls = db.$client
      .prepare(
        "SELECT tool_use_id, status, duration_ms, target_path FROM tool_calls ORDER BY tool_use_id",
      )
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(calls, [
      {
        tool_use_id: "completed-tool",
        status: "completed",
        duration_ms: 500,
        target_path: "/tmp/file.ts",
      },
      { tool_use_id: "dead-tool", status: "unmatched", duration_ms: null, target_path: null },
      {
        tool_use_id: "unmatched-tool",
        status: "unmatched",
        duration_ms: null,
        target_path: null,
      },
    ]);

    const stats = db.query.sessionStats
      .findFirst({ where: { sessionId: "forked-session" } })
      .sync();
    assert.ok(stats);
    assert.deepEqual(
      {
        userTurns: stats.userTurns,
        assistantTurns: stats.assistantTurns,
        toolCalls: stats.toolCalls,
        durationMs: stats.durationMs,
        tokInput: stats.tokInput,
        tokOutput: stats.tokOutput,
        tokCacheRead: stats.tokCacheRead,
        tokCacheWrite: stats.tokCacheWrite,
        tokDeadBranch: stats.tokDeadBranch,
      },
      {
        userTurns: 1,
        assistantTurns: 2,
        toolCalls: 2,
        durationMs: 3_000,
        tokInput: 30,
        tokOutput: 12,
        tokCacheRead: 3,
        tokCacheWrite: 5,
        tokDeadBranch: 200,
      },
    );
    assert.ok(Math.abs(stats.costUsd - 0.000_063) < 1e-12);

    assert.deepEqual(deriveSession(db, "forked-session"), {
      sessionId: "forked-session",
      deadBranchEvents: 1,
      toolCalls: 3,
      unmatchedToolCalls: 2,
    });
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
