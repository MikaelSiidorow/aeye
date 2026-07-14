import { Transform, type TransformCallback } from "node:stream";

export interface SplitLine {
  line: string;
  byteOffset: number;
  byteLength: number;
}

export interface LineSplitterOptions {
  byteOffset?: number;
}

export class LineSplitter extends Transform {
  readonly #pending: Buffer[] = [];
  #pendingLength = 0;
  #nextByteOffset: number;

  constructor({ byteOffset = 0 }: LineSplitterOptions = {}) {
    if (!Number.isSafeInteger(byteOffset) || byteOffset < 0) {
      throw new RangeError("byteOffset must be a non-negative safe integer");
    }

    super({ readableObjectMode: true });
    this.#nextByteOffset = byteOffset;
  }

  get remainder() {
    return Buffer.concat(this.#pending, this.#pendingLength);
  }

  get remainderByteOffset() {
    return this.#nextByteOffset;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    try {
      let start = 0;
      let newline = chunk.indexOf(0x0a, start);

      while (newline !== -1) {
        const tail = chunk.subarray(start, newline);
        const rawLine =
          this.#pendingLength === 0
            ? tail
            : Buffer.concat([...this.#pending, tail], this.#pendingLength + tail.length);
        const byteLength = this.#pendingLength + tail.length + 1;
        const content = rawLine.at(-1) === 0x0d ? rawLine.subarray(0, -1) : rawLine;

        this.push({
          line: content.toString("utf8"),
          byteOffset: this.#nextByteOffset,
          byteLength,
        } satisfies SplitLine);

        this.#pending.length = 0;
        this.#pendingLength = 0;
        this.#nextByteOffset += byteLength;
        start = newline + 1;
        newline = chunk.indexOf(0x0a, start);
      }

      if (start < chunk.length) {
        const remainder = chunk.subarray(start);
        this.#pending.push(remainder);
        this.#pendingLength += remainder.length;
      }

      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}
