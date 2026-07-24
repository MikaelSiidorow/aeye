import { error } from "@sveltejs/kit";
import { query } from "$app/server";

import type { StandardSchema } from "$lib/remote-schema";
import { openDatabase } from "$lib/server/db/database";
import { liveSnapshots } from "$lib/server/live-query";
import { AeyeReadModel } from "$lib/server/read-model";

const projectIdSchema: StandardSchema<string, number> = {
  "~standard": {
    version: 1,
    vendor: "aeye",
    validate(value) {
      if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
        const projectId = Number(value);
        if (Number.isSafeInteger(projectId)) return { value: projectId };
      }
      return { issues: [{ message: "Project ID must be a positive integer" }] };
    },
  },
};

function readProject(projectId: number) {
  const db = openDatabase();
  try {
    const readModel = new AeyeReadModel(db);
    const project = readModel.listProjects().find(({ id }) => id === projectId);
    if (!project) error(404, "Project not found");

    const hierarchy = readModel.getProjectSessionHierarchy(projectId);
    const relationshipBySessionId = new Map(
      hierarchy.relationships.map((relationship) => [relationship.sessionId, relationship]),
    );
    const sessions = readModel.listSessions({ projectId, limit: 100 }).map((session) => ({
      relationship: relationshipBySessionId.get(session.id)?.kind ?? null,
      presentationParentId: relationshipBySessionId.get(session.id)?.parentSessionId ?? null,
      id: session.id,
      displayName: session.displayName,
      isSubagent: session.agentId !== null,
      source: session.source,
      userTurns: session.userTurns,
      assistantTurns: session.assistantTurns,
      toolCalls: session.toolCalls,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      tokens: session.tokens.total,
    }));

    return {
      name: project.name,
      sessionCount: project.sessionCount,
      topLevelSessionCount: hierarchy.topLevelSessionCount,
      nestedSessionCount: hierarchy.nestedSessionCount,
      toolCalls: project.toolCalls,
      tokens: {
        total: project.tokens.total,
        deadBranch: project.tokens.deadBranch,
      },
      sessions,
    };
  } finally {
    db.$client.close();
  }
}

export const getProject = query.live(projectIdSchema, (projectId) =>
  liveSnapshots(
    () => readProject(projectId),
    ({ projectIds }) => projectIds.includes(projectId),
  ),
);
