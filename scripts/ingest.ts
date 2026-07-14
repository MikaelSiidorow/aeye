import { parseArgs } from "node:util";

import { openDatabase } from "../src/lib/server/db/database.ts";
import { env } from "../src/lib/server/env.ts";
import { ClaudeIngestor, type IngestErrorEvent } from "../src/lib/server/ingest/ingestor.ts";
import { startClaudeWatcher } from "../src/lib/server/ingest/watcher.ts";

const { values } = parseArgs({
  options: {
    database: { type: "string", short: "d" },
    root: { type: "string" },
    reindex: { type: "boolean", default: false },
    watch: { type: "boolean", default: false },
  },
});

const db = openDatabase(values.database ?? env.databasePath);
const ingestor = new ClaudeIngestor(db, { root: values.root ?? env.claudeProjectsPath });
ingestor.on("ingest:error", ({ filePath, error }: IngestErrorEvent) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Failed to ingest ${filePath}: ${detail}`);
});

try {
  const summary = values.reindex ? await ingestor.reindex() : await ingestor.scan();
  console.log(JSON.stringify(summary));
  if (summary.failedFiles > 0) process.exitCode = 1;

  if (values.watch) {
    const watcher = startClaudeWatcher(ingestor);
    await watcher.ready;
    console.log(`Watching ${watcher.root}`);
    await new Promise<void>((resolve) => {
      const close = () => {
        void watcher.close().then(resolve);
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
  }
} finally {
  db.$client.close();
}
