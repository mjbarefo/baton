import { copyFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { BATON_ARCHIVE_DIR } from "../config.ts";

export function archiveBaton(batonPath: string, suffix = ""): string {
  mkdirSync(BATON_ARCHIVE_DIR, { recursive: true });
  const stat = statSync(batonPath);
  const ts = new Date(stat.mtimeMs).toISOString().replace(/[:.]/g, "-");
  const projectRoot = dirname(dirname(dirname(batonPath)));
  const projectName = basename(projectRoot) || "project";
  const tag = suffix ? `-${suffix}` : "";
  const archivePath = join(BATON_ARCHIVE_DIR, `${projectName}-${ts}${tag}.md`);
  try {
    renameSync(batonPath, archivePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(batonPath, archivePath);
    unlinkSync(batonPath);
  }
  return archivePath;
}
