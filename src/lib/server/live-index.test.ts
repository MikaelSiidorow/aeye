import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./db/database.ts";
import { LiveIndex } from "./live-index.ts";

async function waitForUpdate(subscription: ReturnType<LiveIndex["subscribe"]>) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      subscription.next(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Timed out waiting for live index update")),
          5_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

await test("indexes watched changes and closes streams and watchers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aeye-live-index-"));
  const claudeProjectsPath = join(directory, "claude-projects");
  const projectSource = join(claudeProjectsPath, "-tmp-live-project");
  const codexHomePath = join(directory, "codex");
  const sessionPath = join(projectSource, "live-session.jsonl");
  const codexSessionPath = join(codexHomePath, "sessions", "rollout-live.jsonl");
  const databasePath = join(directory, "live.sqlite");
  mkdirSync(projectSource, { recursive: true });
  mkdirSync(join(codexHomePath, "sessions"), { recursive: true });
  mkdirSync(join(codexHomePath, "archived_sessions"), { recursive: true });

  const liveIndex = new LiveIndex({
    databasePath,
    claudeProjectsPath,
    codexHomePath,
  });

  try {
    await liveIndex.ready;
    const subscription = liveIndex.subscribe();
    assert.equal(liveIndex.subscriberCount, 1);
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "user",
        sessionId: "live-session",
        cwd: "/tmp/live-project",
        uuid: "live-event",
        timestamp: "2026-07-23T12:00:00.000Z",
        message: { role: "user", content: "PRIVATE_LIVE_BODY" },
      })}\n`,
    );

    const result = await waitForUpdate(subscription);
    assert.equal(result.done, false);
    assert.deepEqual(result.value?.sessionIds, ["live-session"]);
    assert.equal(result.value?.projectIds.length, 1);
    assert.equal(result.value?.revision, 1);

    writeFileSync(
      codexSessionPath,
      `${JSON.stringify({
        timestamp: "2026-07-23T12:00:02.000Z",
        type: "session_meta",
        payload: {
          id: "metadata-live-thread",
          session_id: "live-thread",
          cwd: "/tmp/live-project",
          source: "cli",
          originator: "codex-tui",
          cli_version: "0.145.0",
          base_instructions: "PRIVATE_CODEX_INSTRUCTIONS",
        },
      })}\n`,
    );
    const codexResult = await waitForUpdate(subscription);
    assert.equal(codexResult.done, false);
    assert.deepEqual(codexResult.value?.sessionIds, ["codex:live-thread"]);
    assert.deepEqual(codexResult.value?.projectIds, result.value?.projectIds);
    assert.equal(codexResult.value?.revision, 2);

    const db = openDatabase(databasePath);
    try {
      assert.equal(db.$client.prepare("SELECT count(*) AS count FROM events").get()?.["count"], 2);
      assert.equal(
        db.$client.prepare("SELECT count(*) AS count FROM sessions").get()?.["count"],
        2,
      );
    } finally {
      db.$client.close();
    }

    await subscription.return();
    assert.equal(liveIndex.subscriberCount, 0);
  } finally {
    await liveIndex.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
