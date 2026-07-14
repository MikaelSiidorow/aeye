import { parseArgs } from "node:util";

import { openDatabase } from "../src/lib/server/db/database.ts";
import { env } from "../src/lib/server/env.ts";

const { positionals } = parseArgs({ allowPositionals: true });
if (positionals.length > 1) {
  throw new Error("Usage: npm run migrate -- [database-path]");
}

const databasePath = positionals[0] ?? env.databasePath;
const db = openDatabase(databasePath);
db.$client.close();

console.log(`Database migrated: ${databasePath}`);
