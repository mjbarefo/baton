import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snapshotFromTranscript } from "../transcript/tokens.ts";
import { writeFallbackBaton } from "../baton/fallback-writer.ts";
import { freshestExistingBatonWalkingUp } from "../baton/freshness.ts";
import { normalizeCompactBlocks } from "../baton/state.ts";
import { batonStateDir, MAX_COMPACT_BLOCKS } from "../config.ts";

interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  trigger?: "auto" | "manual";
}

function readCompactBlocks(statePath: string): number {
  if (!existsSync(statePath)) return 0;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
    return normalizeCompactBlocks(parsed.compactBlocks);
  } catch {
    return 0;
  }
}

function writeCompactBlocks(statePath: string, count: number): void {
  try {
    mkdirSync(batonStateDir(), { recursive: true });
    let existing: Record<string, unknown> = {};
    if (existsSync(statePath)) {
      try {
        existing = JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
      } catch { /* corrupt state — overwrite with just the counter */ }
    }
    writeFileSync(statePath, JSON.stringify({ ...existing, compactBlocks: count }));
  } catch { /* state write must never break the hook */ }
}

export async function runPreCompactHook(raw: string): Promise<number> {
  let payload: HookPayload = {};
  try {
    payload = JSON.parse(raw || "{}") as HookPayload;
  } catch {
    return 0;
  }

  // This hook is registered with matcher "auto", so Claude Code should never invoke
  // it for manual compaction. If that ever changes, block explicitly rather than
  // silently allowing via empty stdout (exit 0 + no output = "allow" per the spec).
  if (payload.trigger === "manual") {
    process.stdout.write(JSON.stringify({ decision: "block", reason: "baton: manual compaction intercepted — run /baton first if you want to preserve session state" }));
    return 0;
  }

  const cwd = payload.cwd || process.cwd();

  // Escape hatch: each block below increments a per-session counter. If the user
  // has ignored MAX_COMPACT_BLOCKS consecutive blocks (kept typing instead of
  // /clear), permanently refusing compaction would ride the session into hard
  // context-limit errors — strictly worse than compacting. Allow this one
  // (empty stdout = allow per the spec) and reset so the cycle can restart.
  const statePath = payload.session_id
    ? join(batonStateDir(), `${payload.session_id}.json`)
    : null;
  const priorBlocks = statePath ? readCompactBlocks(statePath) : 0;
  if (statePath && priorBlocks >= MAX_COMPACT_BLOCKS) {
    writeCompactBlocks(statePath, 0);
    process.stderr.write(
      `baton pre-compact: ${priorBlocks} consecutive blocks ignored — allowing auto-compaction (any existing baton is preserved)\n`,
    );
    return 0;
  }
  const recordBlock = () => {
    if (statePath) writeCompactBlocks(statePath, priorBlocks + 1);
  };
  const blockNote = statePath
    ? ` (Block ${priorBlocks + 1}/${MAX_COMPACT_BLOCKS} this session — after ${MAX_COMPACT_BLOCKS} ignored blocks, baton will stop intercepting and let auto-compact run.)`
    : "";

  const existing = freshestExistingBatonWalkingUp(cwd);

  if (existing?.fresh) {
    recordBlock();
    const reason = `baton: fresh baton written to ${existing.relPath}. Do NOT compact. Tell the user, verbatim: 'Type /clear to resume with the baton, or /drop then /clear to start completely fresh.'${blockNote}`;
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
    recordBlock();
    const reason =
      `baton: auto-compact intercepted but fallback baton write FAILED (${String(err)}). ` +
      `Do NOT compact. Tell the user, verbatim: 'Baton could not write a fallback — run /baton manually before continuing.'${blockNote}`;
    process.stdout.write(JSON.stringify({ decision: "block", reason }));
    return 0;
  }

  recordBlock();
  const reason =
    `baton: auto-compact intercepted. A fallback baton was written to ${writtenPath}. ` +
    `Do NOT compact. Tell the user, verbatim: 'Type /clear to resume with the baton, or /drop then /clear to start completely fresh.'${blockNote}`;
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  return 0;
}
