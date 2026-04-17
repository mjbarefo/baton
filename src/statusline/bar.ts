import { THRESHOLDS } from "../config.ts";
import { color } from "./color.ts";

const BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

export type Zone = "green" | "yellow" | "orange" | "red";

export function zoneFor(tokens: number, max: number): Zone {
  if (tokens >= Math.floor(THRESHOLDS.ORANGE_MAX * max)) return "red";
  if (tokens >= Math.floor(THRESHOLDS.YELLOW_MAX * max)) return "orange";
  if (tokens >= Math.floor(THRESHOLDS.GREEN_MAX * max)) return "yellow";
  return "green";
}

export function paintZone(zone: Zone, text: string): string {
  switch (zone) {
    case "green":
      return color.green(text);
    case "yellow":
      return color.yellow(text);
    case "orange":
      return color.hex("#ff8800")(text);
    case "red":
      return color.bold.red(text);
  }
}

export function formatK(tokens: number): string {
  if (tokens >= 1000) return (tokens / 1000).toFixed(tokens >= 100_000 ? 0 : 1) + "k";
  return String(tokens);
}

/**
 * Render a context bar with an embedded tick mark at the baton baton threshold,
 * so the user can see at a glance how much runway they have before baton intervenes.
 * Width is the total cell count; the tick replaces one cell, keeping the bar width stable.
 */
export function renderBar(tokens: number | null, max: number, width = 12): string {
  if (tokens === null) {
    return color.white.dim("░".repeat(width) + " --/--");
  }
  const zone = zoneFor(tokens, max);
  if (zone === "red") {
    return paintZone("red", "⚠ BATON NOW");
  }

  const ratio = Math.max(0, Math.min(1, tokens / max));
  const totalEighths = Math.round(ratio * width * 8);
  const fullBlocks = Math.floor(totalEighths / 8);
  const remainder = totalEighths - fullBlocks * 8;

  // Cells: fullBlocks of "█", then optional partial, then "·" padding.
  const cells: string[] = [];
  for (let i = 0; i < fullBlocks; i++) cells.push("█");
  if (remainder > 0 && cells.length < width) cells.push(BLOCKS[remainder]!);
  while (cells.length < width) cells.push("░");

  // Overlay the baton threshold tick. Once the bar has passed it, the tick is
  // omitted — the color already signals that you're past.
  const tickRatio = THRESHOLDS.ORANGE_MAX;
  if (tickRatio > 0 && tickRatio < 1) {
    const tickIdx = Math.min(width - 1, Math.round(tickRatio * width));
    if (cells[tickIdx] !== "█") cells[tickIdx] = color.dim("┊");
  }

  const bar = cells.join("");
  const label = `${formatK(tokens)}/${formatK(max)}`;
  return paintZone(zone, bar) + " " + paintZone(zone, label);
}
