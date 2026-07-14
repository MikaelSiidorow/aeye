import assert from "node:assert/strict";
import test from "node:test";

import { defaultClaudeProjectsPath, loadEnvironment } from "./env.ts";

await test("loads and validates the environment", () => {
  assert.deepEqual(loadEnvironment({}), {
    databasePath: "data/aeye.sqlite",
    claudeProjectsPath: defaultClaudeProjectsPath,
  });
  assert.deepEqual(
    loadEnvironment({
      AEYE_DB_PATH: " /tmp/aeye.sqlite ",
      AEYE_CLAUDE_PROJECTS_PATH: " /tmp/claude-projects ",
    }),
    {
      databasePath: "/tmp/aeye.sqlite",
      claudeProjectsPath: "/tmp/claude-projects",
    },
  );
  assert.throws(() => loadEnvironment({ AEYE_DB_PATH: " " }), /must not be empty/);
  assert.throws(() => loadEnvironment({ AEYE_DB_PATH: "bad\0path" }), /null byte/);
  assert.throws(() => loadEnvironment({ AEYE_CLAUDE_PROJECTS_PATH: " " }), /must not be empty/);
});
