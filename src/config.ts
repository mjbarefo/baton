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

export const USER_CLAUDE_DIR = join(process.env.HOME ?? process.env.USERPROFILE ?? homedir(), ".claude");
export const USER_SETTINGS_PATH = join(USER_CLAUDE_DIR, "settings.json");
export const USER_COMMANDS_DIR = join(USER_CLAUDE_DIR, "commands");
export const USER_BATON_CMD_PATH = join(USER_COMMANDS_DIR, "baton.md");
export const USER_DROP_CMD_PATH = join(USER_COMMANDS_DIR, "drop.md");
export const USER_SKILLS_DIR = join(USER_CLAUDE_DIR, "skills");
export const USER_BATON_SKILL_DIR = join(USER_SKILLS_DIR, "baton");
export const USER_BATON_SKILL_PATH = join(USER_BATON_SKILL_DIR, "SKILL.md");

export const BATON_STATE_DIR = join(USER_CLAUDE_DIR, "baton", "state");
export const BATON_ARCHIVE_DIR = join(USER_CLAUDE_DIR, "baton", "archive");

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
