import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotFromTranscript } from "../transcript/tokens.ts";
import { readFirstTimestamp } from "../transcript/read.ts";
import { readTemplateBody } from "../baton/template-loader.ts";
import {
  batonStateDir,
  legacyBatonStateDir,
  NUDGE_HARD_UNDER_RATE_PRESSURE,
  RATE_LIMIT_ELEVATED_PCT,
  SESSION_AGE_NUDGE_MIN_TOKENS,
  SESSION_AGE_NUDGE_MS,
  THRESHOLDS,
} from "../config.ts";
import { normalizeLevel, normalizeMaxTokens, normalizeRateLimit5hPct } from "../baton/state.ts";
import type { BatonState, NudgeLevel } from "../baton/state.ts";

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

const MAX_STATE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 200_000;

type NudgeReason = "tokens" | "rate-limit" | null;

function levelFor(
  tokens: number,
  maxTokens: number,
  rateLimit5hPct: number | undefined,
): { level: NudgeLevel; reason: NudgeReason } {
  const hardByTokens = tokens >= Math.floor(THRESHOLDS.NUDGE_HARD * maxTokens);
  if (hardByTokens) return { level: "hard", reason: "tokens" };
  const elevatedHard =
    rateLimit5hPct !== undefined &&
    rateLimit5hPct >= RATE_LIMIT_ELEVATED_PCT &&
    tokens >= Math.floor(NUDGE_HARD_UNDER_RATE_PRESSURE * maxTokens);
  if (elevatedHard) return { level: "hard", reason: "rate-limit" };
  if (tokens >= Math.floor(THRESHOLDS.NUDGE_SOFT * maxTokens)) {
    return { level: "soft", reason: "tokens" };
  }
  return { level: "none", reason: null };
}

function readState(path: string): BatonState {
  if (!existsSync(path)) return { level: "none" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<BatonState>;
    // Normalize level: other writers (e.g. statusline) may write { maxTokens }
    // without a level field. Treat missing/invalid level as "none".
    const level = normalizeLevel(parsed.level);
    // Normalize maxTokens: guard against 0, NaN, negative, or non-number values
    // that would cause levelFor to over-fire (0 → always hard) or never fire (NaN).
    const maxTokens = normalizeMaxTokens(parsed.maxTokens);
    const rateLimit5hPct = normalizeRateLimit5hPct(parsed.rateLimit5hPct);
    return { ...parsed, level, maxTokens, rateLimit5hPct };
  } catch {
    return { level: "none" };
  }
}

function writeState(path: string, prior: BatonState, updates: Partial<BatonState>): void {
  mkdirSync(batonStateDir(), { recursive: true });
  // Spread prior to preserve fields written by other writers (e.g. maxTokens from statusline).
  writeFileSync(path, JSON.stringify({ ...prior, ...updates }));
}

function pruneStaleStateFiles(): void {
  const stateDir = batonStateDir();
  if (!existsSync(stateDir)) return;
  const now = Date.now();
  for (const f of readdirSync(stateDir)) {
    const p = join(stateDir, f);
    if (now - statSync(p).mtimeMs > MAX_STATE_AGE_MS) rmSync(p);
  }
}

function message(
  level: "soft" | "hard",
  tokens: number,
  max: number = DEFAULT_MAX_TOKENS,
  reason: NudgeReason = "tokens",
  rateLimit5hPct?: number,
): string {
  const k = Math.round(tokens / 1000);
  const maxK = Math.round(max / 1000);
  if (level === "soft") {
    return `[baton] Context at ~${k}k/${maxK}k. At your next natural stopping point — after finishing the current thought, not mid-tool-call — run the baton workflow to snapshot session state. A fresh session resumes better than auto-compaction.`;
  }

  // HARD threshold: don't just suggest baton, inline the full skill body
  // so it writes the baton automatically on its next response. No user typing required.
  let templateBody = "";
  try {
    templateBody = readTemplateBody();
  } catch {
    // Template unreadable — fall back to the bare nudge.
  }
  const base =
    reason === "rate-limit" && rateLimit5hPct !== undefined
      ? `[baton] **CRITICAL** — 5h rate-limit at ${Math.round(rateLimit5hPct)}% with ~${k}k/${maxK}k tokens loaded. One more long turn may hit the rate wall and prevent baton authoring. Before doing ANYTHING else in your next response, execute the baton protocol below. Do not start new work. Do not wait for the user to ask. Write the baton file NOW, then stop.`
      : `[baton] **CRITICAL** — context at ~${k}k/${maxK}k, auto-compact imminent. Before doing ANYTHING else in your next response, execute the baton protocol below. Do not start new work. Do not wait for the user to ask. Write the baton file NOW, then stop.`;
  if (!templateBody) return base;
  return `${base}\n\n--- BEGIN BATON PROTOCOL ---\n${templateBody}\n--- END BATON PROTOCOL ---`;
}

export async function runUserPromptSubmitHook(raw: string): Promise<void> {
  pruneStaleStateFiles();

  let payload: HookPayload = {};
  try {
    payload = JSON.parse(raw || "{}") as HookPayload;
  } catch {
    return;
  }
  const transcript = payload.transcript_path;
  const sessionId = payload.session_id;
  if (!transcript || !sessionId) return;
  const hookEventName = payload.hook_event_name ?? "UserPromptSubmit";

  const snap = snapshotFromTranscript(transcript);
  const statePath = join(batonStateDir(), `${sessionId}.json`);
  const legacyStatePath = join(legacyBatonStateDir(), `${sessionId}.json`);
  const prior = existsSync(statePath) ? readState(statePath) : readState(legacyStatePath);
  const maxTokens = prior.maxTokens ?? DEFAULT_MAX_TOKENS;

  // --- Token / rate-limit nudge ---
  const { level: tokenLevel, reason } = levelFor(snap.total, maxTokens, prior.rateLimit5hPct);
  const tokenNudgeShouldFire =
    (tokenLevel === "soft" && prior.level === "none") ||
    (tokenLevel === "hard" && prior.level !== "hard");

  if (tokenNudgeShouldFire) {
    writeState(statePath, prior, { level: tokenLevel });
    const output = {
      hookSpecificOutput: {
        hookEventName,
        // Use max_tokens persisted by the statusline (which receives it from Claude Code).
        // Falls back to 200k if the statusline hasn't run yet this session.
        additionalContext: message(tokenLevel, snap.total, maxTokens, reason, prior.rateLimit5hPct),
      },
    };
    process.stdout.write(JSON.stringify(output));
    return;
  }

  // --- Session-age nudge ---
  // Only fires when token pressure is low (not redundant with a token nudge),
  // the session has non-trivial context, and we haven't already sent this nudge.
  if (tokenLevel === "none" && !prior.timeNudgeSent && snap.total >= SESSION_AGE_NUDGE_MIN_TOKENS) {
    const firstTs = readFirstTimestamp(transcript);
    if (firstTs) {
      const sessionAgeMs = Date.now() - new Date(firstTs).getTime();
      if (sessionAgeMs >= SESSION_AGE_NUDGE_MS) {
        writeState(statePath, prior, { timeNudgeSent: true });
        const hours = Math.floor(sessionAgeMs / (60 * 60 * 1000));
        const k = Math.round(snap.total / 1000);
        const output = {
          hookSpecificOutput: {
            hookEventName,
            additionalContext: `[baton] This session is ~${hours}h old with ~${k}k tokens loaded. At your next natural stopping point, consider running the baton workflow to snapshot state and start fresh — a new session will have a clean context.`,
          },
        };
        process.stdout.write(JSON.stringify(output));
      }
    }
  }
}
