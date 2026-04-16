import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ORANGE_MAX intentionally sits above NUDGE_HARD: the visual bar escalates after
// the hard nudge fires, not before. The nudge is the primary signal; the color
// change is a trailing indicator for sessions where Claude hasn't acted yet.
export const THRESHOLDS = {
  GREEN_MAX: 80_000,
  YELLOW_MAX: 110_000,
  ORANGE_MAX: 125_000,
  NUDGE_SOFT: 110_000,
  NUDGE_HARD: 120_000,
} as const;

/** Nudge toward /baton after a session has been open this long (5 hours). */
export const SESSION_AGE_NUDGE_MS = 5 * 60 * 60 * 1000;
/** Minimum token count for the age nudge to fire (skip trivial sessions). */
export const SESSION_AGE_NUDGE_MIN_TOKENS = 30_000;

const _BATON_FRESH_MS_DEFAULT = 10 * 60 * 1000;
const _batonFreshRaw = Number(process.env.BATON_FRESH_MS ?? _BATON_FRESH_MS_DEFAULT);
if (process.env.BATON_FRESH_MS !== undefined && isNaN(_batonFreshRaw)) {
  process.stderr.write(`baton: BATON_FRESH_MS="${process.env.BATON_FRESH_MS}" is not a number — using default ${_BATON_FRESH_MS_DEFAULT}ms\n`);
}
export const BATON_FRESH_MS = isNaN(_batonFreshRaw) ? _BATON_FRESH_MS_DEFAULT : _batonFreshRaw;

export const BATON_REL_PATH = ".claude/baton/BATON.md";

export function userHomeDir(): string {
  if (process.platform === "win32") {
    return process.env.USERPROFILE ?? homedir();
  }
  return process.env.HOME ?? homedir();
}

export function userClaudeDir(): string {
  return join(userHomeDir(), ".claude");
}

export function userSettingsPath(): string {
  return join(userClaudeDir(), "settings.json");
}

export function userCommandsDir(): string {
  return join(userClaudeDir(), "commands");
}

export function userBatonCommandPath(): string {
  return join(userCommandsDir(), "baton.md");
}

export function userDropCommandPath(): string {
  return join(userCommandsDir(), "drop.md");
}

export function userSkillsDir(): string {
  return join(userClaudeDir(), "skills");
}

export function userBatonSkillDir(): string {
  return join(userSkillsDir(), "baton");
}

export function userBatonSkillPath(): string {
  return join(userBatonSkillDir(), "SKILL.md");
}

export function batonStateDir(): string {
  return join(userClaudeDir(), "baton", "state");
}

export function batonArchiveDir(): string {
  return join(userClaudeDir(), "baton", "archive");
}

export const SUBCOMMANDS = {
  statusline: "statusline",
  hookUps: "hook user-prompt-submit",
  hookPc: "hook pre-compact",
  hookSs: "hook session-start",
} as const;

export function cliPath(): string {
  const modulePath = fileURLToPath(import.meta.url);
  const sourceCliPath = join(dirname(modulePath), "cli.ts");
  const path = modulePath.endsWith("config.ts") ? sourceCliPath : modulePath;
  return path.replace(/\\/g, "/");
}

export function buildCommand(sub: string): string {
  const path = cliPath();
  const runner = path.endsWith(".ts") ? "bun run" : "node";
  return `${runner} "${path}" ${sub}`;
}
