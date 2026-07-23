import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createResumeDescriptor,
  isLoopbackAddress,
  launchResumeSession,
  resumeAvailability,
} from "./resume.ts";

await test("builds provider-specific resume descriptors and quotes copied commands", () => {
  assert.deepEqual(
    createResumeDescriptor({
      source: "claude",
      sourceSessionId: "claude-session",
      cwd: "/tmp/project with 'quotes'",
      agentId: null,
    }),
    {
      provider: "claude",
      executable: "claude",
      args: ["--resume", "claude-session"],
      cwd: "/tmp/project with 'quotes'",
      command: "cd -- '/tmp/project with '\"'\"'quotes'\"'\"'' && claude --resume claude-session",
      label: "Resume in Claude Code",
      resumesParent: false,
    },
  );

  assert.deepEqual(
    createResumeDescriptor({
      source: "codex",
      sourceSessionId: "codex-thread",
      cwd: "/tmp/project",
      agentId: null,
    }),
    {
      provider: "codex",
      executable: "codex",
      args: ["resume", "codex-thread"],
      cwd: "/tmp/project",
      command: "cd -- /tmp/project && codex resume codex-thread",
      label: "Resume in Codex",
      resumesParent: false,
    },
  );
});

await test("routes Claude subagents to the parent source session and rejects unsafe metadata", () => {
  const descriptor = createResumeDescriptor({
    source: "claude",
    sourceSessionId: "parent-session",
    cwd: "/tmp/project",
    agentId: "agent-worker",
  });
  assert.equal(descriptor?.label, "Resume main thread");
  assert.equal(descriptor?.resumesParent, true);
  assert.deepEqual(descriptor?.args, ["--resume", "parent-session"]);

  assert.equal(
    createResumeDescriptor({
      source: "claude",
      sourceSessionId: "session\ninjection",
      cwd: "/tmp/project",
      agentId: null,
    }),
    null,
  );
  assert.equal(
    createResumeDescriptor({
      source: "codex",
      sourceSessionId: "thread",
      cwd: "relative/project",
      agentId: null,
    }),
    null,
  );
});

await test("resolves the active terminal and launches with fixed arguments", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aeye-resume-"));
  const bin = join(directory, "bin");
  const workingDirectory = join(directory, "project");
  const capturePath = join(directory, "terminal-args");
  mkdirSync(bin);
  mkdirSync(workingDirectory);

  const codexPath = join(bin, "codex");
  writeFileSync(codexPath, "#!/bin/sh\nexit 0\n");
  chmodSync(codexPath, 0o755);
  const ghosttyPath = join(bin, "ghostty");
  writeFileSync(ghosttyPath, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CAPTURE_PATH"\n');
  chmodSync(ghosttyPath, 0o755);

  try {
    const descriptor = createResumeDescriptor({
      source: "codex",
      sourceSessionId: "thread",
      cwd: workingDirectory,
      agentId: null,
    });
    assert.ok(descriptor);
    const environment = { PATH: bin, TERM_PROGRAM: "ghostty", CAPTURE_PATH: capturePath };
    assert.deepEqual(resumeAvailability(descriptor, environment), {
      canLaunch: true,
      terminal: "Ghostty",
      reason: null,
    });
    assert.deepEqual(await launchResumeSession(descriptor, environment), {
      terminal: "Ghostty",
    });
    for (let attempt = 0; attempt < 50 && !existsSync(capturePath); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(readFileSync(capturePath, "utf8").trimEnd().split("\n"), [
      `--working-directory=${workingDirectory}`,
      "-e",
      codexPath,
      "resume",
      "thread",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("reports unavailable launch dependencies and recognizes loopback clients", () => {
  const descriptor = createResumeDescriptor({
    source: "codex",
    sourceSessionId: "thread",
    cwd: "/missing/project",
    agentId: null,
  });
  assert.ok(descriptor);
  assert.equal(resumeAvailability(descriptor, { PATH: "" }).canLaunch, false);
  assert.equal(
    resumeAvailability(descriptor, { PATH: "" }).reason,
    "The recorded working directory no longer exists.",
  );

  const directory = mkdtempSync(join(tmpdir(), "aeye-resume-unavailable-"));

  try {
    const localDescriptor = createResumeDescriptor({
      source: "codex",
      sourceSessionId: "thread",
      cwd: directory,
      agentId: null,
    });
    assert.ok(localDescriptor);
    assert.deepEqual(resumeAvailability(localDescriptor, { PATH: "" }), {
      canLaunch: false,
      terminal: null,
      reason: "Codex is not available on the server PATH.",
    });

    const codexPath = join(directory, "codex");
    writeFileSync(codexPath, "#!/bin/sh\nexit 0\n");
    chmodSync(codexPath, 0o755);
    assert.deepEqual(resumeAvailability(localDescriptor, { PATH: directory }), {
      canLaunch: false,
      terminal: null,
      reason: "No supported terminal emulator is available.",
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  for (const address of ["127.0.0.1", "127.10.20.30", "::1", "[::1]", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackAddress(address), true);
  }
  assert.equal(isLoopbackAddress("192.168.1.4"), false);
  assert.equal(isLoopbackAddress("example.com"), false);
});
