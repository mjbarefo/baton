import type { StatusJSON } from "../statusline/status-json.ts";
import type { WidgetFlags } from "./flags.ts";
import { renderBatonBadgeStates } from "../statusline/widgets.ts";
import { stripAnsi } from "../statusline/color.ts";

const DEFAULT_MAX = 200_000;

export function renderBadgeWidget(json: StatusJSON, flags: WidgetFlags): string {
  const max = json.context_window?.context_window_size ?? DEFAULT_MAX;
  const rendered = renderBatonBadgeStates(json.cwd, json.session_id, max, flags.maxWidth);
  if (rendered === null) return "";
  return flags.color ? rendered : stripAnsi(rendered);
}
