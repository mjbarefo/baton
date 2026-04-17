import { afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TEST_HOME } from "./helpers/test-home.ts";

const actualFs = await import("node:fs");
// Capture real function refs before mock.module can mutate the namespace.
const realRenameSync = actualFs.renameSync;
const realUnlinkSync = actualFs.unlinkSync;

let renameSyncThrows: Error | null = null;
let unlinkSyncThrows: Error | null = null;

mock.module("node:fs", () => ({
  ...actualFs,
  renameSync: (...args: Parameters<typeof actualFs.renameSync>) => {
    if (renameSyncThrows) throw renameSyncThrows;
    return realRenameSync(...args);
  },
  unlinkSync: (...args: Parameters<typeof actualFs.unlinkSync>) => {
    if (unlinkSyncThrows) throw unlinkSyncThrows;
    return realUnlinkSync(...args);
  },
}));

const { archiveBaton, PartialArchiveError } = await import("../src/baton/archive.ts");

const ARCHIVE_DIR = join(TEST_HOME, ".claude", "baton", "archive");

function writeBaton(project: string, body = "# Baton\n"): string {
  const dir = join(project, ".claude", "baton");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "BATON.md");
  writeFileSync(path, body);
  return path;
}

let tmp: string;
let stderrCapture: string;
let origStderrWrite: typeof process.stderr.write;

beforeEach(() => {
  tmp = join(tmpdir(), `baton-archive-${crypto.randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  rmSync(join(TEST_HOME, ".claude"), { recursive: true, force: true });
  renameSyncThrows = null;
  unlinkSyncThrows = null;
  stderrCapture = "";
  origStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrCapture += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = origStderrWrite;
  rmSync(tmp, { recursive: true, force: true });
  rmSync(join(TEST_HOME, ".claude"), { recursive: true, force: true });
  setSystemTime();
});

describe("archiveBaton", () => {
  test("renames baton to archive dir and returns archive path", () => {
    const project = join(tmp, "my-project");
    const batonPath = writeBaton(project, "# Baton\ncontent\n");

    const archivePath = archiveBaton(batonPath);

    expect(existsSync(batonPath)).toBe(false);
    expect(existsSync(archivePath)).toBe(true);
    expect(readFileSync(archivePath, "utf8")).toBe("# Baton\ncontent\n");
    const files = readdirSync(ARCHIVE_DIR);
    expect(files).toHaveLength(1);
    expect(files[0]).toStartWith("my-project-");
    expect(files[0]).toEndWith(".md");
  });

  test("appends suffix to archive filename when provided", () => {
    const project = join(tmp, "my-project");
    const batonPath = writeBaton(project);

    archiveBaton(batonPath, "dropped");

    const files = readdirSync(ARCHIVE_DIR);
    expect(files[0]).toContain("-dropped.md");
  });

  test("EXDEV: falls back to copy+unlink when rename fails across filesystems", () => {
    renameSyncThrows = Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });

    const project = join(tmp, "my-project");
    const batonPath = writeBaton(project, "# Baton\nexdev content\n");

    const archivePath = archiveBaton(batonPath);

    expect(existsSync(batonPath)).toBe(false);
    expect(existsSync(archivePath)).toBe(true);
    expect(readFileSync(archivePath, "utf8")).toBe("# Baton\nexdev content\n");
    expect(stderrCapture).toBe("");
  });

  test("EXDEV: copy succeeds but unlink fails — throws PartialArchiveError with archive path", () => {
    renameSyncThrows = Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    unlinkSyncThrows = Object.assign(new Error("file locked"), { code: "EBUSY" });

    const project = join(tmp, "my-project");
    const batonPath = writeBaton(project, "# Baton\nlocked\n");

    let thrown: unknown;
    try {
      archiveBaton(batonPath);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PartialArchiveError);
    const err = thrown as InstanceType<typeof PartialArchiveError>;
    expect(existsSync(err.archivePath)).toBe(true);
    expect(readFileSync(err.archivePath, "utf8")).toBe("# Baton\nlocked\n");
    expect(existsSync(batonPath)).toBe(true);
    expect(stderrCapture).toBe("");
  });

  test("non-EXDEV rename errors are rethrown", () => {
    renameSyncThrows = Object.assign(new Error("permission denied"), { code: "EACCES" });

    const project = join(tmp, "my-project");
    const batonPath = writeBaton(project);

    expect(() => archiveBaton(batonPath)).toThrow("permission denied");
  });

  test("collision avoidance: appends -2 when archive path already exists", () => {
    const FIXED = new Date("2025-01-01T00:00:00.000Z");
    setSystemTime(FIXED);
    const ts = FIXED.toISOString().replace(/[:.]/g, "-");

    const project = join(tmp, "my-project");
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    writeFileSync(join(ARCHIVE_DIR, `my-project-${ts}.md`), "existing");

    const batonPath = writeBaton(project, "# Baton\nnew\n");

    const archivePath = archiveBaton(batonPath);

    expect(archivePath).toEndWith(`my-project-${ts}-2.md`);
    expect(existsSync(archivePath)).toBe(true);
    expect(readFileSync(archivePath, "utf8")).toBe("# Baton\nnew\n");
    expect(readdirSync(ARCHIVE_DIR)).toHaveLength(2);
  });

  test("collision avoidance: increments counter past -2 when multiple collisions exist", () => {
    const FIXED = new Date("2025-01-01T00:00:00.000Z");
    setSystemTime(FIXED);
    const ts = FIXED.toISOString().replace(/[:.]/g, "-");

    const project = join(tmp, "my-project");
    mkdirSync(ARCHIVE_DIR, { recursive: true });
    writeFileSync(join(ARCHIVE_DIR, `my-project-${ts}.md`), "existing-1");
    writeFileSync(join(ARCHIVE_DIR, `my-project-${ts}-2.md`), "existing-2");

    const batonPath = writeBaton(project, "# Baton\nnew\n");

    const archivePath = archiveBaton(batonPath);

    expect(archivePath).toEndWith(`my-project-${ts}-3.md`);
  });
});
