import { expect, mock, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TEST_HOME } from "./helpers/test-home.ts";

const actualArchive = await import("../src/baton/archive.ts");
const realArchiveBaton = actualArchive.archiveBaton;
let archiveBatonMode: "normal" | "partial" = "normal";

mock.module("../src/baton/archive.ts", () => ({
  ...actualArchive,
  archiveBaton: (...args: Parameters<typeof actualArchive.archiveBaton>) => {
    if (archiveBatonMode === "partial") {
      throw new actualArchive.PartialArchiveError("/archive/path-dropped.md", new Error("EBUSY: file locked"));
    }
    return realArchiveBaton(...args);
  },
}));

const { drop } = await import("../src/baton/drop.ts");
const BATON_ARCHIVE_DIR = join(TEST_HOME, ".claude", "baton", "archive");

let proj: string;
let stdoutCapture: string;
let stderrCapture: string;
let origOut: typeof process.stdout.write;
let origErr: typeof process.stderr.write;

beforeEach(() => {
  archiveBatonMode = "normal";
  proj = mkdtempSync(join(tmpdir(), "baton-drop-proj-"));
  rmSync(join(TEST_HOME, ".claude"), { recursive: true, force: true });
  stdoutCapture = "";
  stderrCapture = "";
  origOut = process.stdout.write.bind(process.stdout);
  origErr = process.stderr.write.bind(process.stderr);
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
  process.stdout.write = origOut;
  process.stderr.write = origErr;
  rmSync(proj, { recursive: true, force: true });
  rmSync(join(TEST_HOME, ".claude"), { recursive: true, force: true });
});

test("drop archives an existing baton with -dropped suffix", () => {
  const batonDir = join(proj, ".claude", "baton");
  mkdirSync(batonDir, { recursive: true });
  const baton = join(batonDir, "BATON.md");
  writeFileSync(baton, "# baton body");

  const code = drop({ cwd: proj });

  expect(code).toBe(0);
  expect(existsSync(baton)).toBe(false);
  expect(stdoutCapture).toContain("baton drop: archived");

  const archived = readdirSync(BATON_ARCHIVE_DIR);
  expect(archived.length).toBe(1);
  expect(archived[0]).toContain("-dropped.md");
});

test("drop is a graceful no-op when no baton is present", () => {
  const code = drop({ cwd: proj });
  expect(code).toBe(0);
  expect(stdoutCapture).toContain("Nothing to drop");
  expect(stderrCapture).toBe("");
});

test("drop reports archive path but exits 1 and warns when source removal fails (PartialArchiveError)", () => {
  archiveBatonMode = "partial";
  const batonDir = join(proj, ".claude", "baton");
  mkdirSync(batonDir, { recursive: true });
  writeFileSync(join(batonDir, "BATON.md"), "# baton body");

  const code = drop({ cwd: proj });

  expect(code).toBe(1);
  expect(stdoutCapture).toContain("/archive/path-dropped.md");
  expect(stderrCapture).toContain("may re-inject on next /clear");
  expect(stderrCapture).toContain("Run /drop again");
});

test("drop walks up from a subdirectory to find the baton", () => {
  const batonDir = join(proj, ".claude", "baton");
  mkdirSync(batonDir, { recursive: true });
  const baton = join(batonDir, "BATON.md");
  writeFileSync(baton, "# baton body");

  const subdir = join(proj, "deep", "nested");
  mkdirSync(subdir, { recursive: true });

  const code = drop({ cwd: subdir });

  expect(code).toBe(0);
  expect(existsSync(baton)).toBe(false);
});
