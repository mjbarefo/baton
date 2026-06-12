import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { BATON_REL_PATH, userHomeDir } from "../config.ts";
import { freshestExistingBatonWalkingUp } from "./freshness.ts";
import { listArchives } from "./archive-library.ts";

export interface BatonStatusReport {
  cwd: string;
  baton: {
    path: string | null;
    relPath: string;
    exists: boolean;
    fresh: boolean;
    ageMs: number | null;
    legacy: boolean;
    goal: string | null;
  };
  latestArchive: {
    id: string;
    path: string;
    goal: string;
    timestamp: string;
  } | null;
  gitignoreWarning: string | null;
}

// Returns the path of the first gitignore (project-level or global) that
// contains a pattern matching .baton/, or null if none found.
// Project-level: walks up from cwd to the git root (or filesystem root).
// Global: checks ~/.config/git/ignore and git config --global core.excludesFile.
function findGitignoreBatonMatch(cwd: string): string | null {
  const BATON_PATTERNS = /^[/]?[.]baton[/]?([*][*])?$/;

  function matchesInFile(path: string): boolean {
    if (!existsSync(path)) return false;
    try {
      const content = readFileSync(path, "utf8");
      const lines = content.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
      return lines.some(l => BATON_PATTERNS.test(l));
    } catch { return false; }
  }

  // Per-project .gitignore files from cwd up to the git root.
  let dir = cwd;
  while (true) {
    if (matchesInFile(join(dir, ".gitignore"))) return join(dir, ".gitignore");
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    if (existsSync(join(dir, ".git"))) break; // stop at git root
    dir = parent;
  }

  // Global gitignore: XDG default path, then git config --global core.excludesFile.
  const home = userHomeDir();
  const xdgIgnore = join(home, ".config", "git", "ignore");
  const globalPaths: string[] = [xdgIgnore];
  try {
    const result = spawnSync("git", ["config", "--global", "core.excludesFile"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (result.status === 0) {
      let custom = result.stdout.trim();
      if (custom.startsWith("~/")) custom = join(home, custom.slice(2));
      if (custom && custom !== xdgIgnore) globalPaths.push(custom);
    }
  } catch { /* git not on PATH */ }

  for (const p of globalPaths) {
    if (matchesInFile(p)) return p;
  }

  return null;
}

function readGoal(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const body = readFileSync(path, "utf8");
    const match = body.match(/^## Current Goal\s*\n([^\n]+)/m);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function formatAge(ageMs: number | null): string {
  if (ageMs == null) return "unknown";
  const minutes = Math.floor(ageMs / 60000);
  if (minutes < 1) return "under 1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h${String(rest).padStart(2, "0")}m`;
}

export function batonStatus(cwd: string): BatonStatusReport {
  const baton = freshestExistingBatonWalkingUp(cwd);
  const archive = listArchives(1)[0] ?? null;
  const gitignoreMatch = findGitignoreBatonMatch(cwd);
  return {
    cwd,
    baton: {
      path: baton?.path ?? null,
      relPath: baton?.relPath ?? BATON_REL_PATH,
      exists: baton?.exists ?? false,
      fresh: baton?.fresh ?? false,
      ageMs: baton?.ageMs ?? null,
      legacy: baton?.legacy ?? false,
      goal: baton?.path ? readGoal(baton.path) : null,
    },
    latestArchive: archive
      ? {
          id: archive.id,
          path: archive.path,
          goal: archive.goal,
          timestamp: archive.timestamp.toISOString(),
        }
      : null,
    gitignoreWarning: gitignoreMatch
      ? `${gitignoreMatch} contains a pattern matching .baton/ — batons may be lost across git operations`
      : null,
  };
}

export function printBatonStatus(report: BatonStatusReport): void {
  const lines: string[] = [];
  lines.push("baton status");
  lines.push("");
  if (report.baton.exists) {
    lines.push(`  baton: ${report.baton.path}`);
    lines.push(`  state: ${report.baton.fresh ? "fresh" : "stale"} (${formatAge(report.baton.ageMs)} old)`);
    if (report.baton.legacy) lines.push(`  note: legacy path ${report.baton.relPath}`);
    lines.push(`  goal: ${report.baton.goal ?? "_unknown_"}`);
  } else {
    lines.push(`  baton: none found (${BATON_REL_PATH})`);
  }
  if (report.latestArchive) {
    lines.push("");
    lines.push(`  latest archive: ${report.latestArchive.id}`);
    lines.push(`  archive goal: ${report.latestArchive.goal}`);
  }
  if (report.gitignoreWarning) {
    lines.push("");
    lines.push(`  warning: ${report.gitignoreWarning}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}
