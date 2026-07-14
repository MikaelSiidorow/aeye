import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";

import { env } from "../env.ts";
import { relations } from "./schema.ts";

const migrationsFolder = fileURLToPath(new URL("../../../../drizzle", import.meta.url));

export function openDatabase(path = env.databasePath) {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const client = new DatabaseSync(path);
  client.exec("PRAGMA journal_mode = WAL");
  client.exec("PRAGMA synchronous = NORMAL");
  client.exec("PRAGMA foreign_keys = ON");

  const db = drizzle({ client, relations });
  migrate(db, { migrationsFolder, migrationsTable: "__migrations" });
  return db;
}

export type Database = ReturnType<typeof openDatabase>;
