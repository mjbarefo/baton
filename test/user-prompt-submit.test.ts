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

const STATE_DIR = join(TEST_HOME, ".baton", "state");

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

describe("runUserPromptSubmitHook — per-model thresholds", () => {
  test("sonnet soft nudge fires below the flat NUDGE_SOFT threshold", async () => {
    // 105k/200k = 0.525: above sonnet's 0.50 soft threshold, below the flat 0.55.
    writeStateFile("model-sonnet-soft", { level: "none", maxTokens: 200_000, modelId: "claude-sonnet-4-6" });
    const transcript = writeTranscript(105_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "model-sonnet-soft", transcript_path: transcript, cwd: tmp }),
    );
    const out = JSON.parse(stdoutCapture);
    expect(out.hookSpecificOutput.additionalContext).toContain("[baton]");
    expect(out.hookSpecificOutput.additionalContext).not.toContain("CRITICAL");
  });

  test("same token count without a model id stays quiet", async () => {
    writeStateFile("model-none-soft", { level: "none", maxTokens: 200_000 });
    const transcript = writeTranscript(105_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "model-none-soft", transcript_path: transcript, cwd: tmp }),
    );
    expect(stdoutCapture).toBe("");
  });

  test("sonnet hard nudge fires at its scaled threshold", async () => {
    // 112k/200k = 0.56: above sonnet's 0.55 hard threshold, below the flat 0.60.
    writeStateFile("model-sonnet-hard", { level: "soft", maxTokens: 200_000, modelId: "claude-sonnet-4-6" });
    const transcript = writeTranscript(112_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "model-sonnet-hard", transcript_path: transcript, cwd: tmp }),
    );
    const out = JSON.parse(stdoutCapture);
    expect(out.hookSpecificOutput.additionalContext).toContain("CRITICAL");
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
    // 112k / 128k = 87.5% — above the 60% hard threshold for this window size
    expect(state.level).toBe("hard");
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
    // 112k / 128k = 87.5% — above the 60% hard threshold for this window size
    expect(written.level).toBe("hard");
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

