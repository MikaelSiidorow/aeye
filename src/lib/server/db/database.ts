import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { drizzle } from "drizzle-orm/node-sqlite";
import { migrateSync } from "drizzle-orm/sqlite-core";

import { env } from "../env.ts";
import { migrations } from "./migrations.generated.ts";
import { relations } from "./schema.ts";

export function openDatabase(path = env.databasePath) {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const client = new DatabaseSync(path);
  client.exec("PRAGMA journal_mode = WAL");
  client.exec("PRAGMA synchronous = NORMAL");
  client.exec("PRAGMA foreign_keys = ON");

  const db = drizzle({ client, relations });
  migrateSync(migrations, db._.session, {
    migrationsTable: "__migrations",
  });
  return db;
}

export type Database = ReturnType<typeof openDatabase>;
