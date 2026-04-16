import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TEST_HOME } from "./helpers/test-home.ts";

// Import after TEST_HOME sets USERPROFILE/HOME so batonStateDir() resolves correctly.
const { runUserPromptSubmitHook } = await import("../src/hooks/user-prompt-submit.ts");

const STATE_DIR = join(TEST_HOME, ".claude", "baton", "state");

let tmp: string;
let stdoutCapture: string;
let origWrite: typeof process.stdout.write;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "baton-ups-"));
  stdoutCapture = "";
  origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutCapture += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stdout.write;
  rmSync(STATE_DIR, { recursive: true, force: true });
});

afterEach(() => {
  process.stdout.write = origWrite;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(STATE_DIR, { recursive: true, force: true });
});

function writeTranscript(tokens: number): string {
  const path = join(tmp, "transcript.jsonl");
  const entry = JSON.stringify({
    type: "assistant",
    isSidechain: false,
    isApiErrorMessage: false,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "response" }],
      usage: { input_tokens: tokens, cache_read_input_tokens: 0, output_tokens: 0 },
    },
  });
  writeFileSync(path, entry + "\n");
  return path;
}

function writeStateFile(sessionId: string, state: object): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, `${sessionId}.json`), JSON.stringify(state));
}

const SIX_HOURS_AGO = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
const THIRTY_MIN_AGO = new Date(Date.now() - 30 * 60 * 1000).toISOString();

/** Transcript with a timestamped first entry followed by an assistant usage entry. */
function writeTranscriptWithAge(tokens: number, firstTimestamp: string): string {
  const path = join(tmp, `transcript-${firstTimestamp.slice(0, 10)}-${tokens}.jsonl`);
  const firstEntry = JSON.stringify({
    type: "user",
    isSidechain: false,
    isApiErrorMessage: false,
    timestamp: firstTimestamp,
    message: { role: "user", content: "hello" },
  });
  const assistantEntry = JSON.stringify({
    type: "assistant",
    isSidechain: false,
    isApiErrorMessage: false,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "response" }],
      usage: { input_tokens: tokens, cache_read_input_tokens: 0, output_tokens: 0 },
    },
  });
  writeFileSync(path, firstEntry + "\n" + assistantEntry + "\n");
  return path;
}

describe("runUserPromptSubmitHook — level transitions", () => {
  test("none → soft: fires when tokens cross NUDGE_SOFT with no prior state", async () => {
    const transcript = writeTranscript(112_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "trans-none-soft", transcript_path: transcript, cwd: tmp }),
    );
    const out = JSON.parse(stdoutCapture);
    expect(out.hookSpecificOutput.additionalContext).toContain("[baton]");
    expect(out.hookSpecificOutput.additionalContext).not.toContain("CRITICAL");
    const state = JSON.parse(readFileSync(join(STATE_DIR, "trans-none-soft.json"), "utf8"));
    expect(state.level).toBe("soft");
  });

  test("soft → hard: fires when tokens cross NUDGE_HARD from soft state", async () => {
    writeStateFile("trans-soft-hard", { level: "soft", maxTokens: 200_000 });
    const transcript = writeTranscript(122_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "trans-soft-hard", transcript_path: transcript, cwd: tmp }),
    );
    const out = JSON.parse(stdoutCapture);
    expect(out.hookSpecificOutput.additionalContext).toContain("CRITICAL");
    const state = JSON.parse(readFileSync(join(STATE_DIR, "trans-soft-hard.json"), "utf8"));
    expect(state.level).toBe("hard");
  });

  test("none → hard: fires when first observed tokens are already above NUDGE_HARD", async () => {
    const transcript = writeTranscript(122_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "trans-none-hard", transcript_path: transcript, cwd: tmp }),
    );
    const out = JSON.parse(stdoutCapture);
    expect(out.hookSpecificOutput.additionalContext).toContain("CRITICAL");
  });

  test("hard → hard: does not re-fire when already at hard", async () => {
    writeStateFile("trans-hard-noop", { level: "hard", maxTokens: 200_000 });
    const transcript = writeTranscript(122_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "trans-hard-noop", transcript_path: transcript, cwd: tmp }),
    );
    expect(stdoutCapture).toBe("");
  });
});

describe("runUserPromptSubmitHook — state normalization regression", () => {
  test("soft nudge fires when state file has only maxTokens (no level field)", async () => {
    // Reproduces the bug: statusline writes { maxTokens } before any hook has set level.
    // Without normalization, prior.level is undefined, which !== "none", so soft nudge was skipped.
    writeStateFile("norm-regression", { maxTokens: 200_000 });
    const transcript = writeTranscript(112_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "norm-regression", transcript_path: transcript, cwd: tmp }),
    );
    expect(stdoutCapture).not.toBe("");
    const out = JSON.parse(stdoutCapture);
    expect(out.hookSpecificOutput.additionalContext).toContain("[baton]");
    expect(out.hookSpecificOutput.additionalContext).not.toContain("CRITICAL");
  });

  test("maxTokens is preserved after normalization write", async () => {
    writeStateFile("norm-preserve", { maxTokens: 128_000 });
    const transcript = writeTranscript(112_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "norm-preserve", transcript_path: transcript, cwd: tmp }),
    );
    const state = JSON.parse(readFileSync(join(STATE_DIR, "norm-preserve.json"), "utf8"));
    expect(state.maxTokens).toBe(128_000);
    expect(state.level).toBe("soft");
  });
});

