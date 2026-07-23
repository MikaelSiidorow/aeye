import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { acquireWriterLock } from "./writer-lock.ts";

await test("allows one database writer and recovers stale locks", () => {
  const directory = mkdtempSync(join(tmpdir(), "aeye-writer-lock-"));
  const databasePath = join(directory, "test.sqlite");
  const lockPath = `${databasePath}.writer.lock`;
  const first = acquireWriterLock(databasePath);

  try {
    assert.throws(
      () => acquireWriterLock(databasePath),
      new RegExp(`Live indexing is already active.*process ${process.pid}`),
    );
  } finally {
    first.release();
  }

  const second = acquireWriterLock(databasePath);
  second.release();
  writeFileSync(lockPath, "2147483647 stale\n");
  const recovered = acquireWriterLock(databasePath);
  recovered.release();
  rmSync(directory, { recursive: true, force: true });
});
