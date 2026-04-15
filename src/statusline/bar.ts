import chalk from "chalk";
import { THRESHOLDS } from "../config.ts";

const BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

export type Zone = "green" | "yellow" | "orange" | "red";

export function zoneFor(tokens: number): Zone {
  if (tokens >= THRESHOLDS.ORANGE_MAX) return "red";
  if (tokens >= THRESHOLDS.YELLOW_MAX) return "orange";
  if (tokens >= THRESHOLDS.GREEN_MAX) return "yellow";
  return "green";
}

export function paintZone(zone: Zone, text: string): string {
  switch (zone) {
    case "green":
      return chalk.green(text);
    case "yellow":
      return chalk.yellow(text);
    case "orange":
      return chalk.hex("#ff8800")(text);
    case "red":
      return chalk.bold.red(text);
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
export function renderBar(tokens: number, max: number, width = 12): string {
  const zone = zoneFor(tokens);
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
  const tickRatio = THRESHOLDS.ORANGE_MAX / max;
  if (tickRatio > 0 && tickRatio < 1) {
    const tickIdx = Math.min(width - 1, Math.round(tickRatio * width));
    if (cells[tickIdx] !== "█") cells[tickIdx] = chalk.dim("┊");
  }

  const bar = cells.join("");
  const label = `${formatK(tokens)}/${formatK(max)}`;
  return paintZone(zone, bar) + " " + paintZone(zone, label);
}
