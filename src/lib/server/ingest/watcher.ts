import { resolve } from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import { type ClaudeIngestor, type IngestErrorEvent } from "./ingestor.ts";

export interface ClaudeWatcher {
  root: string;
  watcher: FSWatcher;
  ready: Promise<void>;
  close: () => Promise<void>;
}

type GlobalWithWatcher = typeof globalThis & {
  __aeyeClaudeWatcher?: ClaudeWatcher;
};

const globalWithWatcher = globalThis as GlobalWithWatcher;

export function startClaudeWatcher(ingestor: ClaudeIngestor) {
  const root = resolve(ingestor.root);
  const existing = globalWithWatcher.__aeyeClaudeWatcher;
  if (existing !== undefined) {
    if (existing.root !== root) {
      throw new Error(`A Claude watcher is already running for ${existing.root}`);
    }
    return existing;
  }

  const watcher = chokidar.watch(root, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });
  const ready = new Promise<void>((resolveReady, reject) => {
    watcher.once("ready", resolveReady);
    watcher.once("error", reject);
  });
  const changed = (filePath: string) => {
    if (!ingestor.enqueue(filePath)) return;
    void ingestor.drain().catch((error: unknown) => {
      ingestor.emit("ingest:error", { filePath, error } satisfies IngestErrorEvent);
    });
  };
  watcher.on("add", changed);
  watcher.on("change", changed);
  watcher.on("error", (error) => {
    ingestor.emit("ingest:error", { filePath: root, error } satisfies IngestErrorEvent);
  });

  const handle: ClaudeWatcher = {
    root,
    watcher,
    ready,
    close: async () => {
      await watcher.close();
      if (globalWithWatcher.__aeyeClaudeWatcher === handle) {
        delete globalWithWatcher.__aeyeClaudeWatcher;
      }
    },
  };
  globalWithWatcher.__aeyeClaudeWatcher = handle;
  return handle;
}
