import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { ccstatuslineBackupDir, ccstatuslineSettingsPath } from "../config.ts";
import { color } from "../statusline/color.ts";

export interface BackupResult {
  sourceExisted: true;
  sourcePath: string;
  backupPath: string;
}

export interface BackupSkipped {
  sourceExisted: false;
  sourcePath: string;
}

export type BackupOutcome = BackupResult | BackupSkipped;

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function uniquePath(base: string): string {
  let path = base;
  for (let i = 1; existsSync(path); i++) {
    path = `${base}-${i}`;
  }
  return path;
}

export function backupCcstatusline(opts: { out?: string; prefix?: string } = {}): BackupOutcome {
  const sourcePath = ccstatuslineSettingsPath();
  if (!existsSync(sourcePath)) return { sourceExisted: false, sourcePath };

  let backupPath: string;
  if (opts.out) {
    backupPath = opts.out;
    mkdirSync(dirname(backupPath), { recursive: true });
  } else {
    const dir = ccstatuslineBackupDir();
    mkdirSync(dir, { recursive: true });
    const prefix = opts.prefix ?? "settings";
    backupPath = uniquePath(join(dir, `${prefix}-${timestamp()}.json`));
  }
  copyFileSync(sourcePath, backupPath);
  return { sourceExisted: true, sourcePath, backupPath };
}

export interface BackupEntry {
  path: string;
  basename: string;
  mtimeMs: number;
  size: number;
}

export function listCcstatuslineBackups(): BackupEntry[] {
  const dir = ccstatuslineBackupDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") || /\.json-\d+$/.test(name))
    .map((name) => {
      const path = join(dir, name);
      const st = statSync(path);
      return { path, basename: name, mtimeMs: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export interface RestoreResult {
  fromPath: string;
  destPath: string;
  preRestoreBackupPath: string | null;
}

export function restoreCcstatusline(opts: { from?: string } = {}): RestoreResult {
  const destPath = ccstatuslineSettingsPath();

  let fromPath: string;
  if (opts.from) {
    fromPath = opts.from;
  } else {
    const entries = listCcstatuslineBackups();
    if (entries.length === 0) {
      throw new Error(
        `No ccstatusline backups found in ${ccstatuslineBackupDir()}. ` +
          `Run \`baton ccstatusline-backup\` first.`,
      );
    }
    fromPath = entries[0]!.path;
  }
  if (!existsSync(fromPath)) {
    throw new Error(`Backup not found: ${fromPath}`);
  }

  let preRestoreBackupPath: string | null = null;
  if (existsSync(destPath)) {
    const dir = ccstatuslineBackupDir();
    mkdirSync(dir, { recursive: true });
    preRestoreBackupPath = uniquePath(join(dir, `settings-pre-restore-${timestamp()}.json`));
    copyFileSync(destPath, preRestoreBackupPath);
  }

  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(fromPath, destPath);
  return { fromPath, destPath, preRestoreBackupPath };
}

/**
 * One-shot snapshot taken on first baton install. Returns the backup path if
 * it took a snapshot, or null when the ccstatusline settings file does not
 * exist (i.e. user has not configured ccstatusline yet).
 */
export function preBatonCcstatuslineSnapshot(): string | null {
  const src = ccstatuslineSettingsPath();
  if (!existsSync(src)) return null;
  const dir = ccstatuslineBackupDir();
  mkdirSync(dir, { recursive: true });
  const path = uniquePath(join(dir, `settings-pre-baton-${timestamp()}.json`));
  copyFileSync(src, path);
  return path;
}

export function printBackup(outcome: BackupOutcome): void {
  const isTTY = !!process.stdout.isTTY;
  const dim = (s: string): string => (isTTY ? color.dim(s) : s);
  const green = (s: string): string => (isTTY ? color.green(s) : s);
  if (!outcome.sourceExisted) {
    process.stdout.write(
      `ccstatusline settings file not found at ${outcome.sourcePath} — nothing to back up.\n` +
        dim("(Run ccstatusline once to create it, then re-run this command.)\n"),
    );
    return;
  }
  process.stdout.write(
    `${green("✓")} ccstatusline backed up\n` +
      `  from: ${outcome.sourcePath}\n` +
      `  to:   ${outcome.backupPath}\n`,
  );
}

export function printRestore(result: RestoreResult): void {
  const isTTY = !!process.stdout.isTTY;
  const dim = (s: string): string => (isTTY ? color.dim(s) : s);
  const green = (s: string): string => (isTTY ? color.green(s) : s);
  process.stdout.write(`${green("✓")} ccstatusline restored\n`);
  process.stdout.write(`  from: ${result.fromPath}\n`);
  process.stdout.write(`  to:   ${result.destPath}\n`);
  if (result.preRestoreBackupPath) {
    process.stdout.write(dim(`  prior contents snapshot → ${result.preRestoreBackupPath}\n`));
  }
  process.stdout.write("\n  Restart Claude Code (or rerun ccstatusline) for the change to take effect.\n");
}

export function printList(entries: BackupEntry[]): void {
  if (entries.length === 0) {
    process.stdout.write(
      `No ccstatusline backups found in ${ccstatuslineBackupDir()}.\n`,
    );
    return;
  }
  const isTTY = !!process.stdout.isTTY;
  const dim = (s: string): string => (isTTY ? color.dim(s) : s);
  process.stdout.write(`ccstatusline backups (newest first):\n\n`);
  for (const e of entries) {
    const when = new Date(e.mtimeMs).toISOString();
    process.stdout.write(`  ${e.basename}\n    ${dim(`${when} · ${e.size} bytes`)}\n    ${dim(e.path)}\n`);
  }
}
