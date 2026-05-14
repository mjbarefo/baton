import { existsSync, readFileSync } from "node:fs";
import { BATON_REL_PATH } from "../config.ts";
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
  const archive = listArchives()[0] ?? null;
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
  process.stdout.write(lines.join("\n") + "\n");
}
