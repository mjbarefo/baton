import { existsSync, statSync } from "node:fs";
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
import type { StatusJSON } from "./status-json.ts";
import { persistStateSnapshot, tokenTotalFromTranscript } from "./session-state.ts";

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
