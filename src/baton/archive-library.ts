import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { batonArchiveDir, legacyBatonArchiveDir } from "../config.ts";
import { color } from "../statusline/color.ts";

export interface ArchiveEntry {
  id: string;          // filename stem, e.g. "baton-2026-04-21T19-32-14-123Z"
  path: string;        // absolute path
  project: string;     // derived from filename prefix
  timestamp: Date;     // parsed from filename
  dropped: boolean;    // suffix was "-dropped"
  fallback: boolean;   // goal section is the fallback placeholder
  goal: string;        // parsed "Current Goal" line, or "_(fallback ...)_"
  sizeBytes: number;
}

const FALLBACK_PLACEHOLDERS = new Set([
  "_unknown — the active agent did not author this baton._",
  "_unknown — Claude did not author this baton._",
]);
const GOAL_REGEX = /^## Current Goal\s*\n([^\n]+)/m;

function parseTimestamp(id: string): Date {
  // Format: project-2026-04-21T19-32-14-123Z[-dropped]
  const match = id.match(/-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)/);
  if (!match || !match[1]) return new Date(0);
  const tsStr = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/, 'T$1:$2:$3.$4');
  return new Date(tsStr);
}

function parseProject(id: string): string {
  const match = id.match(/^(.+?)-\d{4}-\d{2}-\d{2}T/);
  return match && match[1] ? match[1] : "unknown";
}

export function listArchives(): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const seen = new Set<string>();
  for (const dir of [batonArchiveDir(), legacyBatonArchiveDir()]) {
    let files: string[];
    try {
      files = readdirSync(dir).filter(f => f.endsWith(".md"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }

    for (const file of files) {
      const path = join(dir, file);
      if (seen.has(path)) continue;
      seen.add(path);
      const id = file.replace(/\.md$/, "");
      const stats = statSync(path);
      const dropped = id.endsWith("-dropped");

      // Read body to find goal
      const content = readFileSync(path, "utf8");
      const match = content.match(GOAL_REGEX);
      let goal = "";
      let fallback = false;

      if (match && match[1]) {
        goal = match[1].trim();
        if (FALLBACK_PLACEHOLDERS.has(goal) || goal === "") {
          goal = "_(fallback — goal unknown)_";
          fallback = true;
        }
      } else {
        goal = "_(fallback — goal unknown)_";
        fallback = true;
      }

      entries.push({
        id,
        path,
        project: parseProject(id),
        timestamp: parseTimestamp(id),
        dropped,
        fallback,
        goal,
        sizeBytes: stats.size
      });
    }
  }

  return entries.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
}

export function showArchive(id: string): string {
  const entries = listArchives();
  const matches = entries.filter(e => e.id.startsWith(id));

  if (matches.length === 0) {
    throw new Error(`baton: no archive found matching '${id}'`);
  }
  if (matches.length > 1) {
    const ids = matches.map(m => m.id).join("\n  ");
    throw new Error(`baton: ambiguous archive ID '${id}'. Matches:\n  ${ids}`);
  }

  return readFileSync(matches[0]!.path, "utf8");
}

export function pruneArchives(opts: { keep?: number; olderThanDays?: number; dryRun?: boolean }): { deleted: string[]; kept: number } {
  if (opts.keep === undefined && opts.olderThanDays === undefined) {
    throw new Error("baton prune: must specify at least one of --keep or --older-than-days");
  }

  const entries = listArchives(); // Already sorted newest first
  const toDelete = new Set<string>();

  if (opts.olderThanDays !== undefined) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - opts.olderThanDays);
    for (const entry of entries) {
      if (entry.timestamp < cutoff) {
        toDelete.add(entry.path);
      }
    }
  }

  if (opts.keep !== undefined) {
    // skip the first `opts.keep` entries (the newest ones)
    for (let i = opts.keep; i < entries.length; i++) {
      toDelete.add(entries[i]!.path);
    }
  }

  const deleted: string[] = [];
  for (const path of toDelete) {
    if (!opts.dryRun) {
      try {
        unlinkSync(path);
      } catch (err) {
        process.stderr.write(`baton prune: failed to remove ${path}: ${String(err)}\n`);
        continue;
      }
    }
    deleted.push(path);
  }

  const kept = entries.length - deleted.length;
  return { deleted, kept };
}

export function recallArchives(query: string): Array<{ entry: ArchiveEntry; matches: Array<{ line: number; text: string }> }> {
  const entries = listArchives();
  const results = [];
  const lowerQuery = query.toLowerCase();

  for (const entry of entries) {
    if (entry.sizeBytes > 1024 * 1024) continue; // Skip > 1MB

    const content = readFileSync(entry.path, "utf8");
    const lines = content.split("\n");
    const matches: Array<{ line: number; text: string }> = [];

    for (let i = 0; i < lines.length; i++) {
      const lineText = lines[i];
      if (lineText && lineText.toLowerCase().includes(lowerQuery)) {
        matches.push({ line: i + 1, text: lineText });
        if (matches.length >= 5) break;
      }
    }

    if (matches.length > 0) {
      results.push({ entry, matches });
    }
  }

  return results;
}

export function printList(entries: ArchiveEntry[]): void {
  process.stdout.write(`baton archive (${entries.length} entries)\n\n`);
  for (const entry of entries) {
    const tsStr = entry.timestamp.toISOString().replace(/T/, " ").slice(0, 16);
    const tsColored = color.dim(tsStr);
    const projColored = color.cyan.bold(entry.project.padEnd(15));
    let goalColored = entry.goal;
    if (entry.dropped) {
      goalColored += " " + color.yellow("_(dropped)_");
    } else if (entry.fallback) {
      goalColored = color.dim(goalColored);
    }
    process.stdout.write(`  ${tsColored}   ${projColored} ${goalColored}\n`);
  }
}

export function printPrune(result: { deleted: string[]; kept: number }, dryRun: boolean): void {
  const prefix = dryRun ? "[dry-run] would delete" : "deleted";
  for (const path of result.deleted) {
    process.stdout.write(`${prefix} ${path}\n`);
  }
  const summary = `${dryRun ? "would delete" : "deleted"} ${result.deleted.length}, kept ${result.kept}`;
  process.stdout.write(`\n${summary}\n`);
}

export function printRecall(results: ReturnType<typeof recallArchives>): void {
  process.stdout.write(`baton recall (${results.length} files matched)\n\n`);
  for (const result of results) {
    process.stdout.write(color.cyan.bold(result.entry.id) + "\n");
    for (const match of result.matches) {
      process.stdout.write(`  ${color.dim(match.line.toString())} | ${match.text.trim()}\n`);
    }
    process.stdout.write("\n");
  }
}
