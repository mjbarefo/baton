import chalk from "chalk";
import { statSync } from "node:fs";
import { renderBar } from "./bar.ts";
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

function forceColor(): void {
  chalk.level = 3;
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
  forceColor();

  let data: StatusJSON = {};
  try {
    data = JSON.parse(raw || "{}") as StatusJSON;
  } catch {
    // Malformed stdin — render an empty line rather than crash Claude Code's UI.
  }

  const max = data.context_window?.max_tokens || DEFAULT_MAX;
  let tokens = data.context_window?.tokens;
  if (tokens == null && data.transcript_path) {
    tokens = tokenTotalFromTranscript(data.transcript_path);
  }
  tokens = tokens ?? 0;

  const parts: (string | null)[] = [
    renderModel(data.model?.display_name || data.model?.id),
    renderBranch(data.worktree?.branch, data.worktree?.is_dirty),
    renderBar(tokens, max),
    renderBatonBadge(data.cwd, data.session_id),
    renderRateLimit5h(data.rate_limits?.five_hour),
    renderDuration(data.cost?.total_duration_ms),
    renderCost(data.cost?.total_cost_usd),
  ];

  return parts.filter((p): p is string => !!p).join(chalk.dim(SEP_TEXT));
}
