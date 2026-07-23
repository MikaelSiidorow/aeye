import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

export interface ResumableSession {
  source: "claude" | "codex";
  sourceSessionId: string;
  cwd: string;
  agentId: string | null;
}

export interface ResumeDescriptor {
  provider: "claude" | "codex";
  executable: "claude" | "codex";
  args: string[];
  cwd: string;
  command: string;
  label: string;
  resumesParent: boolean;
}

export interface ResumeAvailability {
  canLaunch: boolean;
  terminal: string | null;
  reason: string | null;
}

interface TerminalDefinition {
  executable: string;
  label: string;
  args: (cwd: string, executable: string, args: string[]) => string[];
}

export class ResumeLaunchError extends Error {
  readonly code:
    | "invalid_session"
    | "missing_working_directory"
    | "missing_provider"
    | "missing_terminal";

  constructor(
    code: "invalid_session" | "missing_working_directory" | "missing_provider" | "missing_terminal",
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "ResumeLaunchError";
  }
}

const terminalDefinitions: TerminalDefinition[] = [
  {
    executable: "ghostty",
    label: "Ghostty",
    args: (cwd, executable, args) => [`--working-directory=${cwd}`, "-e", executable, ...args],
  },
  {
    executable: "kitty",
    label: "Kitty",
    args: (cwd, executable, args) => ["--directory", cwd, "--", executable, ...args],
  },
  {
    executable: "foot",
    label: "Foot",
    args: (cwd, executable, args) => ["--working-directory", cwd, "-e", executable, ...args],
  },
  {
    executable: "wezterm",
    label: "WezTerm",
    args: (cwd, executable, args) => ["start", "--cwd", cwd, "--", executable, ...args],
  },
  {
    executable: "gnome-terminal",
    label: "GNOME Terminal",
    args: (cwd, executable, args) => [`--working-directory=${cwd}`, "--", executable, ...args],
  },
  {
    executable: "konsole",
    label: "Konsole",
    args: (cwd, executable, args) => ["--workdir", cwd, "-e", executable, ...args],
  },
  {
    executable: "alacritty",
    label: "Alacritty",
    args: (cwd, executable, args) => ["--working-directory", cwd, "-e", executable, ...args],
  },
  {
    executable: "xterm",
    label: "XTerm",
    args: (_cwd, executable, args) => ["-e", executable, ...args],
  },
];

function hasControlCharacters(value: string) {
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code !== undefined && (code < 32 || code === 127)) return true;
  }
  return false;
}

function shellQuote(value: string) {
  if (/^[a-zA-Z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function createResumeDescriptor(session: ResumableSession): ResumeDescriptor | null {
  if (
    session.sourceSessionId.length === 0 ||
    session.sourceSessionId.length > 512 ||
    hasControlCharacters(session.sourceSessionId) ||
    !isAbsolute(session.cwd) ||
    hasControlCharacters(session.cwd)
  ) {
    return null;
  }

  const executable = session.source === "codex" ? "codex" : "claude";
  const args =
    session.source === "codex"
      ? ["resume", session.sourceSessionId]
      : ["--resume", session.sourceSessionId];
  const resumesParent = session.source === "claude" && session.agentId !== null;
  const label = resumesParent
    ? "Resume main thread"
    : session.source === "codex"
      ? "Resume in Codex"
      : "Resume in Claude Code";
  const command = `cd -- ${shellQuote(session.cwd)} && ${[executable, ...args].map(shellQuote).join(" ")}`;

  return {
    provider: session.source,
    executable,
    args,
    cwd: session.cwd,
    command,
    label,
    resumesParent,
  };
}

function executablePath(name: string, environment: NodeJS.ProcessEnv) {
  const path = environment["PATH"];
  if (!path) return null;

  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep searching the remaining PATH entries.
    }
  }
  return null;
}

function preferredTerminalName(environment: NodeJS.ProcessEnv) {
  const terminal = environment["TERMINAL"];
  if (terminal && !terminal.includes("/") && !/\s/.test(terminal)) return terminal;

  const program = environment["TERM_PROGRAM"]?.toLowerCase();
  if (program === "ghostty") return "ghostty";
  if (program === "wezterm") return "wezterm";
  return null;
}

function terminalCandidates(environment: NodeJS.ProcessEnv) {
  const preferred = preferredTerminalName(environment);
  return [
    ...(preferred === null ? [] : [preferred]),
    ...terminalDefinitions.map(({ executable }) => executable),
  ].filter((value, index, values) => values.indexOf(value) === index);
}

function resolveTerminal(environment: NodeJS.ProcessEnv) {
  for (const name of terminalCandidates(environment)) {
    const definition = terminalDefinitions.find(({ executable }) => executable === name);
    if (!definition) continue;
    const path = executablePath(name, environment);
    if (path) return { definition, path };
  }
  return null;
}

function validWorkingDirectory(cwd: string) {
  try {
    return statSync(cwd).isDirectory();
  } catch {
    return false;
  }
}

function providerLabel(provider: ResumeDescriptor["provider"]) {
  return provider === "codex" ? "Codex" : "Claude Code";
}

export function resumeAvailability(
  descriptor: ResumeDescriptor,
  environment: NodeJS.ProcessEnv = process.env,
): ResumeAvailability {
  if (!validWorkingDirectory(descriptor.cwd)) {
    return {
      canLaunch: false,
      terminal: null,
      reason: "The recorded working directory no longer exists.",
    };
  }
  if (!executablePath(descriptor.executable, environment)) {
    return {
      canLaunch: false,
      terminal: null,
      reason: `${providerLabel(descriptor.provider)} is not available on the server PATH.`,
    };
  }
  const terminal = resolveTerminal(environment);
  if (!terminal) {
    return {
      canLaunch: false,
      terminal: null,
      reason: "No supported terminal emulator is available.",
    };
  }
  return { canLaunch: true, terminal: terminal.definition.label, reason: null };
}

export async function launchResumeSession(
  descriptor: ResumeDescriptor,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (!validWorkingDirectory(descriptor.cwd)) {
    throw new ResumeLaunchError(
      "missing_working_directory",
      "The recorded working directory no longer exists.",
    );
  }
  const providerPath = executablePath(descriptor.executable, environment);
  if (!providerPath) {
    throw new ResumeLaunchError(
      "missing_provider",
      `${providerLabel(descriptor.provider)} is not available on the server PATH.`,
    );
  }
  const terminal = resolveTerminal(environment);
  if (!terminal) {
    throw new ResumeLaunchError("missing_terminal", "No supported terminal emulator is available.");
  }

  const args = terminal.definition.args(descriptor.cwd, providerPath, descriptor.args);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(terminal.path, args, {
      cwd: descriptor.cwd,
      detached: true,
      shell: false,
      stdio: "ignore",
      env: environment,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });

  return { terminal: terminal.definition.label };
}

export function isLoopbackAddress(address: string) {
  const normalized = address.replace(/^\[|\]$/g, "");
  return (
    normalized === "::1" ||
    normalized === "localhost" ||
    normalized.startsWith("127.") ||
    normalized.startsWith("::ffff:127.")
  );
}
