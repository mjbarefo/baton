import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_HOME } from "./helpers/test-home.ts";

type SpawnMode = "exit" | "error";
let spawnMode: SpawnMode = "exit";
let spawnExitCode = 0;
const spawnCalls: unknown[][] = [];
const stdinWrites: string[] = [];
let spawnSyncOnPath = true;
const spawnSyncCalls: unknown[][] = [];
const actualChildProcess = await import("node:child_process");

mock.module("node:child_process", () => ({
  ...actualChildProcess,
  spawn: (...args: unknown[]) => {
    spawnCalls.push(args);
    const child = new EventEmitter() as EventEmitter & {
      stdin: { end: (chunk?: unknown) => void };
    };
    child.stdin = {
      end: (chunk?: unknown) => {
        stdinWrites.push(chunk === undefined ? "" : String(chunk));
      },
    };
    queueMicrotask(() => {
      if (spawnMode === "error") child.emit("error", new Error("not found"));
      else child.emit("exit", spawnExitCode);
    });
    return child;
  },
  spawnSync: (...args: unknown[]) => {
    spawnSyncCalls.push(args);
    return { status: spawnSyncOnPath ? 0 : 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), pid: 0, output: [] };
  },
}));

const { runSidecar } = await import("../src/sidecar/run.ts");

const SAMPLE_BATON = "# Baton\n\n## Current Goal\nShip the sidecar feature.\n\n## Next Concrete Action\nWrite tests.\n";

let tmp: string;
let stdoutCapture: string;
let stderrCapture: string;
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

function writeBaton(project: string, body = SAMPLE_BATON): string {
  const dir = join(project, ".baton");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "BATON.md");
  writeFileSync(path, body);
  return path;
}

