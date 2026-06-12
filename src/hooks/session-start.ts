import { readFileSync } from "node:fs";
import { archiveBaton } from "../baton/archive.ts";
import { freshestExistingBatonWalkingUp } from "../baton/freshness.ts";

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: "startup" | "resume" | "clear" | "compact";
}

const RESUME_INSTRUCTIONS =
  '\n\n---\nYou are resuming a prior coding-agent session. The block above is the full baton written by baton at the end of the previous session. Read it once, confirm understanding in one short sentence, then execute the "Next Concrete Action". Do not re-plan. Do not re-explore. Trust the baton.';

export async function runSessionStartHook(raw: string): Promise<number> {
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(raw || "{}") as HookPayload;
  } catch {
    return 0;
  }

  if (!payload.source || payload.source === "startup") return 0;
  // "compact" is a real spec value (fires when auto or manual compaction runs).
  // In practice it should never reach us because PreCompact always blocks, but we
  // handle it defensively: if compaction somehow succeeded and a fresh baton exists,
  // inject it so the session isn't left context-free.
  if (!["clear", "resume", "compact"].includes(payload.source)) return 0;

  const cwd = payload.cwd || process.cwd();
  const baton = freshestExistingBatonWalkingUp(cwd);
  if (!baton?.fresh) return 0;

  let body = "";
  try {
    body = readFileSync(baton.path, "utf8");
  } catch (err) {
    process.stderr.write(`baton session-start: failed to read ${baton.path}: ${String(err)}\n`);
    return 0;
  }

  // Inject first, archive second. This ordering is intentional:
  // - If archive fails after inject: baton re-injects on next /clear (double-resume, annoying but recoverable).
  // - If inject fails after archive: baton is permanently gone with no recovery path (data loss).
  // Tolerating a possible double-resume is strictly safer than risking baton loss.
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: body + RESUME_INSTRUCTIONS,
      },
    }),
  );

  try {
    archiveBaton(baton.path);
  } catch (err) {
    process.stderr.write(`baton session-start: failed to archive ${baton.path}: ${String(err)}\n`);
  }

  return 0;
}
