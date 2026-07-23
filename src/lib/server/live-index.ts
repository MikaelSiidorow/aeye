import { env, type Environment } from "./env.ts";
import { openDatabase, type Database } from "./db/database.ts";
import { acquireWriterLock, type WriterLock } from "./db/writer-lock.ts";
import { CodexIngestor } from "./ingest/codex-ingestor.ts";
import {
  ClaudeIngestor,
  type IngestErrorEvent,
  type SessionUpdatedEvent,
} from "./ingest/ingestor.ts";
import { backfillAnnotations } from "./ingest/derive.ts";
import { deriveSessionLinks } from "./ingest/session-links.ts";
import { startClaudeWatcher, startCodexWatcher, type SessionWatcher } from "./ingest/watcher.ts";

export interface LiveIndexUpdate {
  revision: number;
  sessionIds: string[];
  projectIds: number[];
  updatedAt: number;
}

interface LinkRow {
  sourceSessionId: string;
  targetSessionId: string;
  kind: string;
  method: string;
}

interface ProjectRow {
  projectId: number;
}

function mergeUpdates(left: LiveIndexUpdate, right: LiveIndexUpdate): LiveIndexUpdate {
  return {
    revision: Math.max(left.revision, right.revision),
    sessionIds: [...new Set([...left.sessionIds, ...right.sessionIds])],
    projectIds: [...new Set([...left.projectIds, ...right.projectIds])],
    updatedAt: Math.max(left.updatedAt, right.updatedAt),
  };
}

class LiveSubscription implements AsyncIterableIterator<LiveIndexUpdate> {
  readonly #onClose: () => void;
  #closed = false;
  #pending: LiveIndexUpdate | undefined;
  #resolve: ((result: IteratorResult<LiveIndexUpdate>) => void) | undefined;

  constructor(onClose: () => void) {
    this.#onClose = onClose;
  }

