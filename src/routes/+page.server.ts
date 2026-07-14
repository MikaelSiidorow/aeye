import { openDatabase } from "$lib/server/db/database";
import { AeyeReadModel } from "$lib/server/read-model";

export function load() {
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
