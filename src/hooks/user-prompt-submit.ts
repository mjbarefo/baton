import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotFromTranscript } from "../transcript/tokens.ts";
import { readFirstTimestamp } from "../transcript/read.ts";
import { readTemplateBody } from "../baton/template-loader.ts";
import { batonStateDir, SESSION_AGE_NUDGE_MIN_TOKENS, SESSION_AGE_NUDGE_MS, THRESHOLDS } from "../config.ts";

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

type NudgeLevel = "none" | "soft" | "hard";
const MAX_STATE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_TOKENS = 200_000;

interface StateFile {
  level: NudgeLevel;
  /** Written by the statusline, which receives the real context window from Claude Code. */
  maxTokens?: number;
  /** True once the session-age nudge has been sent. Prevents repeated firing. */
  timeNudgeSent?: boolean;
}

function levelFor(tokens: number, maxTokens: number): NudgeLevel {
  if (tokens >= Math.floor(THRESHOLDS.NUDGE_HARD * maxTokens)) return "hard";
  if (tokens >= Math.floor(THRESHOLDS.NUDGE_SOFT * maxTokens)) return "soft";
  return "none";
}

function readState(path: string): StateFile {
  if (!existsSync(path)) return { level: "none" };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StateFile>;
    // Normalize level: other writers (e.g. statusline) may write { maxTokens }
    // without a level field. Treat missing/invalid level as "none".
    const level: NudgeLevel =
      parsed.level === "soft" || parsed.level === "hard" ? parsed.level : "none";
    // Normalize maxTokens: guard against 0, NaN, negative, or non-number values
    // that would cause levelFor to over-fire (0 → always hard) or never fire (NaN).
    const raw = parsed.maxTokens;
    const maxTokens =
      typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
    return { ...parsed, level, maxTokens };
  } catch {
    return { level: "none" };
  }
}

function writeState(path: string, prior: StateFile, updates: Partial<StateFile>): void {
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

function message(level: "soft" | "hard", tokens: number, max: number = DEFAULT_MAX_TOKENS): string {
  const k = Math.round(tokens / 1000);
  const maxK = Math.round(max / 1000);
  if (level === "soft") {
    return `[baton] Context at ~${k}k/${maxK}k. At your next natural stopping point — after finishing the current thought, not mid-tool-call — run \`/baton\` to snapshot session state. A fresh session resumes better than auto-compaction.`;
  }

  // HARD threshold: don't just tell Claude to run /baton, inline the full skill body
  // so it writes the baton automatically on its next response. No user typing required.
  let templateBody = "";
  try {
    templateBody = readTemplateBody();
  } catch {
    // Template unreadable — fall back to the bare nudge.
  }
  const base = `[baton] **CRITICAL** — context at ~${k}k/${maxK}k, auto-compact imminent. Before doing ANYTHING else in your next response, execute the baton protocol below. Do not start new work. Do not wait for the user to ask. Write the baton file NOW, then stop.`;
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

  const snap = snapshotFromTranscript(transcript);
  const statePath = join(batonStateDir(), `${sessionId}.json`);
  const prior = readState(statePath);
  const maxTokens = prior.maxTokens ?? DEFAULT_MAX_TOKENS;

  // --- Token nudge ---
  const tokenLevel = levelFor(snap.total, maxTokens);
  const tokenNudgeShouldFire =
    (tokenLevel === "soft" && prior.level === "none") ||
    (tokenLevel === "hard" && prior.level !== "hard");

  if (tokenNudgeShouldFire) {
    writeState(statePath, prior, { level: tokenLevel });
    const output = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        // Use max_tokens persisted by the statusline (which receives it from Claude Code).
        // Falls back to 200k if the statusline hasn't run yet this session.
        additionalContext: message(tokenLevel, snap.total, maxTokens),
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
            hookEventName: "UserPromptSubmit",
            additionalContext: `[baton] This session is ~${hours}h old with ~${k}k tokens loaded. At your next natural stopping point, consider running \`/baton\` to snapshot state and start fresh — a new session will have a clean context.`,
          },
        };
        process.stdout.write(JSON.stringify(output));
      }
    }
  }
}
