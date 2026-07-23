import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openDatabase } from "./db/database.ts";
import { CodexIngestor } from "./ingest/codex-ingestor.ts";
import { ClaudeIngestor } from "./ingest/ingestor.ts";
import { SessionNameResolver } from "./session-name.ts";

function line(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

function claudeUser(sessionId: string, cwd: string, content: string) {
  return {
    type: "user",
    sessionId,
    cwd,
    uuid: `${sessionId}-user`,
    timestamp: "2026-07-23T10:00:00.000Z",
    message: { role: "user", content },
  };
}

function codexRollout(sessionId: string, cwd: string, message?: string) {
  return (
    line({
      timestamp: "2026-07-23T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: `${sessionId}-metadata`,
        session_id: sessionId,
        cwd,
        source: "cli",
        originator: "codex-tui",
      },
    }) +
    (message === undefined
      ? ""
      : line({
          timestamp: "2026-07-23T10:00:01.000Z",
          type: "event_msg",
          payload: { type: "user_message", message },
        }))
  );
}

await test("resolves provider titles, subagent descriptions, previews, and generic names", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aeye-session-names-"));
  const claudeRoot = join(directory, "claude");
  const claudeProject = join(claudeRoot, "project");
  const codexHome = join(directory, "codex");
  const codexSessions = join(codexHome, "sessions");
  const cwd = join(directory, "work");
  const agentDirectory = join(claudeProject, "claude-titled", "subagents");
  mkdirSync(agentDirectory, { recursive: true });
  mkdirSync(codexSessions, { recursive: true });
  mkdirSync(join(codexHome, "archived_sessions"), { recursive: true });

  writeFileSync(
    join(claudeProject, "claude-titled.jsonl"),
    line(claudeUser("claude-titled", cwd, "PRIVATE_CLAUDE_TITLED_PROMPT")) +
      line({ type: "ai-title", sessionId: "claude-titled", aiTitle: "AI generated title" }) +
      line({
        type: "custom-title",
        sessionId: "claude-titled",
        customTitle: "  Custom\nClaude\u0007 title  ",
      }),
  );
  writeFileSync(
    join(agentDirectory, "agent-worker.jsonl"),
    line(claudeUser("claude-titled", cwd, "PRIVATE_CHILD_PROMPT")),
  );
  writeFileSync(
    join(agentDirectory, "agent-worker.meta.json"),
    JSON.stringify({ description: "  Investigate\nresolver behavior  " }),
  );
  writeFileSync(
    join(claudeProject, "claude-preview.jsonl"),
    line(
      claudeUser(
        "claude-preview",
        cwd,
        "Fix the session naming fallback without exposing the PRIVATE_CLAUDE_TAIL",
      ),
    ),
  );
  writeFileSync(
    join(claudeProject, "claude-generic.jsonl"),
    line({
      type: "assistant",
      sessionId: "claude-generic",
      cwd,
      uuid: "generic-answer",
      timestamp: "2026-07-23T10:00:00.000Z",
      message: { role: "assistant", content: "PRIVATE_ASSISTANT_ONLY_BODY" },
    }),
  );

  writeFileSync(
    join(codexSessions, "rollout-codex-named.jsonl"),
    codexRollout("codex-named", cwd, "PRIVATE_CODEX_NAMED_PROMPT"),
  );
  writeFileSync(
    join(codexSessions, "rollout-codex-titled.jsonl"),
    codexRollout("codex-titled", cwd, "PRIVATE_CODEX_TITLED_PROMPT"),
  );
  writeFileSync(
    join(codexSessions, "rollout-codex-preview.jsonl"),
    codexRollout(
      "codex-preview",
      cwd,
      "Trace the missing Codex title using a PRIVATE_CODEX_TAIL marker",
    ),
  );
  writeFileSync(
    join(codexSessions, "rollout-codex-generic.jsonl"),
    codexRollout("codex-generic", cwd),
  );

  const state = new DatabaseSync(join(codexHome, "state_5.sqlite"));
  state.exec(
    `CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      name TEXT,
      title TEXT,
      first_user_message TEXT
    )`,
  );
  const insertThread = state.prepare(
    "INSERT INTO threads (id, name, title, first_user_message) VALUES (?, ?, ?, ?)",
  );
  insertThread.run(
    "codex-named",
    "  Manual Codex name  ",
    "Ignored generated title",
    "PRIVATE_CODEX_NAMED_PROMPT",
  );
  insertThread.run("codex-titled", null, "Generated Codex title", "PRIVATE_CODEX_TITLED_PROMPT");
  insertThread.run(
    "codex-preview",
    null,
    "",
    "Trace the missing Codex title using a PRIVATE_CODEX_TAIL marker",
  );
  state.close();

  const db = openDatabase(join(directory, "aeye.sqlite"));
  try {
    assert.equal((await new ClaudeIngestor(db, { root: claudeRoot }).scan()).failedFiles, 0);
    assert.equal((await new CodexIngestor(db, { root: codexHome }).scan()).failedFiles, 0);
    const sessionRows = db.query.sessions.findMany().sync();
    const names = new SessionNameResolver(db, codexHome).resolve(sessionRows);

    assert.equal(names.get("claude-titled"), "Custom Claude title");
    assert.equal(names.get("claude-titled:agent:agent-worker"), "Investigate resolver behavior");
    assert.equal(
      names.get("claude-preview"),
      "Fix the session naming fallback without exposing the…",
    );
    assert.equal(names.get("claude-generic"), "Claude session");
    assert.equal(names.get("codex:codex-named"), "Manual Codex name");
    assert.equal(names.get("codex:codex-titled"), "Generated Codex title");
    assert.equal(
      names.get("codex:codex-preview"),
      "Trace the missing Codex title using a PRIVATE_CODEX_TAIL…",
    );
    assert.equal(names.get("codex:codex-generic"), "Codex thread");

    const indexed = JSON.stringify({
      sessions: db.query.sessions.findMany().sync(),
      events: db.query.events.findMany().sync(),
      annotations: db.query.annotations.findMany().sync(),
    });
    for (const sourceValue of [
      "Custom Claude title",
      "Investigate resolver behavior",
      "Manual Codex name",
      "Generated Codex title",
      "PRIVATE_CLAUDE_TITLED_PROMPT",
      "PRIVATE_CHILD_PROMPT",
      "PRIVATE_ASSISTANT_ONLY_BODY",
      "PRIVATE_CODEX_NAMED_PROMPT",
      "PRIVATE_CODEX_TITLED_PROMPT",
      "PRIVATE_CODEX_TAIL",
    ]) {
      assert.equal(indexed.includes(sourceValue), false);
    }
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
