import { copyFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

function archiveDir(): string {
  return join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), ".claude", "baton", "archive");
}

export function archiveBaton(batonPath: string, suffix = ""): string {
  const dir = archiveDir();
  mkdirSync(dir, { recursive: true });
  const stat = statSync(batonPath);
  const ts = new Date(stat.mtimeMs).toISOString().replace(/[:.]/g, "-");
  const projectRoot = dirname(dirname(dirname(batonPath)));
  const projectName = basename(projectRoot) || "project";
  const tag = suffix ? `-${suffix}` : "";
  const archivePath = join(dir, `${projectName}-${ts}${tag}.md`);
  try {
    renameSync(batonPath, archivePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(batonPath, archivePath);
    unlinkSync(batonPath);
  }
  return archivePath;
}
