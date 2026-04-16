import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TEST_HOME } from "./helpers/test-home.ts";

// Import after TEST_HOME sets USERPROFILE/HOME so batonStateDir() resolves correctly.
const { renderStatusline } = await import("../src/statusline/render.ts");

const STATE_DIR = join(TEST_HOME, ".claude", "baton", "state");

beforeEach(() => {
  rmSync(STATE_DIR, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(STATE_DIR, { recursive: true, force: true });
});

function statusPayload(overrides: object = {}): string {
  return JSON.stringify({
    session_id: "test-session",
    context_window: { tokens: 50_000, max_tokens: 128_000 },
    ...overrides,
  });
}

describe("renderStatusline — max_tokens persistence", () => {
  test("persists max_tokens to state file when payload has context_window", async () => {
    await renderStatusline(statusPayload({ session_id: "persist-1" }));

    const statePath = join(STATE_DIR, "persist-1.json");
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.maxTokens).toBe(128_000);
  });

  test("preserves existing state fields when writing maxTokens", async () => {
    const sessionId = "persist-merge";
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(
      join(STATE_DIR, `${sessionId}.json`),
      JSON.stringify({ level: "soft", maxTokens: 200_000 }),
    );

    await renderStatusline(statusPayload({ session_id: sessionId, context_window: { tokens: 50_000, max_tokens: 128_000 } }));

    const state = JSON.parse(readFileSync(join(STATE_DIR, `${sessionId}.json`), "utf8"));
    expect(state.level).toBe("soft");
    expect(state.maxTokens).toBe(128_000);
  });

  test("does not write state file when payload has no session_id", async () => {
    await renderStatusline(
      JSON.stringify({ context_window: { tokens: 50_000, max_tokens: 128_000 } }),
    );
    expect(existsSync(STATE_DIR)).toBe(false);
  });

  test("does not write state file when payload has no max_tokens", async () => {
    await renderStatusline(
      JSON.stringify({ session_id: "no-max", context_window: { tokens: 50_000 } }),
    );
    expect(existsSync(join(STATE_DIR, "no-max.json"))).toBe(false);
  });

  test("in-memory cache skips redundant writes for same session + max", async () => {
    const sessionId = "cache-test";
    await renderStatusline(statusPayload({ session_id: sessionId, context_window: { tokens: 10_000, max_tokens: 128_000 } }));

    // Corrupt the file — if cache is working, the second render won't overwrite it.
    const statePath = join(STATE_DIR, `${sessionId}.json`);
    writeFileSync(statePath, "CORRUPTED");

    await renderStatusline(statusPayload({ session_id: sessionId, context_window: { tokens: 20_000, max_tokens: 128_000 } }));

    expect(readFileSync(statePath, "utf8")).toBe("CORRUPTED");
  });

  test("different max_tokens busts the in-memory cache and re-writes", async () => {
    const sessionId = "cache-bust";
    await renderStatusline(statusPayload({ session_id: sessionId, context_window: { tokens: 10_000, max_tokens: 128_000 } }));
    await renderStatusline(statusPayload({ session_id: sessionId, context_window: { tokens: 10_000, max_tokens: 200_000 } }));

    const state = JSON.parse(readFileSync(join(STATE_DIR, `${sessionId}.json`), "utf8"));
    expect(state.maxTokens).toBe(200_000);
  });

  test("renders correctly with a non-default max_tokens", async () => {
    const line = await renderStatusline(
      JSON.stringify({ context_window: { tokens: 64_000, max_tokens: 128_000 } }),
    );
    expect(line).toContain("128k");
    expect(line).not.toContain("200k");
  });

  test("malformed JSON still renders without crashing", async () => {
    const line = await renderStatusline("{invalid");
    expect(typeof line).toBe("string");
  });
});
