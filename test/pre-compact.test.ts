import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPreCompactHook } from "../src/hooks/pre-compact.ts";
import { writeTranscriptFixture } from "./fixtures.ts";

let tmp: string;
let stdoutCapture: string;
let origStdoutWrite: typeof process.stdout.write;
let origStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "baton-test-"));
  stdoutCapture = "";
  origStdoutWrite = process.stdout.write.bind(process.stdout);
  origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutCapture += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
  rmSync(tmp, { recursive: true, force: true });
});

describe("runPreCompactHook", () => {
  test("manual trigger is a no-op", async () => {
    const code = await runPreCompactHook(JSON.stringify({ trigger: "manual", cwd: tmp }));
    expect(code).toBe(0);
    expect(stdoutCapture).toBe("");
  });

  test("fresh baton blocks compaction without rewriting", async () => {
    const baton = join(tmp, ".claude", "baton", "BATON.md");
    mkdirSync(join(tmp, ".claude", "baton"), { recursive: true });
    writeFileSync(baton, "# existing baton");
    const code = await runPreCompactHook(
      JSON.stringify({ trigger: "auto", cwd: tmp, transcript_path: "" }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutCapture);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("Type /clear to resume with the baton, or /drop then /clear to start completely fresh");
    expect(readFileSync(baton, "utf8")).toBe("# existing baton");
  });

  test("stale baton is not treated as fresh and fallback is written", async () => {
    const batonDir = join(tmp, ".claude", "baton");
    mkdirSync(batonDir, { recursive: true });
    const baton = join(batonDir, "BATON.md");
    writeFileSync(baton, "# stale");
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(baton, oneHourAgo, oneHourAgo);

    const transcript = writeTranscriptFixture(tmp, "transcript.jsonl", {
      inputTokens: 120_000,
      cacheRead: 5_000,
    });

    const code = await runPreCompactHook(
      JSON.stringify({ trigger: "auto", cwd: tmp, transcript_path: transcript }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutCapture);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("Type /clear to resume with the baton, or /drop then /clear to start completely fresh");
    const written = readFileSync(baton, "utf8");
    expect(written).toContain("# Baton");
    expect(written).toContain("src/foo.ts:42");
  });

  test("fallback write failure still emits block decision with error reason", async () => {
    // Force writeFallbackBaton to fail by placing a file where it expects a directory.
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    writeFileSync(join(tmp, ".claude", "baton"), "i am a file, not a directory");

    const transcript = writeTranscriptFixture(tmp, "transcript.jsonl", {
      inputTokens: 120_000,
    });
    const code = await runPreCompactHook(
      JSON.stringify({ trigger: "auto", cwd: tmp, transcript_path: transcript }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutCapture);
    expect(parsed.decision).toBe("block");
    expect(parsed.reason).toContain("FAILED");
  });

  test("missing baton triggers fallback write and block", async () => {
    const transcript = writeTranscriptFixture(tmp, "transcript.jsonl", {
      inputTokens: 120_000,
      cacheRead: 5_000,
    });
    const code = await runPreCompactHook(
      JSON.stringify({ trigger: "auto", cwd: tmp, transcript_path: transcript }),
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutCapture);
    expect(parsed.decision).toBe("block");
    expect(existsSync(join(tmp, ".claude", "baton", "BATON.md"))).toBe(true);
  });
});
