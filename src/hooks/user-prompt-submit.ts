import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotFromTranscript } from "../transcript/tokens.ts";
import { readTemplateBody } from "../baton/template-loader.ts";
import { batonStateDir, THRESHOLDS } from "../config.ts";

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
}

type NudgeLevel = "none" | "soft" | "hard";
const MAX_STATE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface StateFile {
  level: NudgeLevel;
}

function levelFor(tokens: number): NudgeLevel {
  if (tokens >= THRESHOLDS.NUDGE_HARD) return "hard";
  if (tokens >= THRESHOLDS.NUDGE_SOFT) return "soft";
  return "none";
}

function readState(path: string): StateFile {
  if (!existsSync(path)) return { level: "none" };
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StateFile;
  } catch {
    return { level: "none" };
  }
}

function writeState(path: string, state: StateFile): void {
  mkdirSync(batonStateDir(), { recursive: true });
  writeFileSync(path, JSON.stringify(state));
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

function message(level: "soft" | "hard", tokens: number, max: number): string {
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
  const level = levelFor(snap.total);
  if (level === "none") return;

  const statePath = join(batonStateDir(), `${sessionId}.json`);
  const prior = readState(statePath);

  // Only fire when level *increases*. Once soft is sent, don't resend soft every turn.
  if (level === "soft" && prior.level !== "none") return;
  if (level === "hard" && prior.level === "hard") return;

  writeState(statePath, { level });

  // Assume 200k context window; hook stdin does not carry context_window.
  const output = {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: message(level, snap.total, 200_000),
    },
  };
  process.stdout.write(JSON.stringify(output));
}
