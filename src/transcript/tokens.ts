import { readLatestAssistantUsageEntry, readTranscript, isMainChain, type TranscriptEntry } from "./read.ts";

export interface TokenSnapshot {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  lastAssistantIndex: number;
}

export const EMPTY_SNAPSHOT: TokenSnapshot = {
  total: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  lastAssistantIndex: -1,
};

/**
 * Context size = the token footprint of the most recent assistant message on the
 * main chain. Claude Code's usage field on each assistant turn reports the state
 * of the context at that point, so the latest one is what's currently loaded.
 * Summing across all entries would double-count cache hits.
 */
export function snapshotFromTranscript(path: string): TokenSnapshot {
  const entry = readLatestAssistantUsageEntry(path);
  if (!entry) return EMPTY_SNAPSHOT;
  return snapshotFromAssistantEntry(entry, -1);
}

export function snapshotFromEntries(entries: TranscriptEntry[]): TokenSnapshot {
  let last: { entry: TranscriptEntry; idx: number } | null = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || !isMainChain(e)) continue;
    if (e.message?.role !== "assistant") continue;
    if (!e.message.usage) continue;
    last = { entry: e, idx: i };
    break;
  }
  if (!last) return EMPTY_SNAPSHOT;

  return snapshotFromAssistantEntry(last.entry, last.idx);
}

function snapshotFromAssistantEntry(entry: TranscriptEntry, lastAssistantIndex: number): TokenSnapshot {
  const u = entry.message!.usage!;
  const input = u.input_tokens ?? 0;
  const output = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;

  return {
    total: input + cacheRead + cacheCreate,
    input,
    output,
    cacheRead,
    cacheCreate,
    lastAssistantIndex,
  };
}
