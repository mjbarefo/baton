import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import "./helpers/test-home.ts";
import { runPreCompactHook } from "../src/hooks/pre-compact.ts";
import { batonStateDir, MAX_COMPACT_BLOCKS } from "../src/config.ts";
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
  test("manual trigger blocks (explicit, not silent allow)", async () => {
    const code = await runPreCompactHook(JSON.stringify({ trigger: "manual", cwd: tmp }));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdoutCapture);
    expect(parsed.decision).toBe("block");
  });

  test("fresh baton blocks compaction without rewriting", async () => {
    const baton = join(tmp, ".baton", "BATON.md");
    mkdirSync(join(tmp, ".baton"), { recursive: true });
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
    const batonDir = join(tmp, ".baton");
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
    writeFileSync(join(tmp, ".baton"), "i am a file, not a directory");

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
    expect(existsSync(join(tmp, ".baton", "BATON.md"))).toBe(true);
  });

  describe("escape hatch", () => {
    const sessionId = "precompact-escape-test";
    const statePath = () => join(batonStateDir(), `${sessionId}.json`);

    beforeEach(() => {
      rmSync(statePath(), { force: true });
    });

    afterEach(() => {
      rmSync(statePath(), { force: true });
    });

    test("blocks increment the per-session counter and annotate the reason", async () => {
      const baton = join(tmp, ".baton", "BATON.md");
      mkdirSync(join(tmp, ".baton"), { recursive: true });
      writeFileSync(baton, "# existing baton");

      const code = await runPreCompactHook(
        JSON.stringify({ trigger: "auto", cwd: tmp, session_id: sessionId, transcript_path: "" }),
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(stdoutCapture);
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain(`Block 1/${MAX_COMPACT_BLOCKS}`);
      const state = JSON.parse(readFileSync(statePath(), "utf8"));
      expect(state.compactBlocks).toBe(1);
    });

    test("allows compaction after MAX_COMPACT_BLOCKS ignored blocks and resets the counter", async () => {
      const baton = join(tmp, ".baton", "BATON.md");
      mkdirSync(join(tmp, ".baton"), { recursive: true });
      writeFileSync(baton, "# existing baton");
      mkdirSync(batonStateDir(), { recursive: true });
      writeFileSync(statePath(), JSON.stringify({ compactBlocks: MAX_COMPACT_BLOCKS, maxTokens: 200_000 }));

      const code = await runPreCompactHook(
        JSON.stringify({ trigger: "auto", cwd: tmp, session_id: sessionId, transcript_path: "" }),
      );
      expect(code).toBe(0);
      // Empty stdout = allow per the PreCompact spec.
      expect(stdoutCapture).toBe("");
      const state = JSON.parse(readFileSync(statePath(), "utf8"));
      expect(state.compactBlocks).toBe(0);
      // Other state fields survive the reset.
      expect(state.maxTokens).toBe(200_000);
      // The baton itself is untouched.
      expect(readFileSync(baton, "utf8")).toBe("# existing baton");
    });

    test("counter is preserved alongside fields written by other hooks", async () => {
      mkdirSync(batonStateDir(), { recursive: true });
      writeFileSync(statePath(), JSON.stringify({ level: "soft", maxTokens: 150_000 }));
      const baton = join(tmp, ".baton", "BATON.md");
      mkdirSync(join(tmp, ".baton"), { recursive: true });
      writeFileSync(baton, "# existing baton");

      await runPreCompactHook(
        JSON.stringify({ trigger: "auto", cwd: tmp, session_id: sessionId, transcript_path: "" }),
      );
      const state = JSON.parse(readFileSync(statePath(), "utf8"));
      expect(state.compactBlocks).toBe(1);
      expect(state.level).toBe("soft");
      expect(state.maxTokens).toBe(150_000);
    });

    test("no session_id falls back to always blocking", async () => {
      const baton = join(tmp, ".baton", "BATON.md");
      mkdirSync(join(tmp, ".baton"), { recursive: true });
      writeFileSync(baton, "# existing baton");

      const code = await runPreCompactHook(
        JSON.stringify({ trigger: "auto", cwd: tmp, transcript_path: "" }),
      );
      expect(code).toBe(0);
      const parsed = JSON.parse(stdoutCapture);
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).not.toContain("Block 1/");
    });
  });
});
