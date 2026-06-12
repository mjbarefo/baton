import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { renderBar } from "./bar.ts";
import { color, visibleLength } from "./color.ts";
import {
  renderModel,
  renderBranch,
  renderBatonBadge,
  renderRateLimit5h,
  renderDuration,
  renderCost,
  MIN_BATON_GOAL_BADGE_WIDTH,
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

// The statusline runs as a one-shot process per render, so module-level caches
// never survive between renders — don't add any here.
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
    if (!findGitDir(dir)) return {};

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

    return { branch, dirty };
  } catch {
    return {};
  }
}

/**
 * Persist the session's context window size, 5h rate-limit usage, and model id
 * to the shared state file so the UserPromptSubmit hook can read them. Uses
 * read-merge-write to preserve other fields (e.g. nudge level). Any field
 * may be undefined; undefined is NOT written, so a partial payload preserves
 * the last known value rather than wiping it.
 */
function persistStateSnapshot(
  sessionId: string,
  snapshot: { maxTokens?: number; rateLimit5hPct?: number; modelId?: string },
): void {
  const { maxTokens, rateLimit5hPct, modelId } = snapshot;
  if (maxTokens === undefined && rateLimit5hPct === undefined && modelId === undefined) return;
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
    if (modelId !== undefined) merged.modelId = modelId;
    writeFileSync(statePath, JSON.stringify(merged));
  } catch { /* never crash the statusline */ }
}

function tokenTotalFromTranscript(path: string): number {
  try {
    return snapshotFromTranscript(path).total;
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

  // Persist real context_window_size and 5h rate-limit usage to the session
  // state file so the UserPromptSubmit hook can use them in nudge decisions.
  if (data.session_id) {
    const rawPct = data.rate_limits?.five_hour?.used_percentage;
    const rateLimit5hPct =
      typeof rawPct === "number" && Number.isFinite(rawPct) && rawPct >= 0 && rawPct <= 100
        ? rawPct
        : undefined;
    persistStateSnapshot(data.session_id, {
      maxTokens: payloadMax,
      rateLimit5hPct,
      modelId: data.model?.id || data.model?.display_name,
    });
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

  const widgets = [
    { key: "model", text: renderModel(data.model?.display_name || data.model?.id) },
    { key: "branch", text: renderBranch(git.branch, git.dirty) },
    { key: "bar", text: renderBar(tokens, max) },
    { key: "batonBadge", text: renderBatonBadge(data.cwd, data.session_id, max) },
    { key: "rateLimit", text: renderRateLimit5h(data.rate_limits?.five_hour) },
    { key: "duration", text: renderDuration(data.cost?.total_duration_ms) },
    { key: "cost", text: renderCost(data.cost?.total_cost_usd) },
  ];

  let parts = widgets.filter((w): w is { key: string; text: string } => !!w.text);

  const columns = process.stdout.columns;
  if (columns && columns >= 40) {
    const visibleTotal = (items: { text: string }[]) =>
      items.reduce((sum, p) => sum + visibleLength(p.text), 0) + Math.max(0, items.length - 1) * visibleLength(SEP_TEXT);

    const DROP_PRIORITY = ["cost", "duration", "rateLimit"];
    for (const dropKey of DROP_PRIORITY) {
      const totalLen = visibleTotal(parts);
      if (totalLen <= columns - 1) {
        break;
      }
      parts = parts.filter((p) => p.key !== dropKey);
    }

    const batonIndex = parts.findIndex((p) => p.key === "batonBadge");
    if (batonIndex !== -1) {
      let totalLen = visibleTotal(parts);
      let overflow = totalLen - (columns - 1);
      let currentBatonIndex = batonIndex;
      let batonPart = parts[currentBatonIndex];
      if (batonPart && overflow > 0) {
        let currentWidth = visibleLength(batonPart.text);
        let targetWidth = currentWidth - overflow;

        if (targetWidth < MIN_BATON_GOAL_BADGE_WIDTH) {
          const barIndex = parts.findIndex((p) => p.key === "bar");
          if (barIndex !== -1) {
            parts = parts.filter((_, index) => index !== barIndex);
            currentBatonIndex = parts.findIndex((p) => p.key === "batonBadge");
            batonPart = currentBatonIndex === -1 ? undefined : parts[currentBatonIndex];
            totalLen = visibleTotal(parts);
            overflow = totalLen - (columns - 1);
            if (batonPart) {
              currentWidth = visibleLength(batonPart.text);
              targetWidth = currentWidth - Math.max(0, overflow);
            }
          }
        }

        if (batonPart && currentBatonIndex !== -1) {
          parts[currentBatonIndex] = {
            key: batonPart.key,
            text: renderBatonBadge(data.cwd, data.session_id, max, targetWidth),
          };
        }
      }
    }
  } else if (columns !== undefined && columns > 0 && columns < 40) {
    if (parts.length > 0) {
      parts = parts.slice(0, 1);
    }
  }

  return parts.map((p) => p.text).join(color.dim(SEP_TEXT));
}
