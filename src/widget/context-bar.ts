import type { StatusJSON } from "../statusline/status-json.ts";
import type { WidgetFlags } from "./flags.ts";
import { renderBar } from "../statusline/bar.ts";
import { tokenTotalFromTranscript } from "../statusline/session-state.ts";
import { stripAnsi } from "../statusline/color.ts";

const DEFAULT_MAX = 200_000;
const DEFAULT_BAR_WIDTH = 12;
const MIN_BAR_WIDTH = 3;

export function renderContextBarWidget(json: StatusJSON, flags: WidgetFlags): string {
  const payloadMax = json.context_window?.context_window_size;
  const max = payloadMax ?? DEFAULT_MAX;
  const usedPct = json.context_window?.used_percentage;

  let tokens: number | null = null;
  if (usedPct != null && payloadMax) {
    tokens = Math.round((usedPct / 100) * payloadMax);
  } else if (json.transcript_path) {
    tokens = tokenTotalFromTranscript(json.transcript_path);
  }
  if (tokens === null) return "";

  let width = DEFAULT_BAR_WIDTH;
  if (flags.maxWidth !== undefined) {
    if (flags.maxWidth >= MIN_BAR_WIDTH) {
      width = flags.maxWidth;
    } else {
      process.stderr.write(
        `baton widget context-bar: --max-width ${flags.maxWidth} < ${MIN_BAR_WIDTH}, using default ${DEFAULT_BAR_WIDTH}\n`,
      );
    }
  }

  const rendered = renderBar(tokens, max, width);
  return flags.color ? rendered : stripAnsi(rendered);
}
