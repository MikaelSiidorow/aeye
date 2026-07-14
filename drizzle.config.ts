import { defineConfig } from "drizzle-kit";

import { env } from "./src/lib/server/env.ts";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/lib/server/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    url: env.databasePath,
  },
});
