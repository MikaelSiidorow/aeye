import assert from "node:assert/strict";
import test from "node:test";

import type { LiveIndexUpdate } from "./live-index.ts";
import { liveSnapshots, type LiveUpdateSource } from "./live-query.ts";

function update(revision: number, projectIds: number[]): LiveIndexUpdate {
  return {
    revision,
    sessionIds: [`session-${revision}`],
    projectIds,
    updatedAt: revision,
  };
}

await test("live snapshots emit initially and only for relevant updates", async () => {
  const source: LiveUpdateSource = {
    ready: Promise.resolve(),
    subscribe() {
      return (async function* () {
        yield update(1, [1]);
        yield update(2, [2]);
      })();
    },
  };
  let reads = 0;
  const snapshots: number[] = [];

  for await (const snapshot of liveSnapshots(
    () => ++reads,
    ({ projectIds }) => projectIds.includes(2),
    source,
  )) {
    snapshots.push(snapshot);
  }

  assert.deepEqual(snapshots, [1, 2]);
});
