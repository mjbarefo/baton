import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { batonStateDir } from "../config.ts";
import { snapshotFromTranscript } from "../transcript/tokens.ts";

let cachedSnapshot: { path: string; mtimeMs: number; total: number } | null = null;

// Cache the last state-file write so we skip I/O when nothing changed.
let lastPersistedSnapshot: {
  sessionId: string;
  maxTokens: number | undefined;
  rateLimit5hPct: number | undefined;
} | null = null;

/**
 * Persist the session's context window size and 5h rate-limit usage to the
 * shared state file so the UserPromptSubmit hook can read them. Uses
 * read-merge-write to preserve other fields (e.g. nudge level). Either field
 * may be undefined; undefined is NOT written, so a partial payload preserves
 * the last known value rather than wiping it.
 */
export function persistStateSnapshot(
  sessionId: string,
  snapshot: { maxTokens?: number; rateLimit5hPct?: number },
): void {
  const { maxTokens, rateLimit5hPct } = snapshot;
  if (maxTokens === undefined && rateLimit5hPct === undefined) return;
  if (
    lastPersistedSnapshot?.sessionId === sessionId &&
    lastPersistedSnapshot.maxTokens === maxTokens &&
    lastPersistedSnapshot.rateLimit5hPct === rateLimit5hPct
  ) {
    return;
  }
  try {
    const stateDir = batonStateDir();
    const statePath = join(stateDir, `${sessionId}.json`);
    mkdirSync(stateDir, { recursive: true });
    let existing: Record<string, unknown> = {};
    if (existsSync(statePath)) {
      try {
        existing = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      } catch { /* ignore — hook may be writing concurrently */ }
    }
    const merged: Record<string, unknown> = { ...existing };
    if (maxTokens !== undefined) merged.maxTokens = maxTokens;
    if (rateLimit5hPct !== undefined) merged.rateLimit5hPct = rateLimit5hPct;
    writeFileSync(statePath, JSON.stringify(merged));
    // Only carry forward prior-cache values within the same session; a different
    // sessionId's values are unrelated and would poison later dedup comparisons.
    const carry = lastPersistedSnapshot?.sessionId === sessionId ? lastPersistedSnapshot : null;
    lastPersistedSnapshot = {
      sessionId,
      maxTokens: maxTokens ?? carry?.maxTokens,
      rateLimit5hPct: rateLimit5hPct ?? carry?.rateLimit5hPct,
    };
  } catch { /* never crash the statusline */ }
}

export function tokenTotalFromTranscript(path: string): number {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    if (cachedSnapshot?.path === path && cachedSnapshot.mtimeMs === mtimeMs) {
      return cachedSnapshot.total;
    }
    const total = snapshotFromTranscript(path).total;
    cachedSnapshot = { path, mtimeMs, total };
    return total;
  } catch {
    return 0;
  }
}
