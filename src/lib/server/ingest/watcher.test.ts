import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import { ClaudeIngestor, type SessionUpdatedEvent } from "./ingestor.ts";
import { startClaudeWatcher } from "./watcher.ts";

function waitForSessionUpdate(ingestor: ClaudeIngestor) {
  return new Promise<SessionUpdatedEvent>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for session update")),
      5_000,
    );
    ingestor.once("session:updated", (event: SessionUpdatedEvent) => {
      clearTimeout(timeout);
      resolve(event);
    });
  });
}

await test("watches settled JSONL changes and reuses the HMR guard", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aeye-watcher-"));
  const root = join(directory, "projects");
  const project = join(root, "-tmp-watched-project");
  const sessionPath = join(project, "watched-session.jsonl");
  mkdirSync(project, { recursive: true });

  const db = openDatabase(join(directory, "test.sqlite"));
  const ingestor = new ClaudeIngestor(db, { root });
  const watcher = startClaudeWatcher(ingestor);

  try {
    assert.equal(startClaudeWatcher(ingestor), watcher);
    await watcher.ready;
    const updated = waitForSessionUpdate(ingestor);
    writeFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "user",
        sessionId: "watched-session",
        cwd: "/tmp/watched-project",
        uuid: "watched-event",
        timestamp: "2026-07-14T12:00:00.000Z",
        message: { role: "user", content: "PRIVATE_WATCHED_BODY" },
      })}\n`,
    );

    assert.deepEqual(await updated, {
      sessionId: "watched-session",
      filePath: sessionPath,
      insertedEvents: 1,
    });
    assert.equal(db.$client.prepare("SELECT count(*) AS count FROM events").get()?.["count"], 1);
  } finally {
    await watcher.close();
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
