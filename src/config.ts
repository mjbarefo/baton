import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const THRESHOLDS = {
  GREEN_MAX: 80_000,
  YELLOW_MAX: 110_000,
  ORANGE_MAX: 125_000,
  NUDGE_SOFT: 110_000,
  NUDGE_HARD: 120_000,
} as const;

export const BATON_FRESH_MS = Number(process.env.BATON_FRESH_MS ?? 10 * 60 * 1000);

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
