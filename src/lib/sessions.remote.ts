import { error } from "@sveltejs/kit";
import { query } from "$app/server";

import type { StandardSchema } from "$lib/remote-schema";
import { openDatabase } from "$lib/server/db/database";
import { AeyeReadModel } from "$lib/server/read-model";

const graphNodeLimit = 500;

const sessionIdSchema: StandardSchema<string, string> = {
  "~standard": {
    version: 1,
    vendor: "aeye",
    validate(value) {
      if (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= 512 &&
        value.trim() === value &&
        !value.includes("/") &&
        !value.includes("\0")
      ) {
        return { value };
      }
      return { issues: [{ message: "Session ID is invalid" }] };
    },
  },
};

export const getSession = query(sessionIdSchema, (sessionId) => {
  const db = openDatabase();
  try {
    const detail = new AeyeReadModel(db).getSession(sessionId);
    if (!detail) error(404, "Session not found");

    const conversationNodes = detail.graph.nodes.filter(({ uuid }) => uuid !== null);
    const nodes = conversationNodes.slice(-graphNodeLimit).map((node) => ({
      eventId: node.eventId,
      seq: node.seq,
      kind: node.kind,
      model: node.model,
      totalTokens: node.totalTokens,
      isSidechain: node.isSidechain,
      isUsageDuplicate: node.isUsageDuplicate,
      isDeadBranch: node.isDeadBranch,
      isMeta: node.isMeta,
      isInterrupt: node.isInterrupt,
    }));
    const eventIds = new Set(nodes.map(({ eventId }) => eventId));
    const edges = detail.graph.edges.filter(
      ({ sourceEventId, targetEventId }) =>
        eventIds.has(sourceEventId) && eventIds.has(targetEventId),
    );

    return {
      summary: {
        projectId: detail.summary.projectId,
        projectName: detail.summary.projectName,
        parentId: detail.summary.parentId,
        isSubagent: detail.summary.agentId !== null,
        claudeVersion: detail.summary.claudeVersion,
        userTurns: detail.summary.userTurns,
        assistantTurns: detail.summary.assistantTurns,
        toolCalls: detail.summary.toolCalls,
        startedAt: detail.summary.startedAt,
        durationMs: detail.summary.durationMs,
        tokens: detail.summary.tokens,
        costUsd: detail.summary.costUsd,
      },
      models: detail.models.map(({ model, tokens }) => ({ model, tokens })),
      tools: detail.tools.map(
        ({ name, calls, completed, errors, interrupted, p50DurationMs, p95DurationMs }) => ({
          name,
          calls,
          completed,
          errors,
          interrupted,
          p50DurationMs,
          p95DurationMs,
        }),
      ),
      graph: {
        totalNodes: conversationNodes.length,
        totalEdges: detail.graph.edges.length,
        auxiliaryEvents: detail.graph.nodes.length - conversationNodes.length,
        nodes,
        edges,
      },
    };
  } finally {
    db.$client.close();
  }
});
