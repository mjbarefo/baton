import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { batonArchiveDir } from "../config.ts";

// Thrown when a cross-filesystem archive copy succeeded but the source file
// could not be removed. The archive is preserved; the caller decides how to
// surface the partial failure to the user.
export class PartialArchiveError extends Error {
  constructor(public readonly archivePath: string, cause: unknown) {
    super(`archive copy succeeded but source removal failed: ${String(cause)}`);
    this.name = "PartialArchiveError";
  }
}

function uniqueArchivePath(dir: string, stem: string): string {
  const first = join(dir, `${stem}.md`);
  if (!existsSync(first)) return first;
  let i = 2;
  while (existsSync(join(dir, `${stem}-${i}.md`))) i++;
  return join(dir, `${stem}-${i}.md`);
}

export function projectRootForBaton(batonPath: string): string {
  const batonDir = dirname(batonPath);
  if (basename(batonDir) === ".baton") return dirname(batonDir);

  const maybeClaudeDir = dirname(batonDir);
  if (basename(batonDir) === "baton" && basename(maybeClaudeDir) === ".claude") {
    return dirname(maybeClaudeDir);
  }

  // Non-standard path: walk up to find the nearest .git root.
  // Falls back to batonDir itself (treating BATON.md as sitting at the
  // project root) if no .git is found — e.g. a bare workspace or a temp dir.
  let dir = batonDir;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root — give up
    dir = parent;
  }
  return batonDir;
}

export function archiveBaton(batonPath: string, suffix = ""): string {
  const dir = batonArchiveDir();
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const projectRoot = projectRootForBaton(batonPath);
  const projectName = basename(projectRoot) || "project";
  const tag = suffix ? `-${suffix}` : "";
  const archivePath = uniqueArchivePath(dir, `${projectName}-${ts}${tag}`);
  try {
    renameSync(batonPath, archivePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(batonPath, archivePath);
    try {
      unlinkSync(batonPath);
    } catch (unlinkErr) {
      throw new PartialArchiveError(archivePath, unlinkErr);
    }
  }
  return archivePath;
}
