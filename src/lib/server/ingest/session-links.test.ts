import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../db/database.ts";
import { events, files, projects, sessions, toolCalls } from "../db/schema.ts";
import { deriveSessionLinks } from "./session-links.ts";

interface RawEvent {
  value: unknown;
  sessionId: string;
  timestampMs: number;
}

function toolUse(toolUseId: string, command: string) {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command } }],
    },
  };
}

function toolResult(toolUseId: string, content: string) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
    },
  };
}

function insertRawEvents(
  db: ReturnType<typeof openDatabase>,
  directory: string,
  projectId: number,
  name: string,
  rawEvents: RawEvent[],
) {
  const path = join(directory, name);
  const encoded = rawEvents.map(({ value }) => Buffer.from(`${JSON.stringify(value)}\n`));
  writeFileSync(path, Buffer.concat(encoded));
  const file = db
    .insert(files)
    .values({
      projectId,
      sessionId: rawEvents[0]?.sessionId ?? null,
      path,
      mtimeMs: 0,
      size: encoded.reduce((total, value) => total + value.length, 0),
      parsedOffset: encoded.reduce((total, value) => total + value.length, 0),
    })
    .returning()
    .get();

  let byteOffset = 0;
  return rawEvents.map((rawEvent, seq) => {
    const byteLength = encoded[seq]?.length ?? 0;
    const event = db
      .insert(events)
      .values({
        fileId: file.id,
        sessionId: rawEvent.sessionId,
        seq,
        byteOffset,
        byteLength,
        timestampMs: rawEvent.timestampMs,
        kind: seq % 2 === 0 ? "assistant" : "user",
        type: seq % 2 === 0 ? "assistant" : "user",
      })
      .returning()
      .get();
    byteOffset += byteLength;
    return event;
  });
}

