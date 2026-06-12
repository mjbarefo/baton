export type NudgeLevel = "none" | "soft" | "hard";

export interface BatonState {
  level: NudgeLevel;
  maxTokens?: number;
  timeNudgeSent?: boolean;
  rateLimit5hPct?: number;
  /** Consecutive auto-compact attempts blocked this session (PreCompact escape hatch). */
  compactBlocks?: number;
}

export function normalizeCompactBlocks(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
}

export function normalizeLevel(raw: unknown): NudgeLevel {
  return raw === "soft" || raw === "hard" ? raw : "none";
}

export function normalizeMaxTokens(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

export function normalizeRateLimit5hPct(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 100
    ? raw
    : undefined;
}
