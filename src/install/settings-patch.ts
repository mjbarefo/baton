import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  USER_CLAUDE_DIR,
  USER_SETTINGS_PATH,
  USER_COMMANDS_DIR,
  USER_BATON_CMD_PATH,
  USER_DROP_CMD_PATH,
  USER_SKILLS_DIR,
  USER_BATON_SKILL_DIR,
  USER_BATON_SKILL_PATH,
  SUBCOMMANDS,
  buildCommand,
} from "../config.ts";
import { readTemplate } from "../baton/template-loader.ts";

const STATUSLINE_CMD = buildCommand(SUBCOMMANDS.statusline);
const HOOK_UPS_CMD = buildCommand(SUBCOMMANDS.hookUps);
const HOOK_PC_CMD = buildCommand(SUBCOMMANDS.hookPc);
const HOOK_SS_CMD = buildCommand(SUBCOMMANDS.hookSs);
const KNOWN_SUBCOMMANDS = [
  "statusline",
  "hook user-prompt-submit",
  "hook pre-compact",
  "hook session-start",
  "catch",
  "drop",
];

function isBatonCommand(cmd: string | undefined): boolean {
  if (!cmd) return false;
  const trimmed = cmd.trim();
  if (
    KNOWN_SUBCOMMANDS.some(
      (sub) =>
        trimmed === `baton ${sub}` ||
        trimmed.startsWith(`baton ${sub} `),
    )
  ) {
    return true;
  }
  // Self-locating source or published package style.
  if (/[\\/](?:cc)?baton[\\/].*(?:src[\\/]cli\.ts|dist[\\/]cli\.js)(?:["'\s]|$)/.test(cmd)) return true;
  return false;
}

interface HookEntry {
  type?: "command";
  command?: string;
  timeout?: number;
}
interface HookMatcher {
  matcher?: string;
  hooks?: HookEntry[];
}
interface Settings {
  statusLine?: { type?: string; command?: string; padding?: number };
  hooks?: Record<string, HookMatcher[]>;
  [k: string]: unknown;
}

export interface InstallOptions {
  force?: boolean;
}

export interface InstallReport {
  backupPath: string | null;
  wroteStatusline: boolean;
  skippedStatuslineReason: string | null;
  replacedStatusline: string | null;
  wroteUserPromptSubmit: boolean;
  wrotePreCompact: boolean;
  wroteSessionStart: boolean;
  wroteBatonCommand: boolean;
  wroteDropCommand: boolean;
  wroteBatonSkill: boolean;
  skillsDirCreated: boolean;
  settingsPath: string;
  batonCommandPath: string;
  dropCommandPath: string;
  batonSkillPath: string;
  migratedCommands: string[];
  migratedSkills: string[];
}

function loadSettings(): Settings {
  if (!existsSync(USER_SETTINGS_PATH)) return {};
  try {
    return JSON.parse(readFileSync(USER_SETTINGS_PATH, "utf8")) as Settings;
  } catch (err) {
    throw new Error(
      `Failed to parse ${USER_SETTINGS_PATH}: ${String(err)}. Fix manually before running baton install.`,
    );
  }
}

function backup(): string | null {
  if (!existsSync(USER_SETTINGS_PATH)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${USER_SETTINGS_PATH}.baton-backup-${ts}`;
  copyFileSync(USER_SETTINGS_PATH, path);
  return path;
}

function mergeHook(
  settings: Settings,
  eventName: string,
  matcher: string | undefined,
  command: string,
): boolean {
  settings.hooks ??= {};
  const arr = (settings.hooks[eventName] ??= []);
  for (const m of arr) {
    for (const h of m.hooks ?? []) {
      if (h.command === command) return false;
    }
  }
  arr.push({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command }],
  });
  return true;
}

function patchStatusline(
  settings: Settings,
  force: boolean,
): { wrote: boolean; skipped: string | null; replaced: string | null } {
  const existing = settings.statusLine?.command;
  if (existing === STATUSLINE_CMD) return { wrote: false, skipped: null, replaced: null };
  // Rewrite any older baton invocation (e.g. bare `baton statusline`) to the current one.
  if (existing && isBatonCommand(existing)) {
    settings.statusLine = { type: "command", command: STATUSLINE_CMD, padding: 0 };
    return { wrote: true, skipped: null, replaced: null };
  }
  if (existing && !isBatonCommand(existing)) {
    if (force) {
      settings.statusLine = { type: "command", command: STATUSLINE_CMD, padding: 0 };
      return { wrote: true, skipped: null, replaced: existing };
    }
    return {
      wrote: false,
      skipped: `existing statusLine.command is "${existing}" — not clobbering. Re-run with --force to replace it.`,
      replaced: null,
    };
  }
  settings.statusLine = { type: "command", command: STATUSLINE_CMD, padding: 0 };
  return { wrote: true, skipped: null, replaced: null };
}

/**
 * Remove any stale baton hook entries pointing at an old invocation path.
 * Keeps the merge idempotent across relocations of the baton source tree
 * and across upgrades from the bare-PATH invocation style.
 */
function pruneStaleBatonHooks(settings: Settings, currentCommands: Set<string>): void {
  if (!settings.hooks) return;
  for (const [eventName, matchers] of Object.entries(settings.hooks)) {
    const pruned: HookMatcher[] = [];
    for (const m of matchers) {
      const keptHooks = (m.hooks ?? []).filter((h) => {
        const c = h.command ?? "";
        if (!isBatonCommand(c)) return true;
        return currentCommands.has(c);
      });
      if (keptHooks.length > 0) pruned.push({ ...m, hooks: keptHooks });
    }
    if (pruned.length === 0) {
      delete settings.hooks[eventName];
    } else {
      settings.hooks[eventName] = pruned;
    }
  }
}

function writeFileIfChanged(path: string, body: string): boolean {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing === body) return false;
  }
  writeFileSync(path, body, "utf8");
  return true;
}

function writeBatonCommand(body: string): boolean {
  mkdirSync(USER_COMMANDS_DIR, { recursive: true });
  return writeFileIfChanged(USER_BATON_CMD_PATH, body);
}

function dropCommandBody(): string {
  return [
    "---",
    "name: drop",
    "description: Drop the pending baton baton so /clear starts a truly fresh session instead of auto-resuming.",
    "disable-model-invocation: false",
    "---",
    "",
    "# /drop — Drop pending baton",
    "",
    "Run this exact command using the Bash tool, and nothing else:",
    "",
    "```bash",
    buildCommand("drop"),
    "```",
    "",
    "After it exits, tell the user verbatim:",
    "",
    "> Baton dropped. Type /clear for a clean session.",
    "",
    "Do not write any files. Do not explore the codebase. Do not re-plan.",
    "",
  ].join("\n");
}

function writeDropCommand(): boolean {
  mkdirSync(USER_COMMANDS_DIR, { recursive: true });
  return writeFileIfChanged(USER_DROP_CMD_PATH, dropCommandBody());
}

/**
 * Install the baton skill at ~/.claude/skills/baton/SKILL.md. Returns
 * `{ wrote, dirCreated }` so the installer can surface a restart warning when
 * the top-level skills/ directory didn't exist before — per Claude Code docs,
 * newly-created top-level skills dirs aren't hot-reloaded until restart.
 */
function writeBatonSkill(body: string): { wrote: boolean; dirCreated: boolean } {
  const dirCreated = !existsSync(USER_SKILLS_DIR);
  mkdirSync(USER_BATON_SKILL_DIR, { recursive: true });
  const wrote = writeFileIfChanged(USER_BATON_SKILL_PATH, body);
  return { wrote, dirCreated };
}

function startsWithFrontmatter(path: string, expectedName: string): boolean {
  try {
    const buf = readFileSync(path, "utf8").slice(0, 80);
    return buf.startsWith(`---\nname: ${expectedName}\n`);
  } catch {
    return false;
  }
}

/**
 * Remove old handoff/handoff-discard commands and the handoff skill dir if they
 * were written by a prior baton install (identified by frontmatter name check).
 */
function migrateOldArtifacts(userCommandsDir: string, userSkillsDir: string): { migratedCommands: string[]; migratedSkills: string[] } {
  const migratedCommands: string[] = [];
  const migratedSkills: string[] = [];

  const oldHandoffCmd = join(userCommandsDir, "handoff.md");
  if (existsSync(oldHandoffCmd) && startsWithFrontmatter(oldHandoffCmd, "handoff")) {
    rmSync(oldHandoffCmd);
    migratedCommands.push(oldHandoffCmd);
  }

  const oldDiscardCmd = join(userCommandsDir, "handoff-discard.md");
  if (existsSync(oldDiscardCmd) && startsWithFrontmatter(oldDiscardCmd, "handoff-discard")) {
    rmSync(oldDiscardCmd);
    migratedCommands.push(oldDiscardCmd);
  }

  const oldSkillDir = join(userSkillsDir, "handoff");
  const oldSkillFile = join(oldSkillDir, "SKILL.md");
  if (existsSync(oldSkillFile) && startsWithFrontmatter(oldSkillFile, "handoff")) {
    // Only delete if SKILL.md is the only file in the directory.
    const entries = readdirSync(oldSkillDir);
    if (entries.length === 1 && entries[0] === "SKILL.md") {
      rmSync(oldSkillDir, { recursive: true });
      migratedSkills.push(oldSkillDir);
    }
  }

  return { migratedCommands, migratedSkills };
}

function warnIfBunMissing(): void {
  if (!buildCommand("help").startsWith("bun run ")) return;
  const bunCheck = spawnSync("bun", ["--version"], { stdio: "pipe" });
  if (bunCheck.error || bunCheck.status !== 0) {
    console.warn("Warning: 'bun' not found on PATH. Source-mode hooks will fail until Bun is installed.");
  }
}

export function install(opts: InstallOptions = {}): InstallReport {
  warnIfBunMissing();
  mkdirSync(USER_CLAUDE_DIR, { recursive: true });
  const backupPath = backup();
  const settings = loadSettings();

  const { migratedCommands, migratedSkills } = migrateOldArtifacts(USER_COMMANDS_DIR, USER_SKILLS_DIR);

  pruneStaleBatonHooks(settings, new Set([STATUSLINE_CMD, HOOK_UPS_CMD, HOOK_PC_CMD, HOOK_SS_CMD]));

  const statusResult = patchStatusline(settings, opts.force ?? false);
  const wroteUps = mergeHook(settings, "UserPromptSubmit", undefined, HOOK_UPS_CMD);
  const wrotePc = mergeHook(settings, "PreCompact", "auto", HOOK_PC_CMD);
  const wroteSs = mergeHook(settings, "SessionStart", undefined, HOOK_SS_CMD);

  mkdirSync(dirname(USER_SETTINGS_PATH), { recursive: true });
  const tmpSettingsPath = `${USER_SETTINGS_PATH}.tmp`;
  writeFileSync(tmpSettingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  renameSync(tmpSettingsPath, USER_SETTINGS_PATH);

  const templateBody = readTemplate();
  const wroteBatonCommand = writeBatonCommand(templateBody);
  const wroteDropCommand = writeDropCommand();
  const skillResult = writeBatonSkill(templateBody);

  return {
    backupPath,
    wroteStatusline: statusResult.wrote,
    skippedStatuslineReason: statusResult.skipped,
    replacedStatusline: statusResult.replaced,
    wroteUserPromptSubmit: wroteUps,
    wrotePreCompact: wrotePc,
    wroteSessionStart: wroteSs,
    wroteBatonCommand,
    wroteDropCommand,
    wroteBatonSkill: skillResult.wrote,
    skillsDirCreated: skillResult.dirCreated,
    settingsPath: USER_SETTINGS_PATH,
    batonCommandPath: USER_BATON_CMD_PATH,
    dropCommandPath: USER_DROP_CMD_PATH,
    batonSkillPath: USER_BATON_SKILL_PATH,
    migratedCommands,
    migratedSkills,
  };
}

export function printReport(r: InstallReport): void {
  const lines: string[] = [];
  lines.push("baton install — summary");
  lines.push("");
  if (r.backupPath) lines.push(`  backup:    ${r.backupPath}`);
  else lines.push(`  backup:    (no prior settings.json)`);
  lines.push(`  settings:  ${r.settingsPath}`);
  const statusLabel = r.wroteStatusline
    ? r.replacedStatusline
      ? `installed (replaced "${r.replacedStatusline}")`
      : "installed"
    : r.skippedStatuslineReason
    ? `skipped (${r.skippedStatuslineReason})`
    : "already present";
  lines.push(`    statusLine:        ${statusLabel}`);
  lines.push(`    UserPromptSubmit:  ${r.wroteUserPromptSubmit ? "installed" : "already present"}`);
  lines.push(`    PreCompact (auto): ${r.wrotePreCompact ? "installed" : "already present"}`);
  lines.push(`    SessionStart:      ${r.wroteSessionStart ? "installed" : "already present"}`);
  lines.push(`  skill:     ${r.batonSkillPath}  ${r.wroteBatonSkill ? "(written)" : "(unchanged)"}`);
  lines.push(`  command:   ${r.batonCommandPath}  ${r.wroteBatonCommand ? "(written)" : "(unchanged)"}  (legacy mirror)`);
  lines.push(`  command:   ${r.dropCommandPath}  ${r.wroteDropCommand ? "(written)" : "(unchanged)"}  (/drop)`);
  if (r.migratedCommands.length > 0 || r.migratedSkills.length > 0) {
    lines.push("");
    lines.push("  migrated:");
    for (const p of r.migratedCommands) lines.push(`    deleted command: ${p}`);
    for (const p of r.migratedSkills) lines.push(`    deleted skill dir: ${p}`);
  }
  lines.push("");
  if (r.skillsDirCreated) {
    lines.push("⚠ ~/.claude/skills/ did not exist before. Claude Code must be RESTARTED before it");
    lines.push("  will pick up the /baton skill. After restart, /baton and the automatic");
    lines.push("  hard-threshold nudge will both work.");
    lines.push("");
  }
  lines.push("Start a new Claude Code session to pick up the statusline and hooks.");
  lines.push("Inside Claude Code, type /baton to snapshot at any time — or just let");
  lines.push("baton's hard-threshold nudge inject the baton instructions automatically.");
  process.stdout.write(lines.join("\n") + "\n");
}
