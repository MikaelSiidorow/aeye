import { parseArgs } from "node:util";

import { openDatabase } from "../src/lib/server/db/database.ts";
import { acquireWriterLock } from "../src/lib/server/db/writer-lock.ts";
import { env } from "../src/lib/server/env.ts";
import { CodexIngestor } from "../src/lib/server/ingest/codex-ingestor.ts";
import { ClaudeIngestor, type IngestErrorEvent } from "../src/lib/server/ingest/ingestor.ts";
import { backfillAnnotations, deriveStaleSessions } from "../src/lib/server/ingest/derive.ts";
import { deriveSessionLinks } from "../src/lib/server/ingest/session-links.ts";
import { startClaudeWatcher, startCodexWatcher } from "../src/lib/server/ingest/watcher.ts";

const { values } = parseArgs({
  options: {
    database: { type: "string", short: "d" },
    root: { type: "string" },
    "claude-root": { type: "string" },
    "codex-home": { type: "string" },
    reindex: { type: "boolean", default: false },
    watch: { type: "boolean", default: false },
  },
});

const databasePath = values.database ?? env.databasePath;
const writerLock = acquireWriterLock(databasePath);
let db;
try {
  db = openDatabase(databasePath);
} catch (error) {
  writerLock.release();
  throw error;
}
const claude = new ClaudeIngestor(db, {
  root: values["claude-root"] ?? values.root ?? env.claudeProjectsPath,
});
const codex = new CodexIngestor(db, { root: values["codex-home"] ?? env.codexHomePath });
const reportError = ({ filePath, error }: IngestErrorEvent) => {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`Failed to ingest ${filePath}: ${detail}`);
};
claude.on("ingest:error", reportError);
codex.on("ingest:error", reportError);

try {
  const claudeSummary = values.reindex ? await claude.reindex() : await claude.scan();
  const codexSummary = await codex.scan();
  const recoveredSessions = deriveStaleSessions(db).summaries.length;
  backfillAnnotations(db);
  const linkSummary = deriveSessionLinks(db);
  console.log(
    JSON.stringify({
      claude: claudeSummary,
      codex: codexSummary,
      recoveredSessions,
      links: linkSummary,
    }),
  );
  if (claudeSummary.failedFiles + codexSummary.failedFiles > 0) process.exitCode = 1;

  if (values.watch) {
    const refreshLinks = () => deriveSessionLinks(db);
    claude.on("session:updated", refreshLinks);
    codex.on("session:updated", refreshLinks);
    const watchers = [startClaudeWatcher(claude), startCodexWatcher(codex)];
    await Promise.all(watchers.map(({ ready }) => ready));
    console.log(`Watching ${watchers.map(({ root }) => root).join(", ")}`);
    await new Promise<void>((resolve) => {
      const close = () => {
        void Promise.all(watchers.map((watcher) => watcher.close())).then(() => resolve());
      };
      process.once("SIGINT", close);
      process.once("SIGTERM", close);
    });
  }
} finally {
  db.$client.close();
  writerLock.release();
}
