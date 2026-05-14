import type { StatusJSON } from "../statusline/status-json.ts";

export type { StatusJSON };

export function safeParseStatusJSON(raw: string): StatusJSON {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as StatusJSON;
  } catch {
    return {};
  }
}
