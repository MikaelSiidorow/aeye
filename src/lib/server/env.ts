import { homedir } from "node:os";
import { join } from "node:path";

export interface Environment {
  databasePath: string;
  claudeProjectsPath: string;
  codexHomePath: string;
}

export const defaultClaudeProjectsPath = join(homedir(), ".claude", "projects");
export const defaultCodexHomePath = join(homedir(), ".codex");

function readPath(source: NodeJS.ProcessEnv, name: string, fallback: string) {
  const rawValue = source[name];
  if (rawValue === undefined) return fallback;

  const value = rawValue.trim();
  if (value.length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  if (value.includes("\0")) {
    throw new Error(`${name} must not contain a null byte`);
  }

  return value;
}

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const codexHomePath = readPath(source, "CODEX_HOME", defaultCodexHomePath);
  return {
    databasePath: readPath(source, "AEYE_DB_PATH", "data/aeye.sqlite"),
    claudeProjectsPath: readPath(source, "AEYE_CLAUDE_PROJECTS_PATH", defaultClaudeProjectsPath),
    codexHomePath: readPath(source, "AEYE_CODEX_HOME_PATH", codexHomePath),
  };
}

export const env = Object.freeze(loadEnvironment());
