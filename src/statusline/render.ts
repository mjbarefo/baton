import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderBar } from "./bar.ts";
import { color } from "./color.ts";
import {
  renderModel,
  renderBranch,
  renderBatonBadge,
  renderRateLimit5h,
  renderDuration,
  renderCost,
  type RateLimit,
} from "./widgets.ts";
import { snapshotFromTranscript } from "../transcript/tokens.ts";
import { batonStateDir } from "../config.ts";

interface StatusJSON {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  cost?: { total_cost_usd?: number; total_duration_ms?: number };
  context_window?: { tokens?: number; max_tokens?: number };
  worktree?: { branch?: string; is_dirty?: boolean };
  rate_limits?: {
    five_hour?: RateLimit;
    seven_day?: RateLimit;
  } | null;
}

const DEFAULT_MAX = 200_000;
const SEP_TEXT = " │ ";
let cachedSnapshot: { path: string; mtimeMs: number; total: number } | null = null;

// Cache the last state-file write so we skip I/O when maxTokens is stable.
let lastPersistedMaxTokens: { sessionId: string; maxTokens: number } | null = null;

/**
 * Persist the session's context window size to the shared state file so that
 * the UserPromptSubmit hook can read it without hardcoding 200k.
 * Uses read-merge-write to preserve other fields (e.g. nudge level).
 */
function persistMaxTokensToState(sessionId: string, maxTokens: number): void {
  if (
    lastPersistedMaxTokens?.sessionId === sessionId &&
    lastPersistedMaxTokens.maxTokens === maxTokens
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
    writeFileSync(statePath, JSON.stringify({ ...existing, maxTokens }));
    lastPersistedMaxTokens = { sessionId, maxTokens };
  } catch { /* never crash the statusline */ }
}

function tokenTotalFromTranscript(path: string): number {
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

export async function renderStatusline(raw: string): Promise<string> {
  let data: StatusJSON = {};
  try {
    data = JSON.parse(raw || "{}") as StatusJSON;
  } catch {
    // Malformed stdin — render an empty line rather than crash Claude Code's UI.
  }

  const payloadMax = data.context_window?.max_tokens;
  const max = payloadMax || DEFAULT_MAX;

  // Persist real max_tokens to the session state file so the UserPromptSubmit
  // hook can read it instead of hardcoding 200k.
  if (data.session_id && payloadMax) {
    persistMaxTokensToState(data.session_id, payloadMax);
  }

  let tokens = data.context_window?.tokens;
  if (tokens == null && data.transcript_path) {
    tokens = tokenTotalFromTranscript(data.transcript_path);
  }
  tokens = tokens ?? 0;

  const parts: (string | null)[] = [
    renderModel(data.model?.display_name || data.model?.id),
    renderBranch(data.worktree?.branch, data.worktree?.is_dirty),
    renderBar(tokens, max),
    renderBatonBadge(data.cwd, data.session_id, max),
    renderRateLimit5h(data.rate_limits?.five_hour),
    renderDuration(data.cost?.total_duration_ms),
    renderCost(data.cost?.total_cost_usd),
  ];

  return parts.filter((p): p is string => !!p).join(color.dim(SEP_TEXT));
}
