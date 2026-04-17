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

export function archiveBaton(batonPath: string, suffix = ""): string {
  const dir = batonArchiveDir();
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const projectRoot = dirname(dirname(dirname(batonPath)));
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
