import { readLatestAssistantUsageEntry, isMainChain, type TranscriptEntry } from "./read.ts";

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
 * Context size = the token footprint of the most recent usage-bearing entry on
 * the main chain. Claude Code reports this on assistant turns; other hosts may
 * report it as top-level usage/tokens. The latest one is what's currently loaded.
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
    if (!usageFromEntry(e)) continue;
    last = { entry: e, idx: i };
    break;
  }
  if (!last) return EMPTY_SNAPSHOT;

  return snapshotFromAssistantEntry(last.entry, last.idx);
}

function snapshotFromAssistantEntry(entry: TranscriptEntry, lastAssistantIndex: number): TokenSnapshot {
  const u = usageFromEntry(entry)!;
  const input = u.input_tokens ?? u.prompt_tokens ?? u.prompt_token_count ?? 0;
  const output = u.output_tokens ?? u.candidates_token_count ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? u.cached_input_tokens ?? 0;
  const cacheCreate = u.cache_creation_input_tokens ?? 0;
  const total = u.total_tokens ?? input + cacheRead + cacheCreate;

  return {
    total,
    input,
    output,
    cacheRead,
    cacheCreate,
    lastAssistantIndex,
  };
}

function usageFromEntry(entry: TranscriptEntry) {
  return entry.message?.usage ?? entry.message?.tokens ?? entry.usage ?? entry.tokens;
}
