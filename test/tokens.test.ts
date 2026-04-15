import { expect, test, describe } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotFromEntries, snapshotFromTranscript } from "../src/transcript/tokens.ts";
import type { TranscriptEntry } from "../src/transcript/read.ts";
import { zoneFor } from "../src/statusline/bar.ts";
import { writeTranscriptFixture } from "./fixtures.ts";

function assistant(usage: Record<string, number>, opts: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    type: "assistant",
    isSidechain: false,
    isApiErrorMessage: false,
    ...opts,
    message: { role: "assistant", content: "...", usage },
  };
}

function user(text = "hi"): TranscriptEntry {
  return {
    type: "user",
    isSidechain: false,
    isApiErrorMessage: false,
    message: { role: "user", content: text },
  };
}

describe("snapshotFromEntries", () => {
  test("empty transcript → zero", () => {
    const snap = snapshotFromEntries([]);
    expect(snap.total).toBe(0);
  });

  test("uses latest assistant entry's usage, not a sum", () => {
    const entries = [
      assistant({ input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 50 }),
      user(),
      assistant({ input_tokens: 200, cache_read_input_tokens: 5000, output_tokens: 80 }),
    ];
    const snap = snapshotFromEntries(entries);
    expect(snap.total).toBe(200 + 5000);
    expect(snap.input).toBe(200);
    expect(snap.output).toBe(80);
    expect(snap.cacheRead).toBe(5000);
  });

  test("includes cache_creation_input_tokens", () => {
    const snap = snapshotFromEntries([
      assistant({ input_tokens: 10, cache_creation_input_tokens: 90, output_tokens: 5 }),
    ]);
    expect(snap.total).toBe(10 + 90);
    expect(snap.output).toBe(5);
  });

  test("skips sidechain entries", () => {
    const entries = [
      assistant({ input_tokens: 100, output_tokens: 10 }, { isSidechain: true }),
      assistant({ input_tokens: 50, output_tokens: 5 }),
    ];
    const snap = snapshotFromEntries(entries);
    expect(snap.total).toBe(50);
  });

  test("skips api error messages", () => {
    const entries = [
      assistant({ input_tokens: 50, output_tokens: 5 }),
      assistant({ input_tokens: 999, output_tokens: 999 }, { isApiErrorMessage: true }),
    ];
    const snap = snapshotFromEntries(entries);
    expect(snap.total).toBe(50);
  });

  test("handles missing usage fields gracefully", () => {
    const snap = snapshotFromEntries([assistant({ input_tokens: 42 })]);
    expect(snap.total).toBe(42);
  });
});

describe("snapshotFromTranscript", () => {
  test("reads the latest assistant usage from the transcript tail", () => {
    const tmp = mkdtempSync(join(tmpdir(), "baton-tokens-"));
    try {
      const path = writeTranscriptFixture(tmp, "transcript.jsonl", {
        inputTokens: 123_000,
        cacheRead: 4_000,
        cacheCreate: 3_000,
        outputTokens: 900,
        extraTurns: 2000,
      });

      const snap = snapshotFromTranscript(path);

      expect(snap.total).toBe(130_000);
      expect(snap.output).toBe(900);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("zoneFor", () => {
  test("boundaries", () => {
    expect(zoneFor(0)).toBe("green");
    expect(zoneFor(79_999)).toBe("green");
    expect(zoneFor(80_000)).toBe("yellow");
    expect(zoneFor(109_999)).toBe("yellow");
    expect(zoneFor(110_000)).toBe("orange");
    expect(zoneFor(124_999)).toBe("orange");
    expect(zoneFor(125_000)).toBe("red");
    expect(zoneFor(200_000)).toBe("red");
  });
});
