import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./database.ts";
import { events, files, projects, sessions } from "./schema.ts";

await test("migrates on open and preserves 64-bit byte offsets", () => {
  const directory = mkdtempSync(join(tmpdir(), "aeye-db-"));
  const path = join(directory, "test.sqlite");

  try {
    const db = openDatabase(path);
    const now = Date.now();
    const project = db
      .insert(projects)
      .values({ path: "/tmp/project", name: "project", createdAt: now, updatedAt: now })
      .returning({ id: projects.id })
      .get();
    db.insert(sessions)
      .values({
        id: "session",
        sourceSessionId: "session",
        projectId: project.id,
        cwd: "/tmp/project",
      })
      .run();
    const file = db
      .insert(files)
      .values({
        projectId: project.id,
        sessionId: "session",
        path: "/tmp/project/session.jsonl",
        mtimeMs: now,
        size: 4_294_967_297,
      })
      .returning({ id: files.id })
      .get();

    const byteOffset = 2 ** 31 + 123;
    db.insert(events)
      .values({
        fileId: file.id,
        sessionId: "session",
        seq: 0,
        byteOffset,
        byteLength: 42,
        kind: "user",
        type: "user",
      })
      .run();

    const event = db.query.events.findFirst({ where: { seq: 0 } }).sync();
    assert.equal(event?.byteOffset, byteOffset);
    assert.equal(db.$client.prepare("PRAGMA journal_mode").get()?.["journal_mode"], "wal");
    assert.equal(db.$client.prepare("PRAGMA synchronous").get()?.["synchronous"], 1);
    assert.equal(db.$client.prepare("PRAGMA foreign_keys").get()?.["foreign_keys"], 1);
    assert.equal(
      db.$client.prepare("SELECT count(*) AS count FROM __migrations").get()?.["count"],
      1,
    );
    db.$client.close();

    const reopened = openDatabase(path);
    assert.equal(
      reopened.$client.prepare("SELECT count(*) AS count FROM __migrations").get()?.["count"],
      1,
    );
    reopened.$client.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
