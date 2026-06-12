import { expect, test, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_HOME } from "./helpers/test-home.ts";

const actualConfig = await import("../src/config.ts");

mock.module("../src/config.ts", () => ({
  ...actualConfig,
  batonArchiveDir: () => join(TEST_HOME, ".baton", "archive"),
}));

const { listArchives, showArchive, pruneArchives, recallArchives } = await import("../src/baton/archive-library.ts");

beforeEach(() => {
  rmSync(join(TEST_HOME, ".claude"), { recursive: true, force: true });
  rmSync(join(TEST_HOME, ".baton"), { recursive: true, force: true });
});

afterEach(() => {
  rmSync(join(TEST_HOME, ".claude"), { recursive: true, force: true });
  rmSync(join(TEST_HOME, ".baton"), { recursive: true, force: true });
});

test("listArchives returns sorted entries and handles goal parsing correctly", () => {
  const archiveDir = join(TEST_HOME, ".baton", "archive");
  mkdirSync(archiveDir, { recursive: true });

  const f1 = "proj1-2025-01-01T12-00-00-000Z.md";
  const f2 = "proj2-2025-01-02T12-00-00-000Z-dropped.md";
  const f3 = "proj3-2025-01-03T12-00-00-000Z.md";

  writeFileSync(join(archiveDir, f1), "## Current Goal\nMy cool goal.");
  writeFileSync(join(archiveDir, f2), "## Current Goal\n_unknown — Claude did not author this baton._");
  writeFileSync(join(archiveDir, f3), "Empty body");

  const entries = listArchives();
  expect(entries.length).toBe(3);

  // Sorting: newest first (f3, f2, f1)
  const [e0, e1, e2] = entries;
  if (!e0 || !e1 || !e2) throw new Error("expected three entries");
  expect(e0.id).toBe("proj3-2025-01-03T12-00-00-000Z");
  expect(e1.id).toBe("proj2-2025-01-02T12-00-00-000Z-dropped");
  expect(e2.id).toBe("proj1-2025-01-01T12-00-00-000Z");

  expect(e0.goal).toBe("_(fallback — goal unknown)_");
  expect(e0.fallback).toBe(true);
  expect(e0.dropped).toBe(false);

  expect(e1.goal).toBe("_(fallback — goal unknown)_");
  expect(e1.fallback).toBe(true);
  expect(e1.dropped).toBe(true);

  expect(e2.goal).toBe("My cool goal.");
  expect(e2.fallback).toBe(false);
  expect(e2.dropped).toBe(false);
});

test("showArchive works, throws on ambiguous prefix, throws on not found", () => {
  const archiveDir = join(TEST_HOME, ".baton", "archive");
  mkdirSync(archiveDir, { recursive: true });

  const f1 = "foo-2025-01-01T12-00-00-000Z.md";
  const f2 = "foo-2025-01-01T12-00-00-001Z.md";
  const f3 = "bar-2025-01-01T12-00-00-000Z.md";

  writeFileSync(join(archiveDir, f1), "Content 1");
  writeFileSync(join(archiveDir, f2), "Content 2");
  writeFileSync(join(archiveDir, f3), "Content 3");

  // Show unambiguous by exact prefix
  expect(showArchive("bar")).toBe("Content 3");
  expect(showArchive("foo-2025-01-01T12-00-00-000Z")).toBe("Content 1");

  // Throws on not found
  expect(() => showArchive("baz")).toThrow(/no archive found matching 'baz'/);

  // Throws on ambiguous prefix
  expect(() => showArchive("foo")).toThrow(/ambiguous archive ID 'foo'/);
});

