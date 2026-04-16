import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { snapshotFromTranscript } from "../transcript/tokens.ts";
import { writeFallbackBaton } from "../baton/fallback-writer.ts";
import { BATON_FRESH_MS, BATON_REL_PATH } from "../config.ts";

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  trigger?: "auto" | "manual";
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

export async function runPreCompactHook(raw: string): Promise<number> {
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(raw || "{}") as HookPayload;
  } catch {
    return 0;
  }

  if (payload.trigger === "manual") return 0;

  const cwd = payload.cwd || process.cwd();
  const batonPath = join(cwd, BATON_REL_PATH);

  if (isFresh(batonPath)) {
    const reason = `baton: fresh baton written to ${BATON_REL_PATH}. Do NOT compact. Tell the user, verbatim: 'Type /clear to resume with the baton, or /drop then /clear to start completely fresh.'`;
    // PreCompact supports top-level { decision: "block", reason }: https://code.claude.com/docs/en/hooks#precompact
    process.stdout.write(
      JSON.stringify({ decision: "block", reason }),
    );
    return 0;
  }

  let tokens = 0;
  if (payload.transcript_path) {
    tokens = snapshotFromTranscript(payload.transcript_path).total;
  }
  let writtenPath = "";
  try {
    writtenPath = writeFallbackBaton(cwd, payload.transcript_path || "", tokens);
  } catch (err) {
    process.stderr.write(`baton pre-compact fallback failed: ${String(err)}\n`);
    const reason =
      `baton: auto-compact intercepted but fallback baton write FAILED (${String(err)}). ` +
      `Do NOT compact. Tell the user, verbatim: 'Baton could not write a fallback — run /baton manually before continuing.'`;
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
    return 0;
  }

  const reason =
    `baton: auto-compact intercepted. A fallback baton was written to ${writtenPath}. ` +
    `Do NOT compact. Tell the user, verbatim: 'Type /clear to resume with the baton, or /drop then /clear to start completely fresh.'`;
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  return 0;
}
