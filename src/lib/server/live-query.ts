import { getLiveIndex, type LiveIndexUpdate } from "./live-index.ts";

type MaybePromise<Value> = Value | Promise<Value>;

export interface LiveUpdateSource {
  ready: Promise<void>;
  subscribe: () => AsyncIterableIterator<LiveIndexUpdate>;
}

export async function* liveSnapshots<Value>(
  read: () => MaybePromise<Value>,
  relevant: (update: LiveIndexUpdate) => boolean = () => true,
  liveIndex: LiveUpdateSource = getLiveIndex(),
) {
  await liveIndex.ready;
  const updates = liveIndex.subscribe();

  try {
    yield await read();
    for await (const update of updates) {
      if (relevant(update)) yield await read();
    }
  } finally {
    await updates.return?.();
  }
}
