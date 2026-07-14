import assert from "node:assert/strict";
import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

import fc from "fast-check";

import {
  parseClaudeCodeEvent,
  triagedUnknownTypeValues,
  type NormalizedEvent,
} from "./claude-code.ts";
import { LineSplitter, type SplitLine } from "./line-splitter.ts";

const corpusRoot = resolve("fixtures/corpus");

function corpusFiles() {
  if (!existsSync(corpusRoot)) return [];
  return readdirSync(corpusRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

function newlineCount(buffer: Buffer) {
  let count = 0;
  for (const byte of buffer) if (byte === 0x0a) count++;
  return count;
}

function sampleCorpusLines(limit: number) {
  const sample: string[] = [];
  for (const file of corpusFiles()) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 13) {
      const line = lines[index];
      if (line) sample.push(line);
      if (sample.length === limit) return sample;
    }
  }
  return sample;
}

function mutateLine(
  line: string,
  mutation: "truncate" | "splice" | "type_swap",
  positionSeed: number,
  inserted: string,
  replacement: unknown,
) {
  const position = positionSeed % (line.length + 1);
  if (mutation === "truncate") return line.slice(0, position);
  if (mutation === "splice") {
    const removed = positionSeed % 7;
    return line.slice(0, position) + inserted + line.slice(position + removed);
  }

  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return line;
    const record = parsed as Record<string, unknown>;
    const message = record["message"];
    if (positionSeed % 2 === 0 || typeof message !== "object" || message === null) {
      record["type"] = replacement;
    } else {
      (message as Record<string, unknown>)["content"] = replacement;
    }
    return JSON.stringify(record);
  } catch {
    return line;
  }
}

function assertNormalized(event: NormalizedEvent) {
  assert.equal(typeof event.kind, "string");
  assert.equal(typeof event.type, "string");
}

await test("extracts assistant usage and tool metadata without retaining input or content", () => {
  const event = parseClaudeCodeEvent(
    JSON.stringify({
      type: "assistant",
      sessionId: "session",
      uuid: "event",
      parentUuid: "parent",
      timestamp: "2026-07-14T12:00:00.000Z",
      cwd: "/tmp/project",
      gitBranch: "main",
      version: "1.2.3",
      requestId: "request-1",
      message: {
        id: "message-1",
        role: "assistant",
        model: "claude-test",
        stop_reason: "tool_use",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 30,
          cache_creation: {
            ephemeral_5m_input_tokens: 3,
            ephemeral_1h_input_tokens: 4,
          },
        },
        content: [
          { type: "text", text: "PRIVATE_MESSAGE_BODY" },
          {
            type: "tool_use",
            id: "tool-1",
            name: "Edit",
            input: {
              file_path: "/tmp/project/file.ts",
              command: "PRIVATE_TOOL_INPUT",
              flags: ["one", "two"],
            },
          },
        ],
      },
    }),
  );

  assert.equal(event.kind, "assistant");
  assert.equal(event.messageId, "message-1");
  assert.equal(event.requestId, "request-1");
  assert.equal(event.hasUsage, true);
  assert.deepEqual(event.usage, {
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 7,
  });
  assert.deepEqual(event.content, { format: "blocks", blockCount: 2 });
  assert.deepEqual(event.toolUses, [
    {
      toolUseId: "tool-1",
      name: "Edit",
      inputSummary: "command: string(18 bytes), file_path: path, flags: array(2)",
      targetPath: "/tmp/project/file.ts",
    },
  ]);
  assert.equal(event.stopReason, "tool_use");
  const normalized = JSON.stringify(event);
  assert.equal(normalized.includes("PRIVATE_MESSAGE_BODY"), false);
  assert.equal(normalized.includes("PRIVATE_TOOL_INPUT"), false);
});

await test("handles string and block content and detects interrupt markers", () => {
  const stringEvent = parseClaudeCodeEvent(
    JSON.stringify({ type: "user", message: { role: "user", content: "PRIVATE_USER_BODY" } }),
  );
  assert.equal(stringEvent.kind, "user");
  assert.deepEqual(stringEvent.content, { format: "string", blockCount: 0 });
  assert.equal(JSON.stringify(stringEvent).includes("PRIVATE_USER_BODY"), false);

  const blockEvent = parseClaudeCodeEvent(
    JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", is_error: true, content: "PRIVATE_RESULT" },
          { type: "text", text: "[Request interrupted by user]" },
        ],
      },
    }),
  );
  assert.equal(blockEvent.kind, "user");
  assert.equal(blockEvent.isInterrupt, true);
  assert.deepEqual(blockEvent.toolResults, [{ toolUseId: "tool-1", isError: true }]);
  assert.equal(JSON.stringify(blockEvent).includes("PRIVATE_RESULT"), false);
});