describe("runUserPromptSubmitHook — rate-limit elevation", () => {
  // 200k window; NUDGE_HARD_UNDER_RATE_PRESSURE = 0.45 → 90k tokens at 90% rate-limit fires hard
  test("tokens at 46%, rate5h at 95% → fires hard nudge with rate-limit copy", async () => {
    const sessionId = "rl-elevated-fires";
    writeStateFile(sessionId, { maxTokens: 200_000, rateLimit5hPct: 95 });
    const transcript = writeTranscript(92_000); // 46% of 200k
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: tmp }),
    );
    const out = JSON.parse(stdoutCapture);
    expect(out.hookSpecificOutput.additionalContext).toContain("CRITICAL");
    expect(out.hookSpecificOutput.additionalContext).toContain("5h rate-limit");
    expect(out.hookSpecificOutput.additionalContext).toContain("95%");
    const state = JSON.parse(readFileSync(join(STATE_DIR, `${sessionId}.json`), "utf8"));
    expect(state.level).toBe("hard");
  });

  test("tokens at 46%, rate5h at 70% → no nudge (below soft, rate-limit not elevated)", async () => {
    const sessionId = "rl-low";
    writeStateFile(sessionId, { maxTokens: 200_000, rateLimit5hPct: 70 });
    const transcript = writeTranscript(92_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: tmp }),
    );
    expect(stdoutCapture).toBe("");
  });

  test("tokens at 61%, rate5h undefined → fires hard nudge with regular (token) copy", async () => {
    const sessionId = "rl-undef-hard";
    writeStateFile(sessionId, { maxTokens: 200_000 }); // no rateLimit5hPct
    const transcript = writeTranscript(122_000); // > 60% hard threshold
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: tmp }),
    );
    const out = JSON.parse(stdoutCapture);
    expect(out.hookSpecificOutput.additionalContext).toContain("CRITICAL");
    expect(out.hookSpecificOutput.additionalContext).toContain("auto-compact imminent");
    expect(out.hookSpecificOutput.additionalContext).not.toContain("5h rate-limit");
  });

  test("tokens at 56%, rate5h at 95% → fires hard (elevated), not soft", async () => {
    const sessionId = "rl-elevated-vs-soft";
    writeStateFile(sessionId, { maxTokens: 200_000, rateLimit5hPct: 95 });
    const transcript = writeTranscript(112_000); // 56% — above soft (55%), below hard (60%)
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: tmp }),
    );
    const out = JSON.parse(stdoutCapture);
    expect(out.hookSpecificOutput.additionalContext).toContain("CRITICAL");
    expect(out.hookSpecificOutput.additionalContext).toContain("5h rate-limit");
    const state = JSON.parse(readFileSync(join(STATE_DIR, `${sessionId}.json`), "utf8"));
    expect(state.level).toBe("hard");
  });

  test("rate5h at exactly 89% → does NOT elevate (boundary)", async () => {
    const sessionId = "rl-boundary";
    writeStateFile(sessionId, { maxTokens: 200_000, rateLimit5hPct: 89 });
    const transcript = writeTranscript(92_000); // 46% — would elevate at >=90% rate
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: tmp }),
    );
    expect(stdoutCapture).toBe("");
  });

  test("rate5h > 100 or < 0 → treated as undefined (no crash, no elevation)", async () => {
    const sessionId = "rl-invalid";
    writeStateFile(sessionId, { maxTokens: 200_000, rateLimit5hPct: 150 });
    const transcript = writeTranscript(92_000); // 46% — only fires hard if rate-limit elevates
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: tmp }),
    );
    expect(stdoutCapture).toBe("");

    // Also negative
    const sessionId2 = "rl-invalid-neg";
    writeStateFile(sessionId2, { maxTokens: 200_000, rateLimit5hPct: -5 });
    const transcript2 = writeTranscript(92_000);
    stdoutCapture = "";
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: sessionId2, transcript_path: transcript2, cwd: tmp }),
    );
    expect(stdoutCapture).toBe("");
  });

  test("token-driven hard nudge takes precedence over rate-limit reason when both qualify", async () => {
    const sessionId = "rl-tokens-win";
    writeStateFile(sessionId, { maxTokens: 200_000, rateLimit5hPct: 95 });
    const transcript = writeTranscript(125_000); // 62.5% — over hard token threshold
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: tmp }),
    );
    const out = JSON.parse(stdoutCapture);
    // Token reason wins because it's checked first; copy should NOT mention rate-limit.
    expect(out.hookSpecificOutput.additionalContext).toContain("CRITICAL");
    expect(out.hookSpecificOutput.additionalContext).toContain("auto-compact imminent");
    expect(out.hookSpecificOutput.additionalContext).not.toContain("5h rate-limit");
  });
});

describe("runUserPromptSubmitHook — maxTokens sanitization", () => {
  test("maxTokens: 0 falls back to 200k default, does not over-fire hard nudge", async () => {
    writeStateFile("max-zero", { maxTokens: 0 });
    const transcript = writeTranscript(50_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "max-zero", transcript_path: transcript, cwd: tmp }),
    );
    // 50k / 200k = 25% — below soft threshold; no nudge should fire
    expect(stdoutCapture).toBe("");
  });

  test("maxTokens: NaN falls back to 200k default, does not suppress nudges", async () => {
    writeStateFile("max-nan", { maxTokens: NaN });
    const transcript = writeTranscript(112_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "max-nan", transcript_path: transcript, cwd: tmp }),
    );
    // 112k / 200k = 56% — above soft threshold; nudge should fire
    const out = JSON.parse(stdoutCapture);
    expect(out.hookSpecificOutput.additionalContext).toContain("[baton]");
  });

  test("maxTokens: negative falls back to 200k default", async () => {
    writeStateFile("max-neg", { maxTokens: -50_000 });
    const transcript = writeTranscript(50_000);
    await runUserPromptSubmitHook(
      JSON.stringify({ session_id: "max-neg", transcript_path: transcript, cwd: tmp }),
    );
    expect(stdoutCapture).toBe("");
  });
});