describe("runUserPromptSubmitHook — session-age nudge", () => {
  test("fires once when session is old enough and tokens are non-trivial", async () => {
    const transcript = writeTranscriptWithAge(50_000, SIX_HOURS_AGO);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "age-fires", transcript_path: transcript, cwd: tmp }),
    );
    const out = JSON.parse(stdoutCapture);
    expect(out.hookSpecificOutput.additionalContext).toContain("[baton]");
    expect(out.hookSpecificOutput.additionalContext).toContain("h old");
  });

  test("sets timeNudgeSent after firing so it does not re-fire", async () => {
    const transcript = writeTranscriptWithAge(50_000, SIX_HOURS_AGO);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "age-once", transcript_path: transcript, cwd: tmp }),
    );
    expect(stdoutCapture).not.toBe("");
    stdoutCapture = "";

    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "age-once", transcript_path: transcript, cwd: tmp }),
    );
    expect(stdoutCapture).toBe("");
  });

  test("does not fire when session is too young", async () => {
    const transcript = writeTranscriptWithAge(50_000, THIRTY_MIN_AGO);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "age-young", transcript_path: transcript, cwd: tmp }),
    );
    expect(stdoutCapture).toBe("");
  });

  test("does not fire when tokens are below the minimum floor", async () => {
    const transcript = writeTranscriptWithAge(20_000, SIX_HOURS_AGO);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "age-low-tokens", transcript_path: transcript, cwd: tmp }),
    );
    expect(stdoutCapture).toBe("");
  });

  test("does not fire when token pressure is already active (token nudge takes priority)", async () => {
    // Tokens above NUDGE_SOFT — token nudge fires instead; age nudge path is not reached.
    const transcript = writeTranscriptWithAge(112_000, SIX_HOURS_AGO);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "age-token-priority", transcript_path: transcript, cwd: tmp }),
    );
    const out = JSON.parse(stdoutCapture);
    // Should be the token nudge message, not the age nudge message.
    expect(out.hookSpecificOutput.additionalContext).not.toContain("h old");
    expect(out.hookSpecificOutput.additionalContext).toContain("[baton]");
  });
});

describe("runUserPromptSubmitHook — max_tokens sourcing", () => {
  test("below threshold: no output emitted", async () => {
    const transcript = writeTranscript(50_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "sess-low", transcript_path: transcript, cwd: tmp }),
    );
    expect(stdoutCapture).toBe("");
  });

  test("soft nudge falls back to 200k when state has no maxTokens", async () => {
    const transcript = writeTranscript(112_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "sess-fallback", transcript_path: transcript, cwd: tmp }),
    );
    const out = JSON.parse(stdoutCapture);
    expect(out.hookSpecificOutput.additionalContext).toContain("200k");
  });

  test("soft nudge uses maxTokens from state file when present", async () => {
    const sessionId = "sess-with-max";
    writeStateFile(sessionId, { level: "none", maxTokens: 128_000 });

    const transcript = writeTranscript(112_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: tmp }),
    );
    const out = JSON.parse(stdoutCapture);
    expect(out.hookSpecificOutput.additionalContext).toContain("128k");
    expect(out.hookSpecificOutput.additionalContext).not.toContain("200k");
  });

  test("hard nudge uses maxTokens from state file when present", async () => {
    const sessionId = "sess-hard-max";
    writeStateFile(sessionId, { level: "soft", maxTokens: 150_000 });

    const transcript = writeTranscript(122_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: tmp }),
    );
    const out = JSON.parse(stdoutCapture);
    expect(out.hookSpecificOutput.additionalContext).toContain("150k");
    expect(out.hookSpecificOutput.additionalContext).not.toContain("200k");
  });

  test("writeState preserves maxTokens when level is updated", async () => {
    const sessionId = "sess-preserve";
    writeStateFile(sessionId, { level: "none", maxTokens: 128_000 });

    const transcript = writeTranscript(112_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: tmp }),
    );

    const statePath = join(STATE_DIR, `${sessionId}.json`);
    const written = JSON.parse(readFileSync(statePath, "utf8"));
    expect(written.level).toBe("soft");
    expect(written.maxTokens).toBe(128_000);
  });

  test("soft nudge not re-sent once level is already soft", async () => {
    const sessionId = "sess-no-repeat";
    writeStateFile(sessionId, { level: "soft", maxTokens: 200_000 });

    const transcript = writeTranscript(112_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: tmp }),
    );
    expect(stdoutCapture).toBe("");
  });

  test("hard nudge not re-sent once level is already hard", async () => {
    const sessionId = "sess-no-hard-repeat";
    writeStateFile(sessionId, { level: "hard", maxTokens: 200_000 });

    const transcript = writeTranscript(122_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: tmp }),
    );
    expect(stdoutCapture).toBe("");
  });

  test("state file does not exist when level never reaches threshold", async () => {
    const sessionId = "sess-no-state";
    const transcript = writeTranscript(50_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: tmp }),
    );
    expect(existsSync(join(STATE_DIR, `${sessionId}.json`))).toBe(false);
  });
});
