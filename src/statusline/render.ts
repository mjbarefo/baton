import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
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
  context_window?: {
    context_window_size?: number;
    used_percentage?: number;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
  };
  worktree?: { branch?: string; is_dirty?: boolean };
  rate_limits?: {
    five_hour?: RateLimit;
    seven_day?: RateLimit;
  } | null;
}

const DEFAULT_MAX = 200_000;
const SEP_TEXT = " │ ";

interface GitCache {
  dir: string;
  headMtimeMs: number;
  indexMtimeMs: number;
  branch?: string;
  dirty: boolean;
}
let cachedGit: GitCache | null = null;

function findGitDir(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 20; i++) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) return gitPath;
    const parent = join(dir, "..");
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

function gitBranchInfo(cwd: string | undefined): { branch?: string; dirty?: boolean } {
  const dir = cwd || process.cwd();
  try {
    const gitDir = findGitDir(dir);
    if (!gitDir) return {};

    let headMtimeMs = 0;
    let indexMtimeMs = 0;
    try { headMtimeMs = statSync(join(gitDir, "HEAD")).mtimeMs; } catch { return {}; }
    try { indexMtimeMs = statSync(join(gitDir, "index")).mtimeMs; } catch { /* fresh repo, no index yet */ }

    if (
      cachedGit?.dir === dir &&
      cachedGit.headMtimeMs === headMtimeMs &&
      cachedGit.indexMtimeMs === indexMtimeMs
    ) {
      return { branch: cachedGit.branch, dirty: cachedGit.dirty };
    }

    let branch: string | undefined;
    try {
      branch = execSync("git symbolic-ref --short HEAD", { cwd: dir, stdio: ["ignore", "pipe", "ignore"], timeout: 1000 })
        .toString().trim();
    } catch { /* detached HEAD */ }

    let dirty = false;
    try {
      dirty = execSync("git status --porcelain", { cwd: dir, stdio: ["ignore", "pipe", "ignore"], timeout: 1000 })
        .toString().trim().length > 0;
    } catch { /* ignore */ }

    cachedGit = { dir, headMtimeMs, indexMtimeMs, branch, dirty };
    return { branch, dirty };
  } catch {
    return {};
  }
}
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

  const payloadMax = data.context_window?.context_window_size;
  const max = payloadMax || DEFAULT_MAX;

  // Persist real context_window_size to the session state file so the
  // UserPromptSubmit hook can read it instead of hardcoding 200k.
  if (data.session_id && payloadMax) {
    persistMaxTokensToState(data.session_id, payloadMax);
  }

  const usedPct = data.context_window?.used_percentage;
  let tokens: number | null = null;
  if (usedPct != null && payloadMax) {
    tokens = Math.round((usedPct / 100) * payloadMax);
  } else if (data.transcript_path) {
    tokens = tokenTotalFromTranscript(data.transcript_path);
  }

  const worktreeBranch = data.worktree?.branch;
  const git = worktreeBranch ? { branch: worktreeBranch, dirty: data.worktree?.is_dirty } : gitBranchInfo(data.cwd);

  const parts: (string | null)[] = [
    renderModel(data.model?.display_name || data.model?.id),
    renderBranch(git.branch, git.dirty),
    renderBar(tokens, max),
    renderBatonBadge(data.cwd, data.session_id, max),
    renderRateLimit5h(data.rate_limits?.five_hour),
    renderDuration(data.cost?.total_duration_ms),
    renderCost(data.cost?.total_cost_usd),
  ];

  return parts.filter((p): p is string => !!p).join(color.dim(SEP_TEXT));
}
