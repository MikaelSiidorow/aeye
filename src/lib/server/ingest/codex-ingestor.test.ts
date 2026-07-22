import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

import { openDatabase } from "../db/database.ts";
import { CodexIngestor } from "./codex-ingestor.ts";

function jsonLine(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

function sessionMeta(
  id: string,
  cwd: string,
  source: unknown = "cli",
  extra: Record<string, unknown> = {},
) {
  return {
    timestamp: "2026-07-14T10:00:00.000Z",
    type: "session_meta",
    payload: {
      id: `metadata-${id}`,
      session_id: id,
      cwd,
      source,
      originator: "codex-tui",
      cli_version: "0.144.3",
      base_instructions: "PRIVATE_BASE_INSTRUCTIONS",
      git: { branch: "main", commit_hash: "private" },
      ...extra,
    },
  };
}

function visibleMessage(type: "user_message" | "agent_message", message: string, second: number) {
  return {
    timestamp: `2026-07-14T10:00:0${second}.000Z`,
    type: "event_msg",
    payload: { type, message },
  };
}

function eventDump(db: ReturnType<typeof openDatabase>) {
  return JSON.stringify(db.$client.prepare("SELECT * FROM events ORDER BY id").all());
}

await test("ingests, derives, links, rewrites, and deterministically reindexes Codex rollouts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aeye-codex-ingestor-"));
  const root = join(directory, "codex-home");
  const sessionsRoot = join(root, "sessions", "2026", "07", "14");
  const cwd = join(directory, "working-project");
  const parentPath = join(sessionsRoot, "rollout-parent.jsonl");
  const childPath = join(sessionsRoot, "rollout-child.jsonl");
  const stateChildPath = join(sessionsRoot, "rollout-state-child.jsonl.zst");
  mkdirSync(sessionsRoot, { recursive: true });

  const parent =
    jsonLine(sessionMeta("thread-parent", cwd)) +
    jsonLine({
      timestamp: "2026-07-14T10:00:00.500Z",
      type: "turn_context",
      payload: { model: "gpt-test", cwd },
    }) +
    jsonLine(visibleMessage("user_message", "PRIVATE_USER_MESSAGE", 1)) +
    jsonLine({
      timestamp: "2026-07-14T10:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call-1",
        name: "exec_command",
        arguments: JSON.stringify({ command: "PRIVATE_COMMAND", cwd }),
      },
    }) +
    jsonLine({
      timestamp: "2026-07-14T10:00:03.000Z",
      type: "event_msg",
      payload: {
        type: "exec_command_end",
        call_id: "call-1",
        exit_code: 0,
        stdout: "PRIVATE_OUTPUT",
      },
    }) +
    jsonLine({
      timestamp: "2026-07-14T10:00:04.000Z",
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
    }) +
    jsonLine(visibleMessage("agent_message", "PRIVATE_AGENT_MESSAGE", 5));
  writeFileSync(parentPath, parent);

  writeFileSync(
    childPath,
    jsonLine(
      sessionMeta("thread-child", cwd, {
        subagent: {
          thread_spawn: {
            parent_thread_id: "thread-parent",
            depth: 1,
            agent_nickname: "Kepler",
            agent_role: "worker",
          },
        },
      }),
    ) + jsonLine(visibleMessage("agent_message", "PRIVATE_CHILD_MESSAGE", 2)),
  );
  appendFileSync(childPath, jsonLine(sessionMeta("thread-parent", cwd)));

  const stateChild =
    jsonLine(sessionMeta("thread-state-child", cwd)) +
    jsonLine(visibleMessage("agent_message", "PRIVATE_STATE_CHILD_MESSAGE", 3));
  writeFileSync(stateChildPath, zstdCompressSync(Buffer.from(stateChild)));

  const state = new DatabaseSync(join(root, "state_5.sqlite"));
  state.exec(
    "CREATE TABLE thread_spawn_edges (parent_thread_id TEXT NOT NULL, child_thread_id TEXT NOT NULL PRIMARY KEY, status TEXT NOT NULL)",
  );
  state
    .prepare(
      "INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)",
    )
    .run("thread-parent", "thread-state-child", "closed");
  state.close();

  const db = openDatabase(join(directory, "test.sqlite"));
  const ingestor = new CodexIngestor(db, { root, batchSize: 2 });
  const errors: unknown[] = [];
  ingestor.on("ingest:error", (event) => errors.push(event));

  try {
    const cold = await ingestor.scan();
    assert.deepEqual(
      {
        discoveredFiles: cold.discoveredFiles,
        queuedFiles: cold.queuedFiles,
        processedFiles: cold.processedFiles,
        insertedEvents: cold.insertedEvents,
        failedFiles: cold.failedFiles,
      },
      {
        discoveredFiles: 3,
        queuedFiles: 3,
        processedFiles: 3,
        insertedEvents: 12,
        failedFiles: 0,
      },
    );

    const parentSession = db.query.sessions
      .findFirst({ where: { id: "codex:thread-parent" } })
      .sync();
    assert.equal(parentSession?.source, "codex");
    assert.equal(parentSession?.sourceSessionId, "thread-parent");
    assert.equal(parentSession?.clientName, "codex-tui");
    assert.equal(parentSession?.clientVersion, "0.144.3");
    assert.equal(parentSession?.parentId, null);
    assert.equal(parentSession?.agentId, null);
    const child = db.query.sessions.findFirst({ where: { id: "codex:thread-child" } }).sync();
    assert.equal(child?.parentId, "codex:thread-parent");
    assert.equal(child?.agentId, "Kepler");
    const stateChildSession = db.query.sessions
      .findFirst({ where: { id: "codex:thread-state-child" } })
      .sync();
    assert.equal(stateChildSession?.parentId, "codex:thread-parent");
    assert.equal(stateChildSession?.agentId, "subagent");

    const stats = db.query.sessionStats
      .findFirst({ where: { sessionId: "codex:thread-parent" } })
      .sync();
    assert.equal(stats?.userTurns, 1);
    assert.equal(stats?.assistantTurns, 1);
    assert.equal(stats?.toolCalls, 1);
    assert.equal(stats?.tokInput, 40);
    assert.equal(stats?.tokOutput, 20);
    assert.equal(stats?.tokCacheRead, 60);
    assert.equal(stats?.tokCacheWrite, 0);

    const tool = db.query.toolCalls
      .findFirst({ where: { sessionId: "codex:thread-parent" } })
      .sync();
    assert.equal(tool?.status, "completed");
    assert.equal(tool?.targetPath, cwd);
    assert.equal(tool?.inputSummary?.includes("PRIVATE_COMMAND"), false);

    const storedEvents = eventDump(db);
    assert.equal(storedEvents.includes("PRIVATE_USER_MESSAGE"), false);
    assert.equal(storedEvents.includes("PRIVATE_AGENT_MESSAGE"), false);
    assert.equal(storedEvents.includes("PRIVATE_OUTPUT"), false);

    const noOp = await ingestor.scan();
    assert.equal(noOp.queuedFiles, 0);
    assert.equal(noOp.processedFiles, 0);
    assert.equal(noOp.insertedEvents, 0);

    appendFileSync(parentPath, jsonLine(visibleMessage("agent_message", "PRIVATE_TAIL", 6)));
    const tail = await ingestor.scan();
    assert.equal(tail.insertedEvents, 1);

    writeFileSync(
      parentPath,
      jsonLine(sessionMeta("thread-parent", cwd)) +
        jsonLine(visibleMessage("user_message", "PRIVATE_REWRITTEN", 1)),
    );
    const rewrite = await ingestor.scan();
    assert.equal(rewrite.rewrittenFiles, 1);
    assert.equal(rewrite.insertedEvents, 2);
    assert.equal(
      db.$client
        .prepare("SELECT count(*) AS count FROM tool_calls WHERE session_id = ?")
        .get("codex:thread-parent")?.["count"],
      0,
    );

    const firstReindex = await ingestor.reindex();
    assert.equal(firstReindex.insertedEvents, 7);
    const firstDump = eventDump(db);
    const secondReindex = await ingestor.reindex();
    assert.equal(secondReindex.insertedEvents, 7);
    assert.equal(eventDump(db), firstDump);
    assert.deepEqual(errors, []);
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
