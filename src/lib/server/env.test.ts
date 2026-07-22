import assert from "node:assert/strict";
import test from "node:test";

import { defaultClaudeProjectsPath, defaultCodexHomePath, loadEnvironment } from "./env.ts";

await test("loads and validates the environment", () => {
  assert.deepEqual(loadEnvironment({}), {
    databasePath: "data/aeye.sqlite",
    claudeProjectsPath: defaultClaudeProjectsPath,
    codexHomePath: defaultCodexHomePath,
  });
  assert.deepEqual(
    loadEnvironment({
      AEYE_DB_PATH: " /tmp/aeye.sqlite ",
      AEYE_CLAUDE_PROJECTS_PATH: " /tmp/claude-projects ",
      CODEX_HOME: " /tmp/codex-default ",
      AEYE_CODEX_HOME_PATH: " /tmp/codex-home ",
    }),
    {
      databasePath: "/tmp/aeye.sqlite",
      claudeProjectsPath: "/tmp/claude-projects",
      codexHomePath: "/tmp/codex-home",
    },
  );
  assert.throws(() => loadEnvironment({ AEYE_DB_PATH: " " }), /must not be empty/);
  assert.throws(() => loadEnvironment({ AEYE_DB_PATH: "bad\0path" }), /null byte/);
  assert.throws(() => loadEnvironment({ AEYE_CLAUDE_PROJECTS_PATH: " " }), /must not be empty/);
  assert.throws(() => loadEnvironment({ AEYE_CODEX_HOME_PATH: " " }), /must not be empty/);
  assert.throws(() => loadEnvironment({ CODEX_HOME: " " }), /must not be empty/);
});