await test("derives provider-neutral links from thread IDs, background jobs, and unique task windows", () => {
  const directory = mkdtempSync(join(tmpdir(), "aeye-session-links-"));
  const db = openDatabase(join(directory, "test.sqlite"));
  const cwd = join(directory, "work");
  const threadFromJob = "019f32b6-2c19-7fc3-bac0-5c2ae3b84401";
  const threadFromWindow = "019f6176-0b95-7961-9188-0e025125a52c";
  const threadDirect = "019f6093-8e44-79c3-a556-601e2e4d6d5e";
  const ambiguousOne = "019f617f-189d-7692-aadf-344985c53997";
  const ambiguousTwo = "019f61a1-7772-78d1-a935-5174aac5f2c5";

  try {
    const project = db
      .insert(projects)
      .values({ path: cwd, name: "work", createdAt: 1, updatedAt: 1 })
      .returning()
      .get();
    db.insert(sessions)
      .values([
        { id: "claude-root", sourceSessionId: "claude-root", projectId: project.id, cwd },
        {
          id: "claude-agent-job",
          sourceSessionId: "claude-root",
          projectId: project.id,
          parentId: "claude-root",
          agentId: "agent-job",
          cwd,
        },
        {
          id: "claude-agent-window",
          sourceSessionId: "claude-root",
          projectId: project.id,
          parentId: "claude-root",
          agentId: "agent-window",
          cwd,
        },
        {
          id: "claude-agent-direct",
          sourceSessionId: "claude-root",
          projectId: project.id,
          parentId: "claude-root",
          agentId: "agent-direct",
          cwd,
        },
        ...[
          [threadFromJob, 2_500],
          [threadFromWindow, 11_500],
          [threadDirect, 30_500],
          [ambiguousOne, 41_500],
          [ambiguousTwo, 41_600],
        ].map(([threadId, startedAt]) => ({
          id: `codex:${threadId}`,
          sourceSessionId: String(threadId),
          projectId: project.id,
          source: "codex" as const,
          clientName: "Claude Code",
          cwd,
          startedAt: Number(startedAt),
        })),
      ])
      .run();

    const jobEvents = insertRawEvents(db, directory, project.id, "job.jsonl", [
      {
        value: toolUse(
          "task-job",
          "node /plugin/scripts/codex-companion.mjs task --background 'PRIVATE_JOB_PROMPT'",
        ),
        sessionId: "claude-agent-job",
        timestampMs: 1_000,
      },
      {
        value: toolResult("task-job", "Codex Task started as task-test-job."),
        sessionId: "claude-agent-job",
        timestampMs: 2_000,
      },
    ]);
    const statusEvents = insertRawEvents(db, directory, project.id, "status.jsonl", [
      {
        value: toolUse(
          "status-job",
          "node /plugin/scripts/codex-companion.mjs status --wait task-test-job",
        ),
        sessionId: "claude-root",
        timestampMs: 3_000,
      },
      {
        value: toolResult("status-job", `Thread ready (${threadFromJob}). PRIVATE_RESULT`),
        sessionId: "claude-root",
        timestampMs: 4_000,
      },
    ]);
    const windowEvents = insertRawEvents(db, directory, project.id, "window.jsonl", [
      {
        value: toolUse(
          "task-window",
          "node /plugin/scripts/codex-companion.mjs task --background 'PRIVATE_WINDOW_PROMPT'",
        ),
        sessionId: "claude-agent-window",
        timestampMs: 10_000,
      },
      {
        value: toolResult("task-window", "Task queued."),
        sessionId: "claude-agent-window",
        timestampMs: 11_000,
      },
    ]);
    const directEvents = insertRawEvents(db, directory, project.id, "direct.jsonl", [
      {
        value: toolUse(
          "task-direct",
          "node /plugin/scripts/codex-companion.mjs task 'PRIVATE_DIRECT_PROMPT'",
        ),
        sessionId: "claude-agent-direct",
        timestampMs: 30_000,
      },
      {
        value: toolResult("task-direct", `Thread ready (${threadDirect}). PRIVATE_RESULT`),
        sessionId: "claude-agent-direct",
        timestampMs: 31_000,
      },
      {
        value: toolUse(
          "task-ambiguous",
          "node /plugin/scripts/codex-companion.mjs task --background 'PRIVATE_AMBIGUOUS_PROMPT'",
        ),
        sessionId: "claude-agent-direct",
        timestampMs: 40_000,
      },
      {
        value: toolResult("task-ambiguous", "Task queued."),
        sessionId: "claude-agent-direct",
        timestampMs: 41_000,
      },
    ]);

    db.insert(toolCalls)
      .values([
        {
          sessionId: "claude-agent-job",
          sourceEventId: jobEvents[0]!.id,
          resultEventId: jobEvents[1]!.id,
          toolUseId: "task-job",
          name: "Bash",
          startedAt: 1_000,
          endedAt: 2_000,
        },
        {
          sessionId: "claude-root",
          sourceEventId: statusEvents[0]!.id,
          resultEventId: statusEvents[1]!.id,
          toolUseId: "status-job",
          name: "Bash",
          startedAt: 3_000,
          endedAt: 4_000,
        },
        {
          sessionId: "claude-agent-window",
          sourceEventId: windowEvents[0]!.id,
          resultEventId: windowEvents[1]!.id,
          toolUseId: "task-window",
          name: "Bash",
          startedAt: 10_000,
          endedAt: 11_000,
        },
        {
          sessionId: "claude-agent-direct",
          sourceEventId: directEvents[0]!.id,
          resultEventId: directEvents[1]!.id,
          toolUseId: "task-direct",
          name: "Bash",
          startedAt: 30_000,
          endedAt: 31_000,
        },
        {
          sessionId: "claude-agent-direct",
          sourceEventId: directEvents[2]!.id,
          resultEventId: directEvents[3]!.id,
          toolUseId: "task-ambiguous",
          name: "Bash",
          startedAt: 40_000,
          endedAt: 41_000,
        },
      ])
      .run();

    assert.deepEqual(deriveSessionLinks(db), {
      pluginCalls: 5,
      links: 3,
      threadIdLinks: 1,
      jobIdLinks: 1,
      timeWindowLinks: 1,
    });
    const firstDump = JSON.stringify(
      db.$client.prepare("SELECT * FROM session_links ORDER BY id").all(),
    );
    assert.deepEqual(JSON.parse(firstDump), [
      {
        id: 1,
        source_session_id: "claude-agent-job",
        target_session_id: `codex:${threadFromJob}`,
        source_event_id: jobEvents[0]!.id,
        kind: "delegate",
        method: "job_id",
        created_at: 1_000,
      },
      {
        id: 2,
        source_session_id: "claude-agent-window",
        target_session_id: `codex:${threadFromWindow}`,
        source_event_id: windowEvents[0]!.id,
        kind: "delegate",
        method: "time_window",
        created_at: 10_000,
      },
      {
        id: 3,
        source_session_id: "claude-agent-direct",
        target_session_id: `codex:${threadDirect}`,
        source_event_id: directEvents[0]!.id,
        kind: "delegate",
        method: "thread_id",
        created_at: 30_000,
      },
    ]);
    assert.equal(firstDump.includes("PRIVATE"), false);
    assert.equal(firstDump.includes("task-test-job"), false);
    deriveSessionLinks(db);
    assert.equal(
      JSON.stringify(db.$client.prepare("SELECT * FROM session_links ORDER BY id").all()),
      firstDump,
    );
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
