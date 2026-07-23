import { query } from "$app/server";

import { openDatabase } from "$lib/server/db/database";
import { liveSnapshots } from "$lib/server/live-query";
import { AeyeReadModel } from "$lib/server/read-model";

function readOverview() {
  const db = openDatabase();
  try {
    const readModel = new AeyeReadModel(db);
    const projects = readModel.listProjects().map(({ id, name, sessionCount, tokens }) => ({
      id,
      name,
      sessionCount,
      tokens: tokens.total,
    }));
    return { overview: readModel.overview(), projects };
  } finally {
    db.$client.close();
  }
}

export const getOverview = query.live(() => liveSnapshots(readOverview));
