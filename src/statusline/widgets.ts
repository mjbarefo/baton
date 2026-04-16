import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { color } from "./color.ts";
import {
  BATON_FRESH_MS,
  BATON_REL_PATH,
  batonStateDir,
  THRESHOLDS,
} from "../config.ts";
import { formatK } from "./bar.ts";

export interface RateLimit {
  used_percentage?: number | null;
  resets_at?: number | null;
}

export function renderModel(name: string | undefined): string | null {
  if (!name) return null;
  return color.cyan.bold(name);
}

export function renderBranch(branch: string | undefined, dirty: boolean | undefined): string | null {
  if (!branch) return null;
  const prefix = color.dim("⎇ ");
  return dirty ? prefix + color.yellow(`${branch}*`) : prefix + color.green(branch);
}

/**
 * The baton badge — expresses one of four states, left-to-right priority:
 *  1. A fresh baton exists on disk  → BATON ✓
 *  2. Hard nudge has fired this session → ⚠ HARD
 *  3. Soft nudge has fired this session → ⚠ soft
 *  4. Idle → →125k (shows where the hard limit sits)
 */
export function renderBatonBadge(cwd: string | undefined, sessionId: string | undefined): string {
  if (cwd) {
    const batonPath = join(cwd, BATON_REL_PATH);
    if (existsSync(batonPath)) {
      try {
        const stat = statSync(batonPath);
        if (Date.now() - stat.mtimeMs < BATON_FRESH_MS) {
          return color.bold.greenBright("BATON ✓");
        }
      } catch {
        // ignore
      }
    }
  }

  if (sessionId) {
    const statePath = join(batonStateDir(), `${sessionId}.json`);
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8")) as { level?: string };
        if (state.level === "hard") return color.bold.red("⚠ HARD");
        if (state.level === "soft") return color.hex("#ff8800")("⚠ soft");
      } catch {
        // ignore
      }
    }
  }

  return color.blue.dim(`→${formatK(THRESHOLDS.ORANGE_MAX)}`);
}

export function renderRateLimit5h(rateLimit: RateLimit | undefined): string | null {
  const pct = rateLimit?.used_percentage;
  if (pct == null) return null;
  const rounded = Math.round(pct);
  let painted: string;
  if (rounded >= 90) painted = color.bold.red(`${rounded}%`);
  else if (rounded >= 75) painted = color.hex("#ff8800")(`${rounded}%`);
  else if (rounded >= 50) painted = color.yellow(`${rounded}%`);
  else painted = color.dim(color.green(`${rounded}%`));
  const label = rounded >= 75 ? color.dim(color.hex("#ff8800")("rl·5h ")) : color.magenta.dim("rl·5h ");
  return label + painted;
}

export function renderDuration(ms: number | undefined): string | null {
  if (ms == null || ms < 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  let label: string;
  if (h > 0) label = `${h}h${String(m).padStart(2, "0")}m`;
  else label = `${m}m`;
  if (h >= 2) return color.hex("#ff8800")(label);
  if (h >= 1) return color.yellow(label);
  return color.white.dim(label);
}

export function renderCost(cost: number | undefined): string | null {
  if (cost == null) return null;
  const formatted = "$" + cost.toFixed(2);
  if (cost >= 10) return color.bold.red(formatted);
  if (cost >= 5) return color.hex("#ff8800")(formatted);
  if (cost >= 1) return color.yellow(formatted);
  return color.dim(color.green(formatted));
}
