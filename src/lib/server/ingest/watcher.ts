import { join, resolve } from "node:path";

import chokidar, { type FSWatcher } from "chokidar";

import type { CodexIngestor } from "./codex-ingestor.ts";
import { type ClaudeIngestor, type IngestErrorEvent } from "./ingestor.ts";

export interface SessionWatcher {
  root: string;
  watcher: FSWatcher;
  ready: Promise<void>;
  close: () => Promise<void>;
}

type GlobalWithWatcher = typeof globalThis & {
  __aeyeClaudeWatcher?: SessionWatcher;
  __aeyeCodexWatcher?: SessionWatcher;
};

const globalWithWatcher = globalThis as GlobalWithWatcher;

type WatchableIngestor = ClaudeIngestor | CodexIngestor;

function startWatcher(
  ingestor: WatchableIngestor,
  root: string,
  paths: string[],
  existing: SessionWatcher | undefined,
  store: (watcher: SessionWatcher | undefined) => void,
) {
  if (existing !== undefined) {
    if (existing.root !== root) {
      throw new Error(`A Claude watcher is already running for ${existing.root}`);
    }
    return existing;
  }

  const watcher = chokidar.watch(paths, {
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

  const handle: SessionWatcher = {
    root,
    watcher,
    ready,
    close: async () => {
      await watcher.close();
      store(undefined);
    },
  };
  store(handle);
  return handle;
}

export type ClaudeWatcher = SessionWatcher;

export function startClaudeWatcher(ingestor: ClaudeIngestor) {
  const root = resolve(ingestor.root);
  return startWatcher(ingestor, root, [root], globalWithWatcher.__aeyeClaudeWatcher, (watcher) => {
    if (watcher === undefined) delete globalWithWatcher.__aeyeClaudeWatcher;
    else globalWithWatcher.__aeyeClaudeWatcher = watcher;
  });
}

export function startCodexWatcher(ingestor: CodexIngestor) {
  const root = resolve(ingestor.root);
  return startWatcher(
    ingestor,
    root,
    [join(root, "sessions"), join(root, "archived_sessions")],
    globalWithWatcher.__aeyeCodexWatcher,
    (watcher) => {
      if (watcher === undefined) delete globalWithWatcher.__aeyeCodexWatcher;
      else globalWithWatcher.__aeyeCodexWatcher = watcher;
    },
  );
}
