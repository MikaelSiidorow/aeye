import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

function hasCode(error: unknown, code: string) {
  return error instanceof Error && "code" in error && error.code === code;
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

export class WriterLock {
  readonly #path: string | null;
  readonly #contents: string;
  #released = false;

  constructor(path: string | null, contents = "") {
    this.#path = path;
    this.#contents = contents;
  }

  release() {
    if (this.#released || this.#path === null) return;
    this.#released = true;
    try {
      if (readFileSync(this.#path, "utf8") === this.#contents) unlinkSync(this.#path);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
    }
  }
}

export function acquireWriterLock(databasePath: string) {
  if (databasePath === ":memory:") return new WriterLock(null);

  const absoluteDatabasePath = resolve(databasePath);
  const lockPath = `${absoluteDatabasePath}.writer.lock`;
  const contents = `${process.pid} ${randomUUID()}\n`;
  mkdirSync(dirname(lockPath), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor: number;
    try {
      descriptor = openSync(
        lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      let owner = Number.NaN;
      try {
        owner = Number.parseInt(readFileSync(lockPath, "utf8").split(/\s/, 1)[0] ?? "", 10);
      } catch (readError) {
        if (!hasCode(readError, "ENOENT")) throw readError;
        continue;
      }
      if (Number.isSafeInteger(owner) && owner > 0 && processExists(owner)) {
        throw new Error(
          `Live indexing is already active for ${absoluteDatabasePath} in process ${owner}.`,
        );
      }
      try {
        unlinkSync(lockPath);
      } catch (unlinkError) {
        if (!hasCode(unlinkError, "ENOENT")) throw unlinkError;
      }
      continue;
    }

    try {
      writeFileSync(descriptor, contents);
    } finally {
      closeSync(descriptor);
    }
    return new WriterLock(lockPath, contents);
  }

  throw new Error(`Could not acquire the live index writer lock for ${absoluteDatabasePath}.`);
}
