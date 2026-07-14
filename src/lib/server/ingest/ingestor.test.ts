import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { eq } from "drizzle-orm";

import { openDatabase } from "../db/database.ts";
import { annotations, files, sessionStats, toolCalls } from "../db/schema.ts";
import { ClaudeIngestor } from "./ingestor.ts";

function jsonLine(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

function userEvent(sessionId: string, cwd: string, uuid: string, timestamp: string) {
  return {
    type: "user",
    sessionId,
    cwd,
    uuid,
    timestamp,
    message: { role: "user", content: "PRIVATE_USER_BODY" },
  };
}

function eventDump(db: ReturnType<typeof openDatabase>) {
  return JSON.stringify(db.$client.prepare("SELECT * FROM events ORDER BY id").all());
}

await test("scans, resumes, rewrites, and deterministically reindexes Claude sessions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aeye-ingestor-"));
  const root = join(directory, "projects");
  const projectSource = join(root, "-tmp-working-project");
  const cwd = join(directory, "working-project");
  const mainPath = join(projectSource, "session-main.jsonl");
  const agentDirectory = join(projectSource, "session-main", "subagents");
  const agentPath = join(agentDirectory, "agent-abc.jsonl");
  mkdirSync(agentDirectory, { recursive: true });

  const snapshot = jsonLine({ type: "file-history-snapshot", snapshot: "PRIVATE_SNAPSHOT" });
  const firstUser = jsonLine(userEvent("session-main", cwd, "user-1", "2026-07-14T10:00:00.000Z"));
  const assistant = jsonLine({
    type: "assistant",
    sessionId: "session-main",
    cwd,
    uuid: "assistant-1",
    parentUuid: "user-1",
    timestamp: "2026-07-14T10:00:01.000Z",
    message: {
      role: "assistant",
      model: "claude-test",
      usage: { input_tokens: 10, output_tokens: 20 },
      content: [
        {
          type: "tool_use",
          id: "tool-use-1",
          name: "Read",
          input: { file_path: "/tmp/private.ts", ignored: "PRIVATE_TOOL_INPUT" },
        },
      ],
    },
  });
  const partialQueueOperation = JSON.stringify({
    type: "queue-operation",
    sessionId: "session-main",
    operation: "enqueue",
    content: "PRIVATE_QUEUE_CONTENT",
  });
  writeFileSync(mainPath, snapshot + firstUser + assistant + partialQueueOperation);

  writeFileSync(
    agentPath,
    jsonLine({
      ...userEvent("session-main", cwd, "agent-user", "2026-07-14T10:00:02.000Z"),
      agentId: "agent-abc",
      isSidechain: true,
    }) +
      jsonLine({
        type: "assistant",
        sessionId: "session-main",
        cwd,
        uuid: "agent-assistant",
        parentUuid: "agent-user",
        timestamp: "2026-07-14T10:00:03.000Z",
        isSidechain: true,
        message: { role: "assistant", model: "claude-test", content: [] },
      }),
  );

  const db = openDatabase(join(directory, "test.sqlite"));
  const ingestor = new ClaudeIngestor(db, { root, batchSize: 2 });
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
        discoveredFiles: 2,
        queuedFiles: 2,
        processedFiles: 2,
        insertedEvents: 5,
        failedFiles: 0,
      },
    );
    assert.equal(db.$client.prepare("SELECT count(*) AS count FROM events").get()?.["count"], 5);
    assert.equal(db.$client.prepare("SELECT count(*) AS count FROM sessions").get()?.["count"], 2);

    const project = db.query.projects.findFirst().sync();
    assert.equal(project?.sourcePath, projectSource);
    assert.equal(project?.path, cwd);
    const child = db.query.sessions
      .findFirst({ where: { id: "session-main:agent:agent-abc" } })
      .sync();
    assert.equal(child?.parentId, "session-main");
    assert.equal(child?.agentId, "agent-abc");

    const mainFile = db.query.files.findFirst({ where: { path: mainPath } }).sync();
    assert.ok(mainFile);
    assert.equal(mainFile.parsedOffset, Buffer.byteLength(snapshot + firstUser + assistant));
    assert.equal(
      mainFile.size,
      Buffer.byteLength(snapshot + firstUser + assistant + partialQueueOperation),
    );

    const noOp = await ingestor.scan();
    assert.equal(noOp.queuedFiles, 0);
    assert.equal(noOp.processedFiles, 0);
    assert.equal(noOp.insertedEvents, 0);

    appendFileSync(mainPath, "\n");
    const completedTail = await ingestor.scan();
    assert.equal(completedTail.insertedEvents, 1);
    assert.equal(db.$client.prepare("SELECT count(*) AS count FROM events").get()?.["count"], 6);

    db.update(files)
      .set({ parsedOffset: 0, mtimeMs: 0, size: 0 })
      .where(eq(files.id, mainFile.id))
      .run();
    ingestor.enqueue(mainPath);
    const replay = await ingestor.drain();
    assert.equal(replay.insertedEvents, 0);
    assert.equal(db.$client.prepare("SELECT count(*) AS count FROM events").get()?.["count"], 6);

    const sourceEvent = db.query.events.findFirst({ where: { sessionId: "session-main" } }).sync();
    assert.ok(sourceEvent);
    db.insert(toolCalls)
      .values({
        sessionId: "session-main",
        sourceEventId: sourceEvent.id,
        toolUseId: "derived-tool",
        name: "Read",
      })
      .run();
    db.insert(annotations)
      .values({ sessionId: "session-main", kind: "skill", value: "test", createdAt: Date.now() })
      .run();
    db.insert(sessionStats).values({ sessionId: "session-main", updatedAt: Date.now() }).run();

    writeFileSync(
      mainPath,
      jsonLine(userEvent("session-main", cwd, "rewritten-user", "2026-07-14T11:00:00.000Z")),
    );
    const rewrite = await ingestor.scan();
    assert.equal(rewrite.rewrittenFiles, 1);
    assert.equal(rewrite.insertedEvents, 1);
    assert.equal(
      db.$client
        .prepare("SELECT count(*) AS count FROM events WHERE session_id = ?")
        .get("session-main")?.["count"],
      1,
    );
    assert.equal(
      db.$client.prepare("SELECT count(*) AS count FROM tool_calls").get()?.["count"],
      0,
    );
    assert.equal(
      db.$client.prepare("SELECT count(*) AS count FROM annotations").get()?.["count"],
      0,
    );
    assert.equal(
      db.$client.prepare("SELECT count(*) AS count FROM session_stats").get()?.["count"],
      0,
    );

    const firstReindex = await ingestor.reindex();
    assert.equal(firstReindex.insertedEvents, 3);
    const firstDump = eventDump(db);
    const secondReindex = await ingestor.reindex();
    assert.equal(secondReindex.insertedEvents, 3);
    assert.equal(eventDump(db), firstDump);
    assert.deepEqual(errors, []);
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
