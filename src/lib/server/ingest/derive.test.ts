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
      annotations: 0,
    });
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("derives body-safe execution context and child skill provenance", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aeye-annotations-"));
  const root = join(directory, "projects");
  const project = join(root, "project");
  const sessionPath = join(project, "annotation-session.jsonl");
  const agentDirectory = join(project, "annotation-session", "subagents");
  const agentPath = join(agentDirectory, "agent-rescue.jsonl");
  const sidecarPath = join(agentDirectory, "agent-rescue.meta.json");
  const cwd = join(directory, ".t3", "worktrees", "infra", "feature");
  mkdirSync(agentDirectory, { recursive: true });

  writeFileSync(
    sessionPath,
    line({
      type: "user",
      sessionId: "annotation-session",
      cwd,
      uuid: "root",
      timestamp: "2026-07-14T10:00:00.000Z",
      message: { role: "user", content: "PRIVATE_ROOT_PROMPT" },
    }) +
      line({
        type: "assistant",
        sessionId: "annotation-session",
        cwd,
        uuid: "tools",
        parentUuid: "root",
        timestamp: "2026-07-14T10:00:01.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "skill-call",
              name: "Skill",
              input: { skill: "deep-research", args: "PRIVATE_SKILL_ARGUMENTS" },
            },
            {
              type: "tool_use",
              id: "agent-spawn",
              name: "Agent",
              input: {
                subagent_type: "codex:codex-rescue",
                prompt: "PRIVATE_AGENT_PROMPT",
              },
            },
            {
              type: "tool_use",
              id: "generic-spawn",
              name: "Agent",
              input: { subagent_type: "general-purpose" },
            },
            {
              type: "tool_use",
              id: "scratchpad-write",
              name: "Write",
              input: {
                file_path: join(cwd, "scratchpad", "notes.md"),
                content: "PRIVATE_SCRATCHPAD_BODY",
              },
            },
          ],
        },
      }),
  );
  writeFileSync(
    agentPath,
    line({
      type: "assistant",
      sessionId: "annotation-session",
      cwd,
      uuid: "agent-answer",
      timestamp: "2026-07-14T10:00:02.000Z",
      isSidechain: true,
      message: { role: "assistant", content: "PRIVATE_AGENT_ANSWER" },
    }),
  );
  writeFileSync(
    sidecarPath,
    JSON.stringify({
      agentType: "codex:codex-rescue",
      toolUseId: "agent-spawn",
      spawnDepth: 1,
      description: "PRIVATE_SIDECAR_DESCRIPTION",
    }),
  );

  const db = openDatabase(join(directory, "test.sqlite"));
  try {
    const summary = await new ClaudeIngestor(db, { root }).scan();
    assert.equal(summary.insertedEvents, 3);
    const parentEvent = db.$client
      .prepare(
        "SELECT source_event_id AS sourceEventId FROM tool_calls WHERE session_id = ? AND tool_use_id = ?",
      )
      .get("annotation-session", "agent-spawn") as { sourceEventId: number } | undefined;
    assert.ok(parentEvent);

    const rows = db.$client
      .prepare(
        `SELECT id, session_id AS sessionId, event_id AS eventId, kind, value, created_at AS createdAt
         FROM annotations
         ORDER BY session_id, created_at, event_id, kind, value`,
      )
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(
      rows.map(({ id: _id, createdAt: _createdAt, ...row }) => row),
      [
        {
          sessionId: "annotation-session",
          eventId: null,
          kind: "worktree",
          value: "t3",
        },
        {
          sessionId: "annotation-session",
          eventId: parentEvent.sourceEventId,
          kind: "scratchpad",
          value: "scratchpad",
        },
        {
          sessionId: "annotation-session",
          eventId: parentEvent.sourceEventId,
          kind: "skill",
          value: "codex:codex-rescue",
        },
        {
          sessionId: "annotation-session",
          eventId: parentEvent.sourceEventId,
          kind: "skill",
          value: "deep-research",
        },
        {
          sessionId: "annotation-session:agent:agent-rescue",
          eventId: parentEvent.sourceEventId,
          kind: "skill",
          value: "codex:codex-rescue",
        },
        {
          sessionId: "annotation-session:agent:agent-rescue",
          eventId: null,
          kind: "worktree",
          value: "t3",
        },
      ],
    );
    assert.equal(JSON.stringify(rows).includes("general-purpose"), false);

    deriveSession(db, "annotation-session");
    deriveSession(db, "annotation-session:agent:agent-rescue");
    const repeated = db.$client
      .prepare(
        `SELECT id, session_id AS sessionId, event_id AS eventId, kind, value, created_at AS createdAt
         FROM annotations
         ORDER BY session_id, created_at, event_id, kind, value`,
      )
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(repeated, rows);

    const serialized = JSON.stringify({
      annotations: repeated,
      tools: db.$client
        .prepare("SELECT input_summary, target_path FROM tool_calls ORDER BY id")
        .all(),
    });
    for (const privateValue of [
      "PRIVATE_ROOT_PROMPT",
      "PRIVATE_SKILL_ARGUMENTS",
      "PRIVATE_AGENT_PROMPT",
      "PRIVATE_SCRATCHPAD_BODY",
      "PRIVATE_AGENT_ANSWER",
      "PRIVATE_SIDECAR_DESCRIPTION",
    ]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("deduplicates parent usage replayed in a subagent transcript", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aeye-usage-dedupe-"));
  const root = join(directory, "projects");
  const project = join(root, "-tmp-dedupe-project");
  const mainPath = join(project, "session.jsonl");
  const agentDirectory = join(project, "session", "subagents");
  const agentPath = join(agentDirectory, "agent-worker.jsonl");
  mkdirSync(agentDirectory, { recursive: true });

  writeFileSync(
    mainPath,
    line({
      type: "assistant",
      sessionId: "session",
      cwd: "/tmp/dedupe-project",
      uuid: "main-answer",
      timestamp: "2026-07-14T10:00:00.000Z",
      requestId: "request-main",
      message: {
        id: "message-replayed",
        role: "assistant",
        model: "claude-test",
        usage: { input_tokens: 10, output_tokens: 2 },
        content: [],
      },
    }),
  );
  writeFileSync(
    agentPath,
    line({
      type: "assistant",
      sessionId: "session",
      cwd: "/tmp/dedupe-project",
      uuid: "replayed-answer",
      timestamp: "2026-07-14T10:00:01.000Z",
      requestId: "request-sidechain-replay",
      isSidechain: true,
      message: {
        id: "message-replayed",
        role: "assistant",
        model: "claude-test",
        usage: { input_tokens: 1_000, output_tokens: 100 },
        content: [],
      },
    }) +
      line({
        type: "assistant",
        sessionId: "session",
        cwd: "/tmp/dedupe-project",
        uuid: "agent-answer",
        parentUuid: "replayed-answer",
        timestamp: "2026-07-14T10:00:02.000Z",
        requestId: "request-agent",
        isSidechain: true,
        message: {
          id: "message-agent",
          role: "assistant",
          model: "claude-test",
          usage: { input_tokens: 3, output_tokens: 4 },
          content: [],
        },
      }),
  );

  const db = openDatabase(join(directory, "test.sqlite"));
  try {
    const summary = await new ClaudeIngestor(db, { root }).scan();
    assert.equal(summary.insertedEvents, 3);
    assert.deepEqual(
      db.$client
        .prepare("SELECT message_id, is_sidechain FROM events WHERE is_usage_duplicate = 1")
        .all()
        .map((row) => ({ ...row })),
      [{ message_id: "message-replayed", is_sidechain: 1 }],
    );

    const main = db.query.sessionStats.findFirst({ where: { sessionId: "session" } }).sync();
    const agent = db.query.sessionStats
      .findFirst({ where: { sessionId: "session:agent:agent-worker" } })
      .sync();
    assert.deepEqual(
      { input: main?.tokInput, output: main?.tokOutput, turns: main?.assistantTurns },
      { input: 10, output: 2, turns: 1 },
    );
    assert.deepEqual(
      { input: agent?.tokInput, output: agent?.tokOutput, turns: agent?.assistantTurns },
      { input: 3, output: 4, turns: 1 },
    );
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
