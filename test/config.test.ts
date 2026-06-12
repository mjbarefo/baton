import { expect, test, describe } from "bun:test";
import {
  cliPath,
  buildCommand,
  nudgeThresholdsForModel,
  SESSION_AGE_NUDGE_MS,
  SESSION_AGE_NUDGE_MIN_TOKENS,
  THRESHOLDS,
} from "../src/config.ts";

describe("cliPath", () => {
  test("returns a path ending in cli.ts when running from source", () => {
    expect(cliPath().endsWith("cli.ts")).toBe(true);
  });

  test("uses forward slashes only (shell-safe on all platforms)", () => {
    expect(cliPath()).not.toContain("\\");
  });
});

describe("buildCommand", () => {
  test("uses 'bun run' when running from source", () => {
    expect(buildCommand("statusline")).toContain("bun run");
  });

  test("includes the subcommand in the output", () => {
    expect(buildCommand("hook user-prompt-submit")).toContain("hook user-prompt-submit");
  });

  test("uses forward slashes in the path (shell-safe)", () => {
    expect(buildCommand("statusline")).not.toContain("\\");
  });
});

describe("SESSION_AGE thresholds", () => {
  test("SESSION_AGE_NUDGE_MS is 5 hours", () => {
    expect(SESSION_AGE_NUDGE_MS).toBe(5 * 60 * 60 * 1000);
  });

  test("SESSION_AGE_NUDGE_MIN_TOKENS is 30k", () => {
    expect(SESSION_AGE_NUDGE_MIN_TOKENS).toBe(30_000);
  });
});

describe("THRESHOLDS ordering", () => {
  test("NUDGE_SOFT is below NUDGE_HARD", () => {
    expect(THRESHOLDS.NUDGE_SOFT).toBeLessThan(THRESHOLDS.NUDGE_HARD);
  });

  test("ORANGE_MAX is above NUDGE_HARD (trailing visual indicator)", () => {
    // Intentional: bar turns orange after hard nudge fires, not before.
    // See comment in config.ts above THRESHOLDS.
    expect(THRESHOLDS.ORANGE_MAX).toBeGreaterThan(THRESHOLDS.NUDGE_HARD);
  });

  test("GREEN_MAX is below NUDGE_SOFT", () => {
    expect(THRESHOLDS.GREEN_MAX).toBeLessThan(THRESHOLDS.NUDGE_SOFT);
  });
});

describe("nudgeThresholdsForModel", () => {
  test("unknown or missing model uses flat defaults", () => {
    expect(nudgeThresholdsForModel(undefined)).toEqual({
      soft: THRESHOLDS.NUDGE_SOFT,
      hard: THRESHOLDS.NUDGE_HARD,
    });
    expect(nudgeThresholdsForModel("claude-opus-4-8")).toEqual({
      soft: THRESHOLDS.NUDGE_SOFT,
      hard: THRESHOLDS.NUDGE_HARD,
    });
  });

  test("sonnet nudges earlier than the defaults", () => {
    const t = nudgeThresholdsForModel("claude-sonnet-4-6");
    expect(t.soft).toBeLessThan(THRESHOLDS.NUDGE_SOFT);
    expect(t.hard).toBeLessThan(THRESHOLDS.NUDGE_HARD);
  });

  test("haiku nudges earlier than sonnet", () => {
    const sonnet = nudgeThresholdsForModel("claude-sonnet-4-6");
    const haiku = nudgeThresholdsForModel("claude-haiku-4-5-20251001");
    expect(haiku.soft).toBeLessThan(sonnet.soft);
    expect(haiku.hard).toBeLessThan(sonnet.hard);
  });

  test("matches display names as well as ids", () => {
    expect(nudgeThresholdsForModel("Sonnet 4.6").soft).toBeLessThan(THRESHOLDS.NUDGE_SOFT);
  });

  test("soft stays below hard for every model tier", () => {
    for (const id of [undefined, "claude-opus-4-8", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      const t = nudgeThresholdsForModel(id);
      expect(t.soft).toBeLessThan(t.hard);
    }
  });
});