  push(update: LiveIndexUpdate) {
    if (this.#closed) return;
    if (this.#resolve !== undefined) {
      const resolve = this.#resolve;
      this.#resolve = undefined;
      resolve({ value: update, done: false });
      return;
    }
    this.#pending = this.#pending === undefined ? update : mergeUpdates(this.#pending, update);
  }

  next(): Promise<IteratorResult<LiveIndexUpdate>> {
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    if (this.#pending !== undefined) {
      const update = this.#pending;
      this.#pending = undefined;
      return Promise.resolve({ value: update, done: false });
    }
    return new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  return(): Promise<IteratorResult<LiveIndexUpdate>> {
    this.close();
    return Promise.resolve({ value: undefined, done: true });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#pending = undefined;
    const resolve = this.#resolve;
    this.#resolve = undefined;
    resolve?.({ value: undefined, done: true });
    this.#onClose();
  }

  [Symbol.asyncIterator]() {
    return this;
  }
}

class LiveUpdateHub {
  readonly #subscriptions = new Set<LiveSubscription>();

  get subscriberCount() {
    return this.#subscriptions.size;
  }

  publish(update: LiveIndexUpdate) {
    for (const subscription of this.#subscriptions) subscription.push(update);
  }

  subscribe() {
    let subscription: LiveSubscription;
    subscription = new LiveSubscription(() => this.#subscriptions.delete(subscription));
    this.#subscriptions.add(subscription);
    return subscription;
  }

  close() {
    for (const subscription of this.#subscriptions) subscription.close();
  }
}

function linkRows(db: Database) {
  return db.$client
    .prepare(
      `SELECT
         source_session_id AS sourceSessionId,
         target_session_id AS targetSessionId,
         kind,
         method
       FROM session_links`,
    )
    .all() as unknown as LinkRow[];
}

function linkKey(row: LinkRow) {
  return `${row.sourceSessionId}\0${row.targetSessionId}\0${row.kind}\0${row.method}`;
}

function changedLinkSessionIds(before: LinkRow[], after: LinkRow[]) {
  const beforeByKey = new Map(before.map((row) => [linkKey(row), row]));
  const afterByKey = new Map(after.map((row) => [linkKey(row), row]));
  const sessionIds = new Set<string>();

  for (const [key, row] of beforeByKey) {
    if (afterByKey.has(key)) continue;
    sessionIds.add(row.sourceSessionId);
    sessionIds.add(row.targetSessionId);
  }
  for (const [key, row] of afterByKey) {
    if (beforeByKey.has(key)) continue;
    sessionIds.add(row.sourceSessionId);
    sessionIds.add(row.targetSessionId);
  }
  return sessionIds;
}

function projectIdsForSessions(db: Database, sessionIds: Iterable<string>) {
  const statement = db.$client.prepare("SELECT project_id AS projectId FROM sessions WHERE id = ?");
  const projectIds = new Set<number>();
  for (const sessionId of sessionIds) {
    const row = statement.get(sessionId) as unknown as ProjectRow | undefined;
    if (row !== undefined) projectIds.add(row.projectId);
  }
  return projectIds;
}

export class LiveIndex {
  readonly ready: Promise<void>;
  readonly #writerLock: WriterLock;
  readonly #db: Database;
  readonly #claude: ClaudeIngestor;
  readonly #codex: CodexIngestor;
  readonly #hub = new LiveUpdateHub();
  readonly #pendingSessionIds = new Set<string>();
  #watchers: SessionWatcher[] = [];
  #pendingFlush: Promise<void> | undefined;
  #revision = 0;
  #closed = false;

  constructor(options: Environment = env) {
    this.#writerLock = acquireWriterLock(options.databasePath);
    try {
      this.#db = openDatabase(options.databasePath);
    } catch (error) {
      this.#writerLock.release();
      throw error;
    }
    this.#claude = new ClaudeIngestor(this.#db, { root: options.claudeProjectsPath });
    this.#codex = new CodexIngestor(this.#db, { root: options.codexHomePath });
    this.#claude.on("session:updated", this.#queueUpdate);
    this.#codex.on("session:updated", this.#queueUpdate);
    this.#claude.on("ingest:error", this.#reportError);
    this.#codex.on("ingest:error", this.#reportError);
    this.ready = this.#start().catch(async (error: unknown) => {
      await this.close();
      throw error;
    });
  }

  get subscriberCount() {
    return this.#hub.subscriberCount;
  }

  subscribe() {
    return this.#hub.subscribe();
  }

  readonly #reportError = ({ filePath, error }: IngestErrorEvent) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`Failed to ingest ${filePath}: ${detail}`);
  };

  readonly #queueUpdate = ({ sessionId }: SessionUpdatedEvent) => {
    if (this.#closed) return;
    this.#pendingSessionIds.add(sessionId);
    this.#scheduleFlush();
  };

  #scheduleFlush() {
    if (this.#closed || this.#pendingFlush !== undefined) return;

    let finish = () => {};
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#pendingFlush = pending;
    queueMicrotask(() => {
      try {
        this.#flush();
      } catch (error) {
        this.#reportError({ filePath: "session links", error });
      } finally {
        if (this.#pendingFlush === pending) this.#pendingFlush = undefined;
        finish();
        if (!this.#closed && this.#pendingSessionIds.size > 0) this.#scheduleFlush();
      }
    });
  }

  #flush() {
    if (this.#pendingSessionIds.size === 0 || this.#closed) return;
    const directSessionIds = new Set(this.#pendingSessionIds);
    this.#pendingSessionIds.clear();
    const before = linkRows(this.#db);
    deriveSessionLinks(this.#db);
    const affectedSessionIds = changedLinkSessionIds(before, linkRows(this.#db));
    for (const sessionId of directSessionIds) affectedSessionIds.add(sessionId);

    this.#hub.publish({
      revision: ++this.#revision,
      sessionIds: [...affectedSessionIds].sort(),
      projectIds: [...projectIdsForSessions(this.#db, directSessionIds)].sort(
        (left, right) => left - right,
      ),
      updatedAt: Date.now(),
    });
  }

  async #waitForFlush() {
    while (this.#pendingFlush !== undefined) await this.#pendingFlush;
  }

  async #start() {
    this.#watchers.push(startClaudeWatcher(this.#claude));
    this.#watchers.push(startCodexWatcher(this.#codex));
    await Promise.all(this.#watchers.map(({ ready }) => ready));
    await this.#claude.scan();
    await this.#codex.scan();
    backfillAnnotations(this.#db);
    await this.#waitForFlush();
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#claude.off("session:updated", this.#queueUpdate);
    this.#codex.off("session:updated", this.#queueUpdate);
    this.#claude.off("ingest:error", this.#reportError);
    this.#codex.off("ingest:error", this.#reportError);
    await Promise.all(this.#watchers.map((watcher) => watcher.close()));
    this.#pendingSessionIds.clear();
    await this.#waitForFlush();
    this.#hub.close();
    this.#db.$client.close();
    this.#writerLock.release();
  }
}

type GlobalWithLiveIndex = typeof globalThis & {
  __aeyeLiveIndex?: LiveIndex;
};

const globalWithLiveIndex = globalThis as GlobalWithLiveIndex;

export function getLiveIndex() {
  return (globalWithLiveIndex.__aeyeLiveIndex ??= new LiveIndex());
}
