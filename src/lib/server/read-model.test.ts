import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "./db/database.ts";
import { annotations, sessionLinks } from "./db/schema.ts";
import { ClaudeIngestor } from "./ingest/ingestor.ts";
import { AeyeReadModel } from "./read-model.ts";

function line(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

function toolResult(
  sessionId: string,
  cwd: string,
  uuid: string,
  parentUuid: string,
  timestamp: string,
  toolUseId: string,
) {
  return {
    type: "user",
    sessionId,
    cwd,
    uuid,
    parentUuid,
    timestamp,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "PRIVATE_RESULT" }],
    },
  };
}

await test("queries active project, session, usage, tool, and graph read models", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aeye-read-model-"));
  const root = join(directory, "projects");
  const project = join(root, "project-a");
  const cwd = join(directory, "work-a");
  const mainPath = join(project, "session.jsonl");
  const agentDirectory = join(project, "session", "subagents");
  const agentPath = join(agentDirectory, "agent-worker.jsonl");
  mkdirSync(agentDirectory, { recursive: true });

  const rootEvent = {
    type: "user",
    sessionId: "session",
    cwd,
    uuid: "root",
    timestamp: "2026-07-14T10:00:00.000Z",
    message: { role: "user", content: "PRIVATE_PROMPT" },
  };
  const toolEvent = {
    type: "assistant",
    sessionId: "session",
    cwd,
    uuid: "tools",
    parentUuid: "root",
    timestamp: "2026-07-14T10:00:01.000Z",
    requestId: "request-tools",
    message: {
      id: "message-tools",
      role: "assistant",
      model: "claude-fable",
      usage: {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
      content: [1, 2, 3, 4].map((number) => ({
        type: "tool_use",
        id: `tool-${number}`,
        name: "Read",
        input: { file_path: `/tmp/private-${number}.ts`, secret: "PRIVATE_TOOL_INPUT" },
      })),
    },
  };
  writeFileSync(
    mainPath,
    line(rootEvent) +
      line({
        type: "ai-title",
        sessionId: "session",
        aiTitle: "Read model session",
      }) +
      line(toolEvent) +
      line(toolResult("session", cwd, "result-1", "tools", "2026-07-14T10:00:01.100Z", "tool-1")) +
      line(
        toolResult("session", cwd, "result-2", "result-1", "2026-07-14T10:00:01.200Z", "tool-2"),
      ) +
      line(
        toolResult("session", cwd, "result-3", "result-2", "2026-07-14T10:00:01.300Z", "tool-3"),
      ) +
      line(
        toolResult("session", cwd, "result-4", "result-3", "2026-07-14T10:00:01.400Z", "tool-4"),
      ) +
      line({
        type: "assistant",
        sessionId: "session",
        cwd,
        uuid: "dead",
        parentUuid: "root",
        timestamp: "2026-07-14T10:00:01.500Z",
        requestId: "request-dead",
        message: {
          id: "message-dead",
          role: "assistant",
          model: "claude-sonnet",
          usage: { input_tokens: 100, output_tokens: 100 },
          content: "PRIVATE_DEAD_ANSWER",
        },
      }) +
      line({
        type: "assistant",
        sessionId: "session",
        cwd,
        uuid: "active",
        parentUuid: "result-4",
        timestamp: "2026-07-14T10:00:02.000Z",
        requestId: "request-active",
        message: {
          id: "message-active",
          role: "assistant",
          model: "claude-fable",
          usage: {
            input_tokens: 5,
            output_tokens: 7,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 4,
          },
          content: "PRIVATE_ACTIVE_ANSWER",
        },
      }),
  );
  writeFileSync(
    join(agentDirectory, "agent-worker.meta.json"),
    JSON.stringify({ description: "Research delegated task" }),
  );
  writeFileSync(
    agentPath,
    line({
      ...toolEvent,
      uuid: "tools-replay",
      requestId: "request-sidechain-replay",
      isSidechain: true,
      message: {
        ...toolEvent.message,
        usage: { input_tokens: 1_000, output_tokens: 1_000 },
      },
    }) +
      line({
        type: "assistant",
        sessionId: "session",
        cwd,
        uuid: "agent-active",
        parentUuid: "tools-replay",
        timestamp: "2026-07-14T10:00:03.000Z",
        requestId: "request-agent",
        isSidechain: true,
        message: {
          id: "message-agent",
          role: "assistant",
          model: "claude-sonnet",
          usage: { input_tokens: 2, output_tokens: 3 },
          content: "PRIVATE_AGENT_ANSWER",
        },
      }),
  );

  const db = openDatabase(join(directory, "test.sqlite"));
  try {
    const ingest = await new ClaudeIngestor(db, { root }).scan();
    assert.equal(ingest.insertedEvents, 11);
    db.insert(sessionLinks)
      .values({
        sourceSessionId: "session",
        targetSessionId: "session:agent:agent-worker",
        kind: "delegate",
        method: "thread_id",
        createdAt: Date.parse("2026-07-14T10:00:01.000Z"),
      })
      .run();
    const annotationEvent = db.query.events
      .findFirst({ where: { sessionId: "session", seq: 2 } })
      .sync();
    assert.ok(annotationEvent);
    db.insert(annotations)
      .values({
        sessionId: "session",
        eventId: annotationEvent.id,
        kind: "skill",
        value: "deep-research",
        createdAt: Date.parse("2026-07-14T10:00:01.000Z"),
      })
      .run();
    const readModel = new AeyeReadModel(db);

    assert.deepEqual(readModel.overview(), {
      projectCount: 1,
      sessionCount: 2,
      rootSessionCount: 1,
      subagentSessionCount: 1,
      userTurns: 1,
      assistantTurns: 3,
      toolCalls: 4,
      startedAt: Date.parse("2026-07-14T10:00:00.000Z"),
      endedAt: Date.parse("2026-07-14T10:00:03.000Z"),
      tokens: {
        input: 17,
        output: 30,
        cacheRead: 33,
        cacheWrite: 44,
        total: 124,
        deadBranch: 200,
      },
      costUsd: 0,
    });

    const projects = readModel.listProjects();
    assert.equal(projects.length, 1);
    assert.equal(projects[0]?.name, "work-a");
    assert.equal(projects[0]?.path, cwd);
    assert.equal(projects[0]?.tokens.total, 124);
    assert.equal(projects[0]?.tokens.deadBranch, 200);

    const sessions = readModel.listSessions();
    assert.deepEqual(
      sessions.map(({ id }) => id),
      ["session:agent:agent-worker", "session"],
    );
    assert.equal(readModel.listSessions({ projectId: projects[0]?.id }).length, 2);
    assert.deepEqual(
      readModel.listSessions({ limit: 1, offset: 1 }).map(({ id }) => id),
      ["session"],
    );

    assert.deepEqual(readModel.usageByDay({ timeZone: "Europe/Berlin" }), [
      {
        date: "2026-07-14",
        tokens: { input: 17, output: 30, cacheRead: 33, cacheWrite: 44, total: 124 },
      },
    ]);
    assert.deepEqual(readModel.usageByModel(), [
      {
        model: "claude-fable",
        sessionCount: 1,
        tokens: { input: 15, output: 27, cacheRead: 33, cacheWrite: 44, total: 119 },
      },
      {
        model: "claude-sonnet",
        sessionCount: 1,
        tokens: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, total: 5 },
      },
    ]);
    assert.deepEqual(readModel.toolUsage(), [
      {
        name: "Read",
        calls: 4,
        completed: 4,
        errors: 0,
        interrupted: 0,
        unmatched: 0,
        pending: 0,
        durationSamples: 4,
        averageDurationMs: 250,
        p50DurationMs: 250,
        p95DurationMs: 385,
      },
    ]);

    const detail = readModel.getSession("session");
    assert.ok(detail);
    assert.equal(detail.summary.displayName, "Read model session");
    assert.equal(detail.parent, null);
    assert.equal(detail.summary.tokens.total, 119);
    assert.equal(detail.summary.tokens.deadBranch, 200);
    assert.equal(detail.graph.nodes.length, 9);
    assert.equal(detail.graph.edges.length, 7);
    assert.equal(detail.graph.nodes.filter(({ isDeadBranch }) => isDeadBranch).length, 1);
    assert.equal(detail.graph.nodes.filter(({ isUsageDuplicate }) => isUsageDuplicate).length, 0);
    assert.equal(detail.models.length, 1);
    assert.equal(detail.tools[0]?.calls, 4);
    assert.deepEqual(
      detail.annotations.map(({ id: _id, ...annotation }) => annotation),
      [
        {
          eventId: annotationEvent.id,
          kind: "skill",
          value: "deep-research",
          createdAt: Date.parse("2026-07-14T10:00:01.000Z"),
        },
      ],
    );
    assert.equal(detail.links.length, 1);
    assert.equal(detail.links[0]?.direction, "outgoing");
    assert.equal(detail.links[0]?.related.id, "session:agent:agent-worker");
    assert.equal(detail.links[0]?.related.displayName, "Research delegated task");

    const agent = readModel.getSession("session:agent:agent-worker");
    assert.ok(agent);
    assert.equal(agent.summary.displayName, "Research delegated task");
    assert.equal(agent.parent?.displayName, "Read model session");
    assert.equal(agent.summary.tokens.total, 5);
    assert.equal(agent.graph.nodes.filter(({ isUsageDuplicate }) => isUsageDuplicate).length, 1);
    assert.equal(agent.links.length, 1);
    assert.equal(agent.links[0]?.direction, "incoming");
    assert.equal(agent.links[0]?.related.id, "session");
    assert.equal(readModel.getSession("missing"), null);

    const serialized = JSON.stringify({ projects, sessions, detail, agent });
    for (const privateValue of [
      "PRIVATE_PROMPT",
      "PRIVATE_RESULT",
      "PRIVATE_TOOL_INPUT",
      "PRIVATE_DEAD_ANSWER",
      "PRIVATE_ACTIVE_ANSWER",
      "PRIVATE_AGENT_ANSWER",
    ]) {
      assert.equal(serialized.includes(privateValue), false);
    }
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("validates read model filters", () => {
  const directory = mkdtempSync(join(tmpdir(), "aeye-read-model-validation-"));
  const db = openDatabase(join(directory, "test.sqlite"));
  try {
    const readModel = new AeyeReadModel(db);
    assert.deepEqual(readModel.overview(), {
      projectCount: 0,
      sessionCount: 0,
      rootSessionCount: 0,
      subagentSessionCount: 0,
      userTurns: 0,
      assistantTurns: 0,
      toolCalls: 0,
      startedAt: null,
      endedAt: null,
      tokens: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        deadBranch: 0,
      },
      costUsd: 0,
    });
    assert.throws(() => readModel.listSessions({ projectId: 0 }), RangeError);
    assert.throws(() => readModel.listSessions({ limit: 501 }), RangeError);
    assert.throws(() => readModel.listSessions({ offset: -1 }), RangeError);
    assert.throws(() => readModel.usageByDay({ timeZone: "not/a-time-zone" }), RangeError);
    assert.throws(() => readModel.usageByModel({ sessionId: "" }), RangeError);
    assert.throws(() => readModel.toolUsage({ sessionId: "" }), RangeError);
    assert.throws(() => readModel.getSessionGraph(""), RangeError);
    assert.throws(() => readModel.getSessionAnnotations(""), RangeError);
    assert.throws(() => readModel.getSessionSummary(""), RangeError);
  } finally {
    db.$client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
