import { error } from "@sveltejs/kit";
import { command, getRequestEvent, query } from "$app/server";

import type { StandardSchema } from "$lib/remote-schema";
import { openDatabase } from "$lib/server/db/database";
import { liveSnapshots } from "$lib/server/live-query";
import { AeyeReadModel } from "$lib/server/read-model";
import {
  createResumeDescriptor,
  isLoopbackAddress,
  launchResumeSession,
  resumeAvailability,
  ResumeLaunchError,
} from "$lib/server/resume";

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

function resumePayload(session: Parameters<typeof createResumeDescriptor>[0]) {
  const descriptor = createResumeDescriptor(session);
  if (descriptor === null) return null;
  const availability = resumeAvailability(descriptor);
  return {
    label: descriptor.label,
    command: descriptor.command,
    resumesParent: descriptor.resumesParent,
    canLaunch: availability.canLaunch,
    terminal: availability.terminal,
    unavailableReason: availability.reason,
  };
}

function readSession(sessionId: string) {
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
        source: detail.summary.source,
        clientName: detail.summary.clientName,
        clientVersion: detail.summary.clientVersion,
        claudeVersion: detail.summary.claudeVersion,
        userTurns: detail.summary.userTurns,
        assistantTurns: detail.summary.assistantTurns,
        toolCalls: detail.summary.toolCalls,
        startedAt: detail.summary.startedAt,
        durationMs: detail.summary.durationMs,
        tokens: detail.summary.tokens,
        costUsd: detail.summary.costUsd,
      },
      resume: resumePayload(detail.summary),
      links: detail.links.map(({ id, direction, kind, method, related }) => ({
        id,
        direction,
        kind,
        method,
        related: {
          id: related.id,
          projectId: related.projectId,
          projectName: related.projectName,
          parentId: related.parentId,
          isSubagent: related.agentId !== null,
          source: related.source,
          clientName: related.clientName,
          clientVersion: related.clientVersion,
          startedAt: related.startedAt,
        },
      })),
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
}

export const getSession = query.live(sessionIdSchema, (sessionId) =>
  liveSnapshots(
    () => readSession(sessionId),
    ({ sessionIds }) => sessionIds.includes(sessionId),
  ),
);

export const launchSession = command(sessionIdSchema, async (sessionId) => {
  const request = getRequestEvent();
  if (!isLoopbackAddress(request.getClientAddress())) {
    error(403, "Session launch is only available from this computer.");
  }

  const db = openDatabase();
  try {
    const detail = new AeyeReadModel(db).getSession(sessionId);
    if (!detail) error(404, "Session not found");
    const descriptor = createResumeDescriptor(detail.summary);
    if (descriptor === null) {
      error(409, "This session does not have valid resume metadata.");
    }

    try {
      return await launchResumeSession(descriptor);
    } catch (cause) {
      if (cause instanceof ResumeLaunchError) error(409, cause.message);
      error(500, "The terminal could not be opened.");
    }
  } finally {
    db.$client.close();
  }
});
