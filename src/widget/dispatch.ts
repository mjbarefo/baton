import { safeParseStatusJSON } from "./json.ts";
import { parseWidgetFlags } from "./flags.ts";
import { renderBadgeWidget } from "./badge.ts";
import { renderContextBarWidget } from "./context-bar.ts";
import { persistStateSnapshot } from "../statusline/session-state.ts";

export async function runWidget(name: string, argv: string[], raw: string): Promise<void> {
  try {
    const json = safeParseStatusJSON(raw);
    const flags = parseWidgetFlags(argv);

    if (json.session_id) {
      const rawPct = json.rate_limits?.five_hour?.used_percentage;
      const rateLimit5hPct =
        typeof rawPct === "number" && Number.isFinite(rawPct) && rawPct >= 0 && rawPct <= 100
          ? rawPct
          : undefined;
      persistStateSnapshot(json.session_id, {
        maxTokens: json.context_window?.context_window_size,
        rateLimit5hPct,
      });
    }

    let text: string;
    if (name === "badge") {
      text = renderBadgeWidget(json, flags);
    } else if (name === "context-bar") {
      text = renderContextBarWidget(json, flags);
    } else {
      process.stderr.write(`baton widget: unknown widget "${name}"\n`);
      text = "";
    }
    process.stdout.write(text + "\n");
  } catch (err) {
    process.stderr.write(`baton widget ${name}: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stdout.write("\n");
  }
}
