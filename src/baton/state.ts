export type NudgeLevel = "none" | "soft" | "hard";

export interface BatonState {
  level: NudgeLevel;
  maxTokens?: number;
  timeNudgeSent?: boolean;
  rateLimit5hPct?: number;   // 0-100, or undefined when never seen
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
