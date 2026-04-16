import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { archiveBaton } from "../baton/archive.ts";
import { BATON_FRESH_MS, BATON_REL_PATH } from "../config.ts";

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: "startup" | "resume" | "clear" | "compact";
}

function isFresh(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const stat = statSync(path);
    return Date.now() - stat.mtimeMs < BATON_FRESH_MS;
  } catch {
    return false;
  }
}

const RESUME_INSTRUCTIONS =
  '\n\n---\nYou are resuming a prior Claude Code session. The block above is the full baton written by baton at the end of the previous session. Read it once, confirm understanding in one short sentence, then execute the "Next Concrete Action". Do not re-plan. Do not re-explore. Trust the baton.';

export async function runSessionStartHook(raw: string): Promise<number> {
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(raw || "{}") as HookPayload;
  } catch {
    return 0;
  }

  if (!payload.source || payload.source === "startup") return 0;
  if (!["clear", "resume", "compact"].includes(payload.source)) return 0;

  const cwd = payload.cwd || process.cwd();
  const batonPath = join(cwd, BATON_REL_PATH);
  if (!isFresh(batonPath)) return 0;

  let body = "";
  try {
    body = readFileSync(batonPath, "utf8");
  } catch (err) {
    process.stderr.write(`baton session-start: failed to read ${batonPath}: ${String(err)}\n`);
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
    archiveBaton(batonPath);
  } catch (err) {
    process.stderr.write(`baton session-start: failed to archive ${batonPath}: ${String(err)}\n`);
  }

  return 0;
}
