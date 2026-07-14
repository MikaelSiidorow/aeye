import assert from "node:assert/strict";
import test from "node:test";

import { loadEnvironment } from "./env.ts";

await test("loads and validates the environment", () => {
  assert.deepEqual(loadEnvironment({}), { databasePath: "data/aeye.sqlite" });
  assert.deepEqual(loadEnvironment({ AEYE_DB_PATH: " /tmp/aeye.sqlite " }), {
    databasePath: "/tmp/aeye.sqlite",
  });
  assert.throws(() => loadEnvironment({ AEYE_DB_PATH: " " }), /must not be empty/);
  assert.throws(() => loadEnvironment({ AEYE_DB_PATH: "bad\0path" }), /null byte/);
});
