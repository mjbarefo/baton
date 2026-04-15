import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readTranscript, isMainChain, type TranscriptEntry } from "../transcript/read.ts";
import { BATON_REL_PATH } from "../config.ts";

const RECENT_TURN_COUNT = 8;

function flatten(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") parts.push(item);
    else if (item && typeof item === "object") {
      const obj = item as Record<string, unknown>;
      if (typeof obj.text === "string") parts.push(obj.text);
      else if (obj.type === "tool_use" && typeof obj.name === "string") {
        parts.push(`[tool_use:${obj.name}]`);
      } else if (obj.type === "tool_result") {
        parts.push(`[tool_result]`);
      }
    }
  }
  return parts.join(" ");
}

function truncate(s: string, n: number): string {
  s = s.replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

export function extractFilePaths(entries: TranscriptEntry[]): string[] {
  const paths = new Map<string, string>();
  const re = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/]|[\w-]+[\\/])[\w./\\-]*\.(?:ts|tsx|js|mjs|py|go|rs|java|md|json|yml|yaml|sh|toml)(?::\d+(?:-\d+)?)?/g;
  for (const e of entries) {
    if (!isMainChain(e)) continue;
    const text = flatten(e.message?.content);
    for (const match of text.matchAll(re)) {
      const prev = match.index && match.index > 0 ? text[match.index - 1] : "";
      if (prev === "." || prev === "/") continue;
      const value = match[0].replace(/[),.;]+$/, "");
      if (value.startsWith("//")) continue;
      if (value.includes("://")) continue;
      paths.set(value.toLowerCase(), value);
    }
  }
  return Array.from(paths.values()).slice(0, 40);
}

export function writeFallbackBaton(cwd: string, transcriptPath: string, tokens: number): string {
  const entries = readTranscript(transcriptPath);
  const mainChain = entries.filter(isMainChain);

  const recent = mainChain.slice(-RECENT_TURN_COUNT);
  const recentBlocks = recent
    .map((e) => {
      const role = e.message?.role ?? e.type ?? "unknown";
      const text = truncate(flatten(e.message?.content), 500);
      return `### ${role}\n${text || "_(empty)_"}`;
    })
    .join("\n\n");

  const files = extractFilePaths(mainChain);
  const fileList = files.length ? files.map((f) => `- \`${f}\``).join("\n") : "_none extracted_";

  const iso = new Date().toISOString();
  const kTokens = Math.round(tokens / 1000);

  const body = `# Baton — fallback

> ⚠ **This is a fallback baton written deterministically by baton because auto-compaction was about to fire and no recent \`/baton\` existed.** It is less structured than a Claude-authored baton. A fresh session should read this, then read the actual transcript at \`${transcriptPath}\` if more context is needed.

_Written by baton PreCompact hook at ${iso}. Context at ~${kTokens}k tokens._

## Current Goal
_unknown — Claude did not author this baton. Ask the user to restate the goal._

## Completed This Session
_not available in fallback — inspect \`Recent Turns\` below._

## Active Work
**What:** _unknown_
**Where:** see \`Key Files\` below
**Why:** _unknown_
**State:** _unknown_

## Next Concrete Action
_unknown — ask the user to confirm before taking any action. The fresh session MUST NOT guess._

## Decisions & Constraints
_not captured in fallback_

## Gotchas Discovered
_not captured in fallback_

## User Preferences Observed
_not captured in fallback_

## Open Questions for the User
- What was the current goal when the baton fired?
- What is the next concrete action?

## Key Files (heuristically extracted)
${fileList}

## Recent Turns (last ${recent.length} main-chain messages)

${recentBlocks || "_(no recent turns)_"}
`;

  const outPath = join(cwd, BATON_REL_PATH);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, body, "utf8");
  return outPath;
}
