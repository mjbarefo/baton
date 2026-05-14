import type { RateLimit } from "./widgets.ts";

export interface StatusJSON {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  cost?: { total_cost_usd?: number; total_duration_ms?: number };
  context_window?: {
    context_window_size?: number;
    used_percentage?: number;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
  };
  worktree?: { branch?: string; is_dirty?: boolean };
  rate_limits?: {
    five_hour?: RateLimit;
    seven_day?: RateLimit;
  } | null;
}
