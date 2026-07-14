import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import fc from "fast-check";

import { LineSplitter, type SplitLine } from "./line-splitter.ts";

function chunksFromSizes(input: Buffer, sizes: number[]) {
  const chunks: Buffer[] = [];
  let offset = 0;
  let sizeIndex = 0;

  while (offset < input.length) {
    const size = sizes[sizeIndex % sizes.length] ?? 1;
    chunks.push(input.subarray(offset, Math.min(offset + size, input.length)));
    offset += size;
    sizeIndex++;
  }

  return chunks;
}

async function split(input: Buffer, sizes: number[], byteOffset = 0) {
  const splitter = new LineSplitter({ byteOffset });
  Readable.from(chunksFromSizes(input, sizes)).pipe(splitter);

  const lines: SplitLine[] = [];
  for await (const line of splitter) lines.push(line as SplitLine);
  return {
    lines,
    remainder: splitter.remainder,
    remainderByteOffset: splitter.remainderByteOffset,
  };
}

await test("tracks offsets across CRLF, UTF-8 boundaries, and a partial tail", async () => {
  const byteOffset = 2 ** 31 + 7;
  const input = Buffer.from("α🙂\r\nnext\npartial");
  const result = await split(input, [1], byteOffset);

  assert.deepEqual(result.lines, [
    { line: "α🙂", byteOffset, byteLength: Buffer.byteLength("α🙂\r\n") },
    {
      line: "next",
      byteOffset: byteOffset + Buffer.byteLength("α🙂\r\n"),
      byteLength: Buffer.byteLength("next\n"),
    },
  ]);
  assert.deepEqual(result.remainder, Buffer.from("partial"));
  assert.equal(result.remainderByteOffset, byteOffset + Buffer.byteLength("α🙂\r\nnext\n"));
});

await test("does not emit a final line without a newline", async () => {
  const result = await split(Buffer.from("unfinished"), [2, 3]);
  assert.deepEqual(result.lines, []);
  assert.deepEqual(result.remainder, Buffer.from("unfinished"));
  assert.equal(result.remainderByteOffset, 0);
});

await test("rejects invalid starting offsets", () => {
  assert.throws(() => new LineSplitter({ byteOffset: -1 }), /non-negative safe integer/);
  assert.throws(
    () => new LineSplitter({ byteOffset: Number.MAX_SAFE_INTEGER + 1 }),
    /non-negative safe integer/,
  );
});

await test("roundtrips arbitrary complete lines and a partial remainder", async () => {
  const text = fc
    .string({ unit: "grapheme", maxLength: 40 })
    .filter((value) => !value.includes("\r") && !value.includes("\n"));
  const completeLine = fc.record({ text, ending: fc.constantFrom("\n", "\r\n") });

  await fc.assert(
    fc.asyncProperty(
      fc.array(completeLine, { maxLength: 20 }),
      text,
      fc.array(fc.integer({ min: 1, max: 17 }), { minLength: 1, maxLength: 20 }),
      fc.integer({ min: 0, max: 2 ** 40 }),
      async (complete, partial, sizes, byteOffset) => {
        const input = Buffer.from(
          complete.map(({ text: value, ending }) => value + ending).join("") + partial,
        );
        const result = await split(input, sizes, byteOffset);
        assert.equal(result.lines.length, complete.length);

        let consumedLength = 0;
        for (const [index, expected] of complete.entries()) {
          const actual = result.lines[index];
          assert.ok(actual);
          const byteLength = Buffer.byteLength(expected.text + expected.ending);
          assert.equal(actual.line, expected.text);
          assert.equal(actual.byteOffset, byteOffset + consumedLength);
          assert.equal(actual.byteLength, byteLength);
          consumedLength += byteLength;
        }

        const consumed = result.lines.map((line) =>
          input.subarray(
            line.byteOffset - byteOffset,
            line.byteOffset - byteOffset + line.byteLength,
          ),
        );
        assert.deepEqual(Buffer.concat([...consumed, result.remainder]), input);
        assert.deepEqual(result.remainder, Buffer.from(partial));
        assert.equal(result.remainderByteOffset, byteOffset + consumedLength);
      },
    ),
    { numRuns: 300 },
  );
});
