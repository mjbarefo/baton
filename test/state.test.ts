import { describe, test, expect } from "bun:test";
import { normalizeLevel, normalizeMaxTokens, normalizeRateLimit5hPct } from "../src/baton/state.ts";

describe("state normalizers", () => {
  describe("normalizeLevel", () => {
    test("preserves valid values", () => {
      expect(normalizeLevel("hard")).toBe("hard");
      expect(normalizeLevel("soft")).toBe("soft");
      expect(normalizeLevel("none")).toBe("none");
    });

    test("falls back to none for invalid or missing values", () => {
      expect(normalizeLevel(undefined)).toBe("none");
      expect(normalizeLevel(42)).toBe("none");
      expect(normalizeLevel(null)).toBe("none");
      expect(normalizeLevel("HARD")).toBe("none"); // case-sensitive
      expect(normalizeLevel("invalid")).toBe("none");
      expect(normalizeLevel({})).toBe("none");
    });
  });

  describe("normalizeMaxTokens", () => {
    test("preserves valid positive numbers", () => {
      expect(normalizeMaxTokens(200000)).toBe(200000);
      expect(normalizeMaxTokens(1)).toBe(1);
    });

    test("returns undefined for invalid, non-positive or missing values", () => {
      expect(normalizeMaxTokens(0)).toBeUndefined();
      expect(normalizeMaxTokens(-1)).toBeUndefined();
      expect(normalizeMaxTokens(NaN)).toBeUndefined();
      expect(normalizeMaxTokens(Infinity)).toBeUndefined();
      expect(normalizeMaxTokens("200000")).toBeUndefined();
      expect(normalizeMaxTokens(undefined)).toBeUndefined();
      expect(normalizeMaxTokens(null)).toBeUndefined();
    });
  });

  describe("normalizeRateLimit5hPct", () => {
    test("preserves valid percentages", () => {
      expect(normalizeRateLimit5hPct(0)).toBe(0);
      expect(normalizeRateLimit5hPct(50)).toBe(50);
      expect(normalizeRateLimit5hPct(100)).toBe(100);
      expect(normalizeRateLimit5hPct(99.9)).toBe(99.9);
    });

    test("returns undefined for invalid, out of bounds or missing values", () => {
      expect(normalizeRateLimit5hPct(-1)).toBeUndefined();
      expect(normalizeRateLimit5hPct(101)).toBeUndefined();
      expect(normalizeRateLimit5hPct(NaN)).toBeUndefined();
      expect(normalizeRateLimit5hPct(Infinity)).toBeUndefined();
      expect(normalizeRateLimit5hPct("50")).toBeUndefined();
      expect(normalizeRateLimit5hPct(undefined)).toBeUndefined();
      expect(normalizeRateLimit5hPct(null)).toBeUndefined();
    });
  });
});