beforeEach(() => {
  tmp = join(tmpdir(), `baton-sidecar-${crypto.randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  rmSync(join(TEST_HOME, ".claude"), { recursive: true, force: true });
  rmSync(join(TEST_HOME, ".baton"), { recursive: true, force: true });
  spawnMode = "exit";
  spawnExitCode = 0;
  spawnCalls.length = 0;
  stdinWrites.length = 0;
  spawnSyncOnPath = true;
  spawnSyncCalls.length = 0;
  stdoutCapture = "";
  stderrCapture = "";
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutCapture += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrCapture += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(join(TEST_HOME, ".claude"), { recursive: true, force: true });
  rmSync(join(TEST_HOME, ".baton"), { recursive: true, force: true });
});

describe("runSidecar", () => {
  test("dry-run for codex review prints argv on stdout and prompt on stderr", async () => {
    writeBaton(tmp);

    const code = await runSidecar({ host: "codex", mode: "review", cwd: tmp, dryRun: true });

    expect(code).toBe(0);
    const argv = JSON.parse(stdoutCapture.trim());
    expect(argv[0]).toBe("codex");
    expect(argv).toContain("exec");
    expect(argv).toContain("--sandbox");
    expect(argv[argv.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(argv).toContain("--ephemeral");
    expect(argv).toContain("-c");
    expect(argv[argv.indexOf("-c") + 1]).toBe("model_reasoning_effort=xhigh");
    expect(argv[argv.length - 1]).toBe("-");
    expect(stdoutCapture).not.toContain("Ship the sidecar feature");
    // And it's also echoed on stderr verbatim for human inspection.
    expect(stderrCapture).toContain("reviewing another agent's working state");
    expect(stderrCapture).toContain("Ship the sidecar feature");
    expect(spawnCalls).toHaveLength(0);
  });

  test("dry-run preamble varies per mode", async () => {
    writeBaton(tmp);

    await runSidecar({ host: "codex", mode: "critique", cwd: tmp, dryRun: true });
    const critiqueArgv = JSON.parse(stdoutCapture.trim().split("\n")[0]!);
    expect(critiqueArgv[critiqueArgv.length - 1]).toBe("-");
    expect(stderrCapture).toContain("arguing against");

    stdoutCapture = "";
    stderrCapture = "";
    await runSidecar({ host: "codex", mode: "alternative", cwd: tmp, dryRun: true });
    const altArgv = JSON.parse(stdoutCapture.trim().split("\n")[0]!);
    expect(altArgv[altArgv.length - 1]).toBe("-");
    expect(stderrCapture).toContain("substantively different approach");
  });

  test("missing BATON.md returns exit 1 with a pointer to /baton", async () => {
    const code = await runSidecar({ host: "codex", mode: "review", cwd: tmp, dryRun: true });

    expect(code).toBe(1);
    expect(stderrCapture).toContain("no .baton/BATON.md");
    expect(stderrCapture).toContain("/baton");
    expect(spawnCalls).toHaveLength(0);
  });

  test("unknown host returns exit 2", async () => {
    writeBaton(tmp);
    const code = await runSidecar({
      host: "ghibli" as unknown as "codex",
      mode: "review",
      cwd: tmp,
      dryRun: true,
    });
    expect(code).toBe(2);
    expect(stderrCapture).toContain("unknown host");
  });

  test("invalid mode returns exit 2", async () => {
    writeBaton(tmp);
    const code = await runSidecar({
      host: "codex",
      mode: "loaf" as unknown as "review",
      cwd: tmp,
      dryRun: true,
    });
    expect(code).toBe(2);
    expect(stderrCapture).toContain("invalid mode");
  });

  test("redacts Anthropic API key in BATON.md before sending", async () => {
    const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890-abcdefg";
    writeBaton(tmp, `# Baton\n\nMy key is ${SECRET}\n`);

    const code = await runSidecar({ host: "codex", mode: "review", cwd: tmp, dryRun: true });

    expect(code).toBe(0);
    expect(stderrCapture).toContain("redacted 1 secret");
    expect(stderrCapture).toContain("[redacted Anthropic API key]");
    expect(stderrCapture).not.toContain(SECRET);
    expect(stdoutCapture).not.toContain(SECRET);
    const argv = JSON.parse(stdoutCapture.trim());
    expect(argv[argv.length - 1]).toBe("-");
    expect(stderrCapture).toContain("[redacted Anthropic API key]");
  });

  test("project-local .batonignore patterns are applied", async () => {
    writeBaton(tmp, "# Baton\n\nproject-secret-XYZZY42\n");
    writeFileSync(join(tmp, ".batonignore"), "project secret:::project-secret-[A-Z0-9]+\n");

    const code = await runSidecar({ host: "codex", mode: "review", cwd: tmp, dryRun: true });

    expect(code).toBe(0);
    expect(stderrCapture).toContain("[redacted project secret]");
    expect(stderrCapture).not.toContain("project-secret-XYZZY42");
  });

  test("project-root .batonignore patterns are applied when launched from a subdirectory", async () => {
    const nested = join(tmp, "src", "nested");
    mkdirSync(nested, { recursive: true });
    writeBaton(tmp, "# Baton\n\nproject-secret-XYZZY42\n");
    writeFileSync(join(tmp, ".batonignore"), "project secret:::project-secret-[A-Z0-9]+\n");

    const code = await runSidecar({ host: "codex", mode: "review", cwd: nested, dryRun: true });

    expect(code).toBe(0);
    expect(stderrCapture).toContain("[redacted project secret]");
    expect(stderrCapture).not.toContain("project-secret-XYZZY42");
  });

  test("dry-run for gemini review prints argv on stdout and prompt on stderr", async () => {
    writeBaton(tmp);
    const code = await runSidecar({ host: "gemini", mode: "review", cwd: tmp, dryRun: true });

    expect(code).toBe(0);
    const argv = JSON.parse(stdoutCapture.trim());
    expect(argv[0]).toBe("gemini");
    expect(argv).toContain("--prompt");
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("pro");
    expect(argv).toContain("--approval-mode");
    expect(argv[argv.indexOf("--approval-mode") + 1]).toBe("plan");
    expect(argv).not.toContain("--skip-trust");
    const prompt = argv[argv.indexOf("--prompt") + 1] as string;
    expect(prompt).toContain("reviewing another agent's working state");
    expect(prompt).toContain("Do not modify files");
    expect(prompt).toContain("Ship the sidecar feature");
    expect(stderrCapture).toBe(`${prompt}\n`);
    expect(spawnCalls).toHaveLength(0);
  });

  test("missing gemini binary on PATH exits 2 with install hint", async () => {
    writeBaton(tmp);
    spawnSyncOnPath = false;

    const code = await runSidecar({ host: "gemini", mode: "review", cwd: tmp });

    expect(code).toBe(2);
    expect(stderrCapture).toContain("'gemini' not found on PATH");
    expect(stderrCapture).toContain("google-gemini/gemini-cli");
    expect(spawnCalls).toHaveLength(0);
  });

  test("with gemini on PATH, passes prompt in argv and cwd set", async () => {
    writeBaton(tmp);
    spawnExitCode = 9;

    const code = await runSidecar({ host: "gemini", mode: "critique", cwd: tmp });

    expect(code).toBe(9);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.[0]).toBe("gemini");
    const argv = spawnCalls[0]?.[1] as string[];
    expect(argv[0]).toBe("--prompt");
    expect(argv[1]).toContain("arguing against");
    expect(argv).toContain("--model");
    expect(argv[argv.indexOf("--model") + 1]).toBe("pro");
    expect(argv).toContain("--approval-mode");
    expect(argv[argv.indexOf("--approval-mode") + 1]).toBe("plan");
    expect(argv).not.toContain("--skip-trust");
    expect(stdinWrites).toHaveLength(0);
    expect(spawnCalls[0]?.[2]).toMatchObject({
      stdio: "inherit",
      cwd: tmp,
    });
  });

  test("redacts secrets in gemini argv", async () => {
    const SECRET = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890-abcdefg";
    writeBaton(tmp, `# Baton\n\nMy key is ${SECRET}\n`);

    const code = await runSidecar({ host: "gemini", mode: "review", cwd: tmp, dryRun: true });

    expect(code).toBe(0);
    expect(stderrCapture).toContain("redacted 1 secret");
    expect(stdoutCapture).not.toContain(SECRET);
    expect(stderrCapture).not.toContain(SECRET);
    expect(stdoutCapture).toContain("[redacted Anthropic API key]");
    const argv = JSON.parse(stdoutCapture.trim());
    const prompt = argv[argv.indexOf("--prompt") + 1] as string;
    expect(prompt).toContain("[redacted Anthropic API key]");
    expect(prompt).not.toContain(SECRET);
  });

  test("missing codex binary on PATH exits 2 with install hint", async () => {
    writeBaton(tmp);
    spawnSyncOnPath = false;

    const code = await runSidecar({ host: "codex", mode: "review", cwd: tmp });

    expect(code).toBe(2);
    expect(stderrCapture).toContain("'codex' not found on PATH");
    expect(stderrCapture).toContain("github.com/openai/codex");
    expect(spawnCalls).toHaveLength(0);
  });

  test("with codex on PATH, pipes prompt over stdin and cwd set", async () => {
    writeBaton(tmp);
    spawnExitCode = 7;

    const code = await runSidecar({ host: "codex", mode: "alternative", cwd: tmp });

    expect(code).toBe(7);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.[0]).toBe("codex");
    const argv = spawnCalls[0]?.[1] as string[];
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("--ephemeral");
    expect(argv[argv.length - 1]).toBe("-");
    expect(argv.join("\0")).not.toContain("substantively different approach");
    expect(stdinWrites).toHaveLength(1);
    expect(stdinWrites[0]).toContain("substantively different approach");
    expect(spawnCalls[0]?.[2]).toMatchObject({
      stdio: ["pipe", "inherit", "inherit"],
      cwd: tmp,
    });
  });

  test("baton body is unmodified on disk after a sidecar run", async () => {
    const path = writeBaton(tmp, "# Baton\noriginal contents\n");
    const before = (await import("node:fs")).readFileSync(path, "utf8");

    await runSidecar({ host: "codex", mode: "review", cwd: tmp, dryRun: true });

    const after = (await import("node:fs")).readFileSync(path, "utf8");
    expect(after).toBe(before);
  });
});
