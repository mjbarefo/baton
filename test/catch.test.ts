import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_HOME } from "./helpers/test-home.ts";

type SpawnMode = "exit" | "error";
let spawnMode: SpawnMode = "exit";
const spawnCalls: unknown[][] = [];
const actualChildProcess = await import("node:child_process");

mock.module("node:child_process", () => ({
  ...actualChildProcess,
  spawn: (...args: unknown[]) => {
    spawnCalls.push(args);
    const child = new EventEmitter();
    queueMicrotask(() => {
      if (spawnMode === "error") {
        child.emit("error", new Error("claude not found"));
      } else {
        child.emit("exit", 0);
      }
    });
    return child;
  },
}));

const { catchBaton } = await import("../src/baton/catch.ts");
const { BATON_ARCHIVE_DIR } = await import("../src/config.ts");

let tmp: string;
let stdoutCapture: string;
let stderrCapture: string;
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

function writeBaton(project: string, body = "# Baton\nnext\n"): string {
  const dir = join(project, ".claude", "baton");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "BATON.md");
  writeFileSync(path, body);
  return path;
}

beforeEach(() => {
  tmp = join(tmpdir(), `baton-catch-${crypto.randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  rmSync(join(TEST_HOME, ".claude"), { recursive: true, force: true });
  spawnMode = "exit";
  spawnCalls.length = 0;
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
});

describe("catchBaton", () => {
  test("archives an existing baton and spawns claude with the archive path", async () => {
    const project = join(tmp, "project-a");
    const baton = writeBaton(project, "# Baton\nhappy path\n");

    const code = await catchBaton({ cwd: project });

    expect(code).toBe(0);
    expect(existsSync(baton)).toBe(false);
    const archived = readdirSync(BATON_ARCHIVE_DIR);
    expect(archived).toHaveLength(1);
    expect(archived[0]).toStartWith("project-a-");
    const archivePath = join(BATON_ARCHIVE_DIR, archived[0]!);
    expect(readFileSync(archivePath, "utf8")).toContain("happy path");
    expect(stdoutCapture).toContain(archivePath);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.[0]).toBe("claude");
    expect(spawnCalls[0]?.[1]).toEqual([expect.stringContaining(archivePath)]);
    expect(spawnCalls[0]?.[2]).toMatchObject({ stdio: "inherit", cwd: project });
    expect(spawnCalls[0]?.[2]).not.toHaveProperty("shell");
  });

  test("reports the archive path when spawning claude fails", async () => {
    spawnMode = "error";
    const project = join(tmp, "project-b");
    writeBaton(project, "# Baton\nspawn fails\n");

    const code = await catchBaton({ cwd: project });

    expect(code).toBe(1);
    const archived = readdirSync(BATON_ARCHIVE_DIR);
    expect(archived).toHaveLength(1);
    const archivePath = join(BATON_ARCHIVE_DIR, archived[0]!);
    expect(stderrCapture).toContain("failed to spawn claude");
    expect(stderrCapture).toContain(archivePath);
    expect(existsSync(archivePath)).toBe(true);
  });

  test("returns a graceful error when no baton exists", async () => {
    const code = await catchBaton({ cwd: tmp });

    expect(code).toBe(1);
    expect(stderrCapture).toContain("no .claude/baton/BATON.md found");
    expect(spawnCalls).toHaveLength(0);
  });

  test("dry-run does not archive or spawn", async () => {
    const project = join(tmp, "project-c");
    const baton = writeBaton(project);

    const code = await catchBaton({ cwd: project, dryRun: true });

    expect(code).toBe(0);
    expect(existsSync(baton)).toBe(true);
    expect(existsSync(BATON_ARCHIVE_DIR)).toBe(false);
    expect(stdoutCapture).toContain("[dry-run]");
    expect(spawnCalls).toHaveLength(0);
  });
});