test("pruneArchives --keep and --older-than-days and --dry-run", () => {
  const archiveDir = join(TEST_HOME, ".baton", "archive");
  mkdirSync(archiveDir, { recursive: true });

  // Add items with distinct dates. We will manually set their dates relative to now to test `olderThanDays`.
  const now = new Date();

  const d0 = new Date(now.getTime() - 1 * 24 * 3600 * 1000); // 1 day ago
  const d1 = new Date(now.getTime() - 5 * 24 * 3600 * 1000); // 5 days ago
  const d2 = new Date(now.getTime() - 10 * 24 * 3600 * 1000); // 10 days ago
  const d3 = new Date(now.getTime() - 15 * 24 * 3600 * 1000); // 15 days ago

  const f0 = `pr-${d0.toISOString().replace(/[:.]/g, "-")}.md`;
  const f1 = `pr-${d1.toISOString().replace(/[:.]/g, "-")}.md`;
  const f2 = `pr-${d2.toISOString().replace(/[:.]/g, "-")}.md`;
  const f3 = `pr-${d3.toISOString().replace(/[:.]/g, "-")}.md`;

  writeFileSync(join(archiveDir, f0), "c0");
  writeFileSync(join(archiveDir, f1), "c1");
  writeFileSync(join(archiveDir, f2), "c2");
  writeFileSync(join(archiveDir, f3), "c3");

  // Dry run: Keep 3 (should remove f3), and older than 12 days (should remove f3)
  const res1 = pruneArchives({ keep: 3, dryRun: true });
  expect(res1.deleted.length).toBe(1);
  expect(res1.deleted[0] ?? "").toContain(f3);
  expect(existsSync(join(archiveDir, f3))).toBe(true);

  // olderThanDays: 7 -> keeps f0, f1; deletes f2, f3
  const res2 = pruneArchives({ olderThanDays: 7, dryRun: true });
  expect(res2.deleted.length).toBe(2);

  // Real run with both: keep 2 (removes f2, f3), older than 3 (removes f1, f2, f3). Combined, f1, f2, f3 are removed.
  // Actually the loop in pruneArchives is additive to `toDelete` set.
  // olderThanDays=3 adds f1,f2,f3. keep=2 skips first 2 (f0,f1), adds f2,f3.
  // Union of toDelete is f1,f2,f3.
  const res3 = pruneArchives({ keep: 2, olderThanDays: 3, dryRun: false });
  expect(res3.deleted.length).toBe(3);
  expect(existsSync(join(archiveDir, f0))).toBe(true);
  expect(existsSync(join(archiveDir, f1))).toBe(false);
  expect(existsSync(join(archiveDir, f2))).toBe(false);
  expect(existsSync(join(archiveDir, f3))).toBe(false);
});

test("recallArchives search matches text and returns correct lines", () => {
  const archiveDir = join(TEST_HOME, ".baton", "archive");
  mkdirSync(archiveDir, { recursive: true });

  const f1 = "proj-2025-01-01T12-00-00-000Z.md";
  const content = [
    "Line 1",
    "Here is a needle in a haystack",
    "Line 3",
    "Needle in haystack part 2",
    "Line 5"
  ].join("\n");
  writeFileSync(join(archiveDir, f1), content);

  const res = recallArchives("needle");
  expect(res.length).toBe(1);
  const r0 = res[0];
  if (!r0) throw new Error("expected one result");
  const [m0, m1] = r0.matches;
  if (!m0 || !m1) throw new Error("expected two matches");
  expect(r0.matches.length).toBe(2);
  expect(m0.line).toBe(2);
  expect(m0.text).toBe("Here is a needle in a haystack");
  expect(m1.line).toBe(4);
  expect(m1.text).toBe("Needle in haystack part 2");
});

test("listArchives returns empty array if archive dir does not exist", () => {
  rmSync(join(TEST_HOME, ".baton", "archive"), { recursive: true, force: true });
  expect(listArchives()).toEqual([]);
});

test("recallArchives ignores files larger than 1MB", () => {
  const archiveDir = join(TEST_HOME, ".baton", "archive");
  mkdirSync(archiveDir, { recursive: true });

  const f1 = "huge-2025-01-01T12-00-00-000Z.md";
  const f2 = "small-2025-01-01T12-00-00-000Z.md";

  writeFileSync(join(archiveDir, f1), "needle " + "a".repeat(1024 * 1024 + 10)); // > 1MB
  writeFileSync(join(archiveDir, f2), "needle here");

  const res = recallArchives("needle");
  expect(res.length).toBe(1);
  expect(res[0]?.entry.id).toBe("small-2025-01-01T12-00-00-000Z");
});
