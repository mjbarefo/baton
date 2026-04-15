import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const testHome = mkdtempSync(join(tmpdir(), "baton-session-start-home-"));
process.env.USERPROFILE = testHome;
process.env.HOME = testHome;

const { runSessionStartHook } = await import("../src/hooks/session-start.ts");
const { BATON_ARCHIVE_DIR, USER_CLAUDE_DIR } = await import("../src/config.ts");

let tmp: string;
let stdoutCapture: string;
let stderrCapture: string;
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "baton-session-start-"));
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
  rmSync(USER_CLAUDE_DIR, { recursive: true, force: true });
});

describe("session-start hook", () => {
  test('source: "startup" -> no output, no archive side-effect', async () => {
    const handoffDir = join(tmp, ".claude", "baton");
    mkdirSync(handoffDir, { recursive: true });
    writeFileSync(join(handoffDir, "BATON.md"), "# baton\n");

    const code = await runSessionStartHook(JSON.stringify({ source: "startup", cwd: tmp }));

    expect(code).toBe(0);
    expect(stdoutCapture).toBe("");
    expect(stderrCapture).toBe("");
    expect(existsSync(join(handoffDir, "BATON.md"))).toBe(true);
    expect(existsSync(BATON_ARCHIVE_DIR)).toBe(false);
  });

  test('source: "clear" + fresh handoff -> emits additionalContext and archives handoff', async () => {
    const handoffDir = join(tmp, ".claude", "baton");
    mkdirSync(handoffDir, { recursive: true });
    writeFileSync(join(handoffDir, "BATON.md"), "# baton\nnext step\n");

    const code = await runSessionStartHook(JSON.stringify({ source: "clear", cwd: tmp }));

    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutCapture);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("# baton");
    expect(parsed.hookSpecificOutput.additionalContext).toContain('execute the "Next Concrete Action"');
    expect(existsSync(join(handoffDir, "BATON.md"))).toBe(false);

    const entries = readdirSync(BATON_ARCHIVE_DIR);
    expect(entries).toHaveLength(1);
    const archived = entries[0]!;
    expect(archived).toStartWith(tmp.split(/[/\\]/).pop() + "-");
    expect(readFileSync(join(BATON_ARCHIVE_DIR, archived), "utf8")).toContain("next step");
  });

  test('source: "clear" + stale handoff -> no output, file not touched', async () => {
    const handoffDir = join(tmp, ".claude", "baton");
    mkdirSync(handoffDir, { recursive: true });
    const handoffPath = join(handoffDir, "BATON.md");
    writeFileSync(handoffPath, "# stale\n");
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(handoffPath, oneHourAgo, oneHourAgo);

    const code = await runSessionStartHook(JSON.stringify({ source: "clear", cwd: tmp }));

    expect(code).toBe(0);
    expect(stdoutCapture).toBe("");
    expect(stderrCapture).toBe("");
    expect(existsSync(handoffPath)).toBe(true);
    expect(existsSync(BATON_ARCHIVE_DIR)).toBe(false);
  });

  test('source: "clear" + no handoff -> no output, return 0', async () => {
    const code = await runSessionStartHook(JSON.stringify({ source: "clear", cwd: tmp }));

    expect(code).toBe(0);
    expect(stdoutCapture).toBe("");
    expect(stderrCapture).toBe("");
  });

  test('source: "resume" + fresh handoff -> same behavior as clear', async () => {
    const handoffDir = join(tmp, ".claude", "baton");
    mkdirSync(handoffDir, { recursive: true });
    writeFileSync(join(handoffDir, "BATON.md"), "# baton\nresume\n");

    const code = await runSessionStartHook(JSON.stringify({ source: "resume", cwd: tmp }));

    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutCapture);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("Trust the baton.");
    expect(existsSync(join(handoffDir, "BATON.md"))).toBe(false);
  });

  test("malformed JSON payload -> return 0, no crash", async () => {
    const code = await runSessionStartHook("{");

    expect(code).toBe(0);
    expect(stdoutCapture).toBe("");
    expect(stderrCapture).toBe("");
  });
});
