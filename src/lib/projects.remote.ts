import { error } from "@sveltejs/kit";
import { query } from "$app/server";

import type { StandardSchema } from "$lib/remote-schema";
import { openDatabase } from "$lib/server/db/database";
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

export const getProject = query(projectIdSchema, (projectId) => {
  const db = openDatabase();
  try {
    const readModel = new AeyeReadModel(db);
    const project = readModel.listProjects().find(({ id }) => id === projectId);
    if (!project) error(404, "Project not found");

    const sessions = readModel.listSessions({ projectId, limit: 100 }).map((session) => ({
      id: session.id,
      parentId: session.parentId,
      isSubagent: session.agentId !== null,
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
      rootSessionCount: project.rootSessionCount,
      subagentSessionCount: project.subagentSessionCount,
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
});