await test("normalizes known types and preserves unknown raw types", () => {
  const examples = [
    ["system", "system"],
    ["summary", "summary"],
    ["attachment", "attachment"],
    ["file-history-snapshot", "file_history_snapshot"],
    ["permission-mode", "permission_mode"],
    ["queue-operation", "queue_operation"],
  ] as const;

  for (const [type, kind] of examples) {
    assert.equal(parseClaudeCodeEvent(JSON.stringify({ type })).kind, kind);
  }

  const triaged = parseClaudeCodeEvent(JSON.stringify({ type: "ai-title", aiTitle: "PRIVATE" }));
  assert.equal(triaged.kind, "unknown");
  assert.equal(triaged.type, "ai-title");
  assert.equal(triaged.isMeta, true);
  assert.equal(JSON.stringify(triaged).includes("PRIVATE"), false);

  const novel = parseClaudeCodeEvent(JSON.stringify({ type: "future-event" }));
  assert.equal(novel.kind, "unknown");
  assert.equal(novel.type, "future-event");
});

await test("returns parse errors without retaining malformed lines", () => {
  assert.equal(parseClaudeCodeEvent("PRIVATE invalid json").kind, "parse_error");
  assert.equal(parseClaudeCodeEvent("[]").kind, "parse_error");
  assert.equal(parseClaudeCodeEvent("{}").kind, "parse_error");
  assert.equal(
    JSON.stringify(parseClaudeCodeEvent("PRIVATE invalid json")).includes("PRIVATE"),
    false,
  );
});

await test("is total for arbitrary JSON objects", () => {
  fc.assert(
    fc.property(
      fc.dictionary(fc.string({ maxLength: 20 }), fc.jsonValue(), { maxKeys: 30 }),
      (value) => assertNormalized(parseClaudeCodeEvent(JSON.stringify(value))),
    ),
    { numRuns: 500 },
  );
});

await test(
  "parses every complete corpus line and keeps unknown types triaged",
  { skip: !existsSync(corpusRoot) },
  async () => {
    const unknownTypes = new Set<string>();
    let totalLines = 0;

    for (const file of corpusFiles()) {
      const source = readFileSync(file);
      const expectedLines = newlineCount(source);
      const splitter = new LineSplitter();
      createReadStream(file).pipe(splitter);
      let actualLines = 0;

      for await (const value of splitter) {
        const { line } = value as SplitLine;
        const event = parseClaudeCodeEvent(line);
        assert.notEqual(event.kind, "parse_error", file);
        if (event.kind === "unknown") unknownTypes.add(event.type);
        actualLines++;
      }

      assert.equal(actualLines, expectedLines, file);
      assert.equal(splitter.remainder.length, 0, file);
      totalLines += actualLines;
    }

    assert.ok(totalLines > 0);
    assert.deepEqual([...unknownTypes].sort(), [...triagedUnknownTypeValues].sort());
  },
);

await test(
  "survives truncation, splicing, and type swaps over corpus lines",
  { skip: !existsSync(corpusRoot) },
  () => {
    const lines = sampleCorpusLines(500);
    assert.ok(lines.length > 0);
    const replacement = fc.oneof(
      fc.string({ maxLength: 20 }),
      fc.integer(),
      fc.boolean(),
      fc.constant(null),
      fc.array(fc.integer(), { maxLength: 4 }),
    );

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: lines.length - 1 }),
        fc.constantFrom("truncate", "splice", "type_swap"),
        fc.nat(),
        fc.string({ unit: "binary", maxLength: 12 }),
        replacement,
        (lineIndex, mutation, positionSeed, inserted, swapped) => {
          const line = lines[lineIndex];
          assert.ok(line);
          assertNormalized(
            parseClaudeCodeEvent(mutateLine(line, mutation, positionSeed, inserted, swapped)),
          );
        },
      ),
      { numRuns: 300 },
    );
  },
);
