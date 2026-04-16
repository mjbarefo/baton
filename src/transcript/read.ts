import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";

export interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface TranscriptEntry {
  type?: string;
  isSidechain?: boolean;
  isApiErrorMessage?: boolean;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  message?: {
    role?: string;
    content?: unknown;
    usage?: TranscriptUsage;
    stop_reason?: string | null;
  };
  toolUseResult?: unknown;
  [key: string]: unknown;
}

export function readTranscript(path: string): TranscriptEntry[] {
  if (!path || !existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n");
  const out: TranscriptEntry[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as TranscriptEntry);
    } catch {
      // Skip malformed lines — transcripts can be mid-write.
    }
  }
  return out;
}

export function readLatestAssistantUsageEntry(path: string): TranscriptEntry | null {
  if (!path || !existsSync(path)) return null;

  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const chunkSize = 64 * 1024;
    let position = size;
    let suffix = "";

    while (position > 0) {
      const bytesToRead = Math.min(chunkSize, position);
      position -= bytesToRead;
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      const text = buffer.toString("utf8", 0, bytesRead) + suffix;
      const lines = text.split("\n");
      suffix = lines.shift() ?? "";

      for (let i = lines.length - 1; i >= 0; i--) {
        const entry = parseAssistantUsageLine(lines[i]);
        if (entry) return entry;
      }
    }

    return parseAssistantUsageLine(suffix);
  } finally {
    closeSync(fd);
  }
}

function parseAssistantUsageLine(line: string | undefined): TranscriptEntry | null {
  const trimmed = line?.trim();
  if (!trimmed) return null;
  try {
    const entry = JSON.parse(trimmed) as TranscriptEntry;
    if (!isMainChain(entry)) return null;
    if (entry.message?.role !== "assistant") return null;
    if (!entry.message.usage) return null;
    return entry;
  } catch {
    return null;
  }
}

export function isMainChain(entry: TranscriptEntry): boolean {
  return entry.isSidechain !== true && entry.isApiErrorMessage !== true;
}

/**
 * Returns the timestamp of the first entry in the transcript, or null if not found.
 * Reads in forward chunks and stops as soon as a timestamp is found, so it never
 * parses the full file on long-lived sessions.
 */
export function readFirstTimestamp(path: string): string | null {
  if (!path || !existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const chunkSize = 64 * 1024;
    let position = 0;
    let prefix = "";

    while (position < size) {
      const bytesToRead = Math.min(chunkSize, size - position);
      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      position += bytesRead;
      const text = prefix + buffer.toString("utf8", 0, bytesRead);
      const lines = text.split("\n");
      // Last element may be a partial line — carry it forward.
      prefix = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const entry = JSON.parse(trimmed) as TranscriptEntry;
          if (entry.timestamp) return entry.timestamp;
        } catch {
          // Skip malformed lines.
        }
      }
    }

    // Check any remaining partial line.
    if (prefix.trim()) {
      try {
        const entry = JSON.parse(prefix.trim()) as TranscriptEntry;
        if (entry.timestamp) return entry.timestamp;
      } catch { /* ignore */ }
    }

    return null;
  } finally {
    closeSync(fd);
  }
}
