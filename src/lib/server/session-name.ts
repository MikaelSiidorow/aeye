import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, zstdDecompressSync } from "node:zlib";

import { and, asc, eq, inArray } from "drizzle-orm";

import type { Database } from "./db/database.ts";
import { events, files } from "./db/schema.ts";

type JsonRecord = Record<string, unknown>;

export interface NameableSession {
  id: string;
  sourceSessionId: string;
  parentId: string | null;
  source: "claude" | "codex";
}

interface IndexedSource {
  path: string;
  compression: (typeof files.$inferSelect)["compression"];
  byteOffset: number;
  byteLength: number;
}

const maximumNameLength = 120;
const fallbackWordCount = 8;
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: JsonRecord, key: string) {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function normalizedText(value: string) {
  return value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function boundedName(value: string) {
  const normalized = normalizedText(value);
  if (normalized.length === 0) return undefined;
  const graphemes = Array.from(graphemeSegmenter.segment(normalized), ({ segment }) => segment);
  return graphemes.length <= maximumNameLength
    ? normalized
    : `${graphemes.slice(0, maximumNameLength - 1).join("")}…`;
}

function messagePreview(value: string) {
  const normalized = normalizedText(
    value.replace(
      /<(system-reminder|local-command-caveat|local-command-stdout)\b[^>]*>[\s\S]*?<\/\1>/giu,
      " ",
    ),
  );
  if (normalized.length === 0 || /^\[request interrupted by user(?:[^\]]*)\]$/iu.test(normalized)) {
    return undefined;
  }
  const words = normalized.split(" ");
  const preview = words.slice(0, fallbackWordCount).join(" ");
  return boundedName(words.length > fallbackWordCount ? `${preview}…` : preview);
}

function contentText(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((block) => {
    if (!isRecord(block) || block["type"] !== "text") return [];
    const value = block["text"];
    return typeof value === "string" ? [value] : [];
  });
  return text.length === 0 ? undefined : text.join(" ");
}

function userMessage(source: NameableSession["source"], raw: JsonRecord) {
  if (source === "codex") {
    const payload = raw["payload"];
    if (raw["type"] !== "event_msg" || !isRecord(payload) || payload["type"] !== "user_message") {
      return undefined;
    }
    return contentText(payload["message"]);
  }

  const message = raw["message"];
  return isRecord(message) ? contentText(message["content"]) : contentText(raw["content"]);
}

function sourceBuffer(
  source: Pick<IndexedSource, "path" | "compression">,
  buffers: Map<string, Buffer>,
) {
  let buffer = buffers.get(source.path);
  if (buffer !== undefined) return buffer;
  const file = readFileSync(source.path);
  buffer =
    source.compression === "zstd"
      ? zstdDecompressSync(file)
      : source.compression === "gzip"
        ? gunzipSync(file)
        : file;
  buffers.set(source.path, buffer);
  return buffer;
}

function indexedJson(source: IndexedSource, buffers: Map<string, Buffer>) {
  try {
    const buffer = sourceBuffer(source, buffers);
    const end = source.byteOffset + source.byteLength;
    if (source.byteOffset < 0 || end > buffer.length) return undefined;
    const parsed: unknown = JSON.parse(buffer.subarray(source.byteOffset, end).toString("utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function genericName(session: NameableSession) {
  if (session.source === "codex") {
    return session.parentId === null ? "Codex thread" : "Codex subagent";
  }
  return session.parentId === null ? "Claude session" : "Claude subagent";
}

export class SessionNameResolver {
  readonly #db: Database;
  readonly #codexHomePath: string;

  constructor(db: Database, codexHomePath: string) {
    this.#db = db;
    this.#codexHomePath = codexHomePath;
  }

  resolve(input: NameableSession[]) {
    const sessions = [...new Map(input.map((session) => [session.id, session])).values()];
    const names = new Map<string, string>();
    const buffers = new Map<string, Buffer>();
    this.#resolveClaudeSubagents(sessions, names);
    this.#resolveClaudeTitles(sessions, names, buffers);
    const codexPreviews = this.#resolveCodexTitles(sessions, names);

    for (const [sessionId, preview] of codexPreviews) {
      if (!names.has(sessionId)) names.set(sessionId, preview);
    }
    this.#resolveMessagePreviews(sessions, names, buffers);
    for (const session of sessions) {
      if (!names.has(session.id)) names.set(session.id, genericName(session));
    }
    return names;
  }

  #resolveClaudeSubagents(sessions: NameableSession[], names: Map<string, string>) {
    const sessionIds = sessions
      .filter((session) => session.source === "claude" && session.parentId !== null)
      .map(({ id }) => id);
    if (sessionIds.length === 0) return;

    const sourceFiles = this.#db
      .select({ sessionId: files.sessionId, path: files.path })
      .from(files)
      .where(inArray(files.sessionId, sessionIds))
      .orderBy(asc(files.path))
      .all();
    for (const sourceFile of sourceFiles) {
      if (
        sourceFile.sessionId === null ||
        names.has(sourceFile.sessionId) ||
        !sourceFile.path.endsWith(".jsonl")
      ) {
        continue;
      }
      const sidecarPath = `${sourceFile.path.slice(0, -".jsonl".length)}.meta.json`;
      try {
        const parsed: unknown = JSON.parse(readFileSync(sidecarPath, "utf8"));
        if (!isRecord(parsed)) continue;
        const description = stringField(parsed, "description");
        const name = description === undefined ? undefined : boundedName(description);
        if (name !== undefined) names.set(sourceFile.sessionId, name);
      } catch {
        continue;
      }
    }
  }

  #resolveClaudeTitles(
    sessions: NameableSession[],
    names: Map<string, string>,
    buffers: Map<string, Buffer>,
  ) {
    const sessionIds = sessions
      .filter((session) => session.source === "claude" && session.parentId === null)
      .map(({ id }) => id);
    if (sessionIds.length === 0) return;

    const rows = this.#db
      .select({
        sessionId: events.sessionId,
        type: events.type,
        path: files.path,
        compression: files.compression,
        byteOffset: events.byteOffset,
        byteLength: events.byteLength,
      })
      .from(events)
      .innerJoin(files, eq(events.fileId, files.id))
      .where(
        and(
          inArray(events.sessionId, sessionIds),
          inArray(events.type, ["ai-title", "custom-title"]),
        ),
      )
      .orderBy(asc(events.sessionId), asc(events.seq))
      .all();
    const aiTitles = new Map<string, string>();
    const customTitles = new Map<string, string>();

    for (const row of rows) {
      const raw = indexedJson(row, buffers);
      if (raw === undefined) continue;
      const value =
        row.type === "custom-title" ? stringField(raw, "customTitle") : stringField(raw, "aiTitle");
      const name = value === undefined ? undefined : boundedName(value);
      if (name === undefined) continue;
      (row.type === "custom-title" ? customTitles : aiTitles).set(row.sessionId, name);
    }
    for (const sessionId of sessionIds) {
      const name = customTitles.get(sessionId) ?? aiTitles.get(sessionId);
      if (name !== undefined) names.set(sessionId, name);
    }
  }

  #resolveCodexTitles(sessions: NameableSession[], names: Map<string, string>) {
    const codexSessions = sessions.filter((session) => session.source === "codex");
    const previews = new Map<string, string>();
    if (codexSessions.length === 0) return previews;
    const statePath = join(this.#codexHomePath, "state_5.sqlite");
    if (!existsSync(statePath)) return previews;

    let state: DatabaseSync | undefined;
    try {
      state = new DatabaseSync(statePath, { readOnly: true });
      const columns = new Set(
        state
          .prepare("PRAGMA table_info(threads)")
          .all()
          .flatMap((row) => (typeof row["name"] === "string" ? [row["name"]] : [])),
      );
      if (!columns.has("title") && !columns.has("name")) return previews;
      const selected = [
        "id",
        columns.has("name") ? "name" : "NULL AS name",
        columns.has("title") ? "title" : "NULL AS title",
        columns.has("first_user_message") ? "first_user_message" : "NULL AS first_user_message",
      ].join(", ");
      const bySourceId = new Map(
        codexSessions.map((session) => [session.sourceSessionId, session]),
      );
      const sourceIds = [...bySourceId.keys()];

      for (let index = 0; index < sourceIds.length; index += 400) {
        const chunk = sourceIds.slice(index, index + 400);
        const placeholders = chunk.map(() => "?").join(", ");
        const rows = state
          .prepare(`SELECT ${selected} FROM threads WHERE id IN (${placeholders})`)
          .all(...chunk);
        for (const row of rows) {
          const sourceId = row["id"];
          if (typeof sourceId !== "string") continue;
          const session = bySourceId.get(sourceId);
          if (session === undefined) continue;
          const explicit =
            typeof row["name"] === "string" && row["name"].trim().length > 0
              ? row["name"]
              : row["title"];
          if (typeof explicit === "string") {
            const name = boundedName(explicit);
            if (name !== undefined) names.set(session.id, name);
          }
          if (typeof row["first_user_message"] === "string") {
            const preview = messagePreview(row["first_user_message"]);
            if (preview !== undefined) previews.set(session.id, preview);
          }
        }
      }
    } catch {
      return previews;
    } finally {
      state?.close();
    }
    return previews;
  }

  #resolveMessagePreviews(
    sessions: NameableSession[],
    names: Map<string, string>,
    buffers: Map<string, Buffer>,
  ) {
    const unresolved = sessions.filter((session) => !names.has(session.id));
    if (unresolved.length === 0) return;
    const byId = new Map(unresolved.map((session) => [session.id, session]));
    const rows = this.#db
      .select({
        sessionId: events.sessionId,
        path: files.path,
        compression: files.compression,
        byteOffset: events.byteOffset,
        byteLength: events.byteLength,
      })
      .from(events)
      .innerJoin(files, eq(events.fileId, files.id))
      .where(
        and(
          inArray(events.sessionId, [...byId.keys()]),
          eq(events.kind, "user"),
          eq(events.isMeta, false),
        ),
      )
      .orderBy(asc(events.sessionId), asc(events.seq))
      .all();
    const candidates = new Map<string, number>();

    for (const row of rows) {
      if (names.has(row.sessionId)) continue;
      const seen = candidates.get(row.sessionId) ?? 0;
      if (seen >= 20) continue;
      candidates.set(row.sessionId, seen + 1);
      const session = byId.get(row.sessionId);
      if (session === undefined) continue;
      const raw = indexedJson(row, buffers);
      if (raw === undefined) continue;
      const text = userMessage(session.source, raw);
      const preview = text === undefined ? undefined : messagePreview(text);
      if (preview !== undefined) names.set(row.sessionId, preview);
    }
  }
}
