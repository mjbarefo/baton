import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  SUBCOMMANDS,
  buildCommand,
  installManifestPath,
  userBatonCommandPath,
  userBatonSkillDir,
  userBatonSkillPath,
  userClaudeDir,
  userCommandsDir,
  userDropCommandPath,
  userSettingsPath,
  userSkillsDir,
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

function loadSettings(settingsPath: string): Settings {
  if (!existsSync(settingsPath)) return {};
  try {
    return JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
  } catch (err) {
    throw new Error(
      `Failed to parse ${settingsPath}: ${String(err)}. Fix manually before running baton install.`,
    );
  }
}

function backup(settingsPath: string): string | null {
  if (!existsSync(settingsPath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${settingsPath}.baton-backup-${ts}`;
  copyFileSync(settingsPath, path);
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

function settingsContainBatonEntries(settings: Settings): boolean {
  if (isBatonCommand(settings.statusLine?.command)) return true;
  for (const matchers of Object.values(settings.hooks ?? {})) {
    for (const matcher of matchers) {
      for (const hook of matcher.hooks ?? []) {
        if (isBatonCommand(hook.command)) return true;
      }
    }
  }
  return false;
}

function writeFileIfChanged(path: string, body: string): boolean {
  if (existsSync(path)) {
    const existing = readFileSync(path, "utf8");
    if (existing === body) return false;
  }
  writeFileSync(path, body, "utf8");
  return true;
}

function writeBatonCommand(commandsDir: string, cmdPath: string, body: string): boolean {
  mkdirSync(commandsDir, { recursive: true });
  return writeFileIfChanged(cmdPath, body);
}

function dropCommandBody(): string {
  return [
    "---",
    "name: drop",
    "description: Archive and discard the pending baton so /clear starts a completely fresh session instead of auto-resuming. Invoke when the user runs /drop or says they want to start fresh without resuming.",
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
    "After it exits, relay whatever the command printed, then tell the user:",
    "",
    "> Type /clear to start a clean session.",
    "",
    "Do not write any files. Do not explore the codebase. Do not re-plan.",
    "",
  ].join("\n");
}

function writeDropCommand(commandsDir: string, cmdPath: string): boolean {
  mkdirSync(commandsDir, { recursive: true });
  return writeFileIfChanged(cmdPath, dropCommandBody());
}

/**
 * Install the baton skill at ~/.claude/skills/baton/SKILL.md. Returns
 * `{ wrote, dirCreated }` so the installer can surface a restart warning when
 * the top-level skills/ directory didn't exist before — per Claude Code docs,
 * newly-created top-level skills dirs aren't hot-reloaded until restart.
 */
function writeBatonSkill(skillsDir: string, skillDir: string, skillPath: string, body: string): { wrote: boolean; dirCreated: boolean } {
  const dirCreated = !existsSync(skillsDir);
  mkdirSync(skillDir, { recursive: true });
  const wrote = writeFileIfChanged(skillPath, body);
  return { wrote, dirCreated };
}

function startsWithFrontmatter(path: string, expectedName: string): boolean {
  try {
    const buf = readFileSync(path, "utf8").slice(0, 80).replace(/\r\n/g, "\n");
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

interface InstallManifest {
  installedAt: string;
  settingsBackupPath: string | null;
}

/**
 * Write the install manifest on first install only. On reinstall, the existing
 * manifest already points at the pre-baton settings.json backup; overwriting it
 * would capture a backup whose contents are already polluted with baton entries
 * and make `uninstall` a silent no-op that leaves hooks/statusLine in place.
 * Returns true if a new manifest was written, false if one already existed.
 */
function writeInstallManifest(backupPath: string | null): boolean {
  const manifestPath = installManifestPath();
  if (existsSync(manifestPath)) return false;
  mkdirSync(dirname(manifestPath), { recursive: true });
  const manifest: InstallManifest = {
    installedAt: new Date().toISOString(),
    settingsBackupPath: backupPath,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return true;
}

export interface UninstallReport {
  restoredSettingsFrom: string | null;
  fallbackSurgical: boolean;
  removedFiles: string[];
  skippedFiles: { path: string; reason: string }[];
}

/**
 * Delete `path` only if its frontmatter still identifies it as a baton-owned
 * artifact (matching `expectedName`). If the user has replaced or heavily
 * edited the file, we surface it in `skippedFiles` instead of silently
 * clobbering their work.
 */
function removeIfBatonOwned(
  path: string,
  expectedName: string,
  removed: string[],
  skipped: { path: string; reason: string }[],
): void {
  if (!existsSync(path)) {
    skipped.push({ path, reason: "not found" });
    return;
  }
  if (!startsWithFrontmatter(path, expectedName)) {
    skipped.push({ path, reason: "user-modified (frontmatter no longer matches) — left in place" });
    return;
  }
  rmSync(path);
  removed.push(path);
}

export function uninstall(): UninstallReport {
  const manifestPath = installManifestPath();
  let manifest: InstallManifest | null = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as InstallManifest;
    } catch { /* ignore — fall through to surgical */ }
  }

  const settingsPath = userSettingsPath();
  let restoredSettingsFrom: string | null = null;
  let fallbackSurgical = false;

  if (manifest?.settingsBackupPath && existsSync(manifest.settingsBackupPath)) {
    copyFileSync(manifest.settingsBackupPath, settingsPath);
    restoredSettingsFrom = manifest.settingsBackupPath;
  } else if (existsSync(settingsPath)) {
    fallbackSurgical = true;
    const settings = loadSettings(settingsPath);
    if (settings.hooks) {
      for (const [event, matchers] of Object.entries(settings.hooks)) {
        const filtered = matchers
          .map((m) => ({ ...m, hooks: (m.hooks ?? []).filter((h) => !isBatonCommand(h.command ?? "")) }))
          .filter((m) => (m.hooks ?? []).length > 0);
        if (filtered.length === 0) delete settings.hooks[event];
        else settings.hooks[event] = filtered;
      }
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
    if (isBatonCommand(settings.statusLine?.command)) {
      delete settings.statusLine;
    }
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }

  const removedFiles: string[] = [];
  const skippedFiles: { path: string; reason: string }[] = [];

  // Slash commands: each lives in a shared ~/.claude/commands/ directory, so
  // we only delete the file if its frontmatter still matches what we wrote.
  removeIfBatonOwned(userBatonCommandPath(), "baton", removedFiles, skippedFiles);
  removeIfBatonOwned(userDropCommandPath(), "drop", removedFiles, skippedFiles);

  // Skill directory: gated two ways. SKILL.md must still be baton-owned, AND
  // the directory must contain nothing unexpected. If either check fails we
  // leave the whole directory alone and surface it — recursive deletion of a
  // user-modified directory is unrecoverable.
  const skillDir = userBatonSkillDir();
  const skillPath = userBatonSkillPath();
  if (existsSync(skillDir)) {
    const skillOwned = existsSync(skillPath) && startsWithFrontmatter(skillPath, "baton");
    let entries: string[];
    try {
      entries = readdirSync(skillDir);
    } catch {
      entries = [];
    }
    const extras = entries.filter((e) => e !== "SKILL.md");
    if (!skillOwned) {
      skippedFiles.push({
        path: skillPath,
        reason: "user-modified (frontmatter no longer matches) — left in place",
      });
      skippedFiles.push({
        path: skillDir,
        reason: "refusing recursive delete — SKILL.md is not baton-owned",
      });
    } else if (extras.length > 0) {
      skippedFiles.push({
        path: skillDir,
        reason: `refusing recursive delete — contains unexpected files: ${extras.join(", ")}`,
      });
    } else {
      rmSync(skillPath);
      removedFiles.push(skillPath);
      try {
        rmSync(skillDir, { recursive: true });
      } catch { /* ignore */ }
    }
  } else {
    skippedFiles.push({ path: skillPath, reason: "not found" });
  }

  if (existsSync(manifestPath)) rmSync(manifestPath);

  return { restoredSettingsFrom, fallbackSurgical, removedFiles, skippedFiles };
}

export function printUninstallReport(r: UninstallReport): void {
  const lines: string[] = [];
  lines.push("baton uninstall — summary");
  lines.push("");
  if (r.restoredSettingsFrom) {
    lines.push(`  settings.json: restored from backup`);
    lines.push(`    ${r.restoredSettingsFrom}`);
    lines.push(`  ⚠  Any settings changes made after baton was installed are not in this backup.`);
    lines.push(`     Inspect the backup file above if you need to recover them.`);
  } else if (r.fallbackSurgical) {
    lines.push(`  settings.json: baton entries removed (no backup found — surgical removal)`);
  } else {
    lines.push(`  settings.json: no changes (file not found)`);
  }
  lines.push("");
  for (const f of r.removedFiles) lines.push(`  removed: ${f}`);
  for (const s of r.skippedFiles) lines.push(`  skipped: ${s.path} (${s.reason})`);
  const preserved = r.skippedFiles.filter((s) => s.reason !== "not found");
  if (preserved.length > 0) {
    lines.push("");
    lines.push("⚠  The following artifacts were left in place because they no longer look like");
    lines.push("   baton-owned files. Inspect and remove them manually if desired:");
    for (const s of preserved) lines.push(`     ${s.path}`);
  }
  lines.push("");
  lines.push("baton has been uninstalled. Restart Claude Code for changes to take effect.");
  process.stdout.write(lines.join("\n") + "\n");
}

export function install(opts: InstallOptions = {}): InstallReport {
  warnIfBunMissing();
  const claudeDir = userClaudeDir();
  const settingsPath = userSettingsPath();
  const commandsDir = userCommandsDir();
  const batonCmdPath = userBatonCommandPath();
  const dropCmdPath = userDropCommandPath();
  const skillsDir = userSkillsDir();
  const batonSkillDir = userBatonSkillDir();
  const batonSkillPath = userBatonSkillPath();

  mkdirSync(claudeDir, { recursive: true });
  const settings = loadSettings(settingsPath);
  const hadBatonEntriesBeforeInstall = settingsContainBatonEntries(settings);
  const backupPath = backup(settingsPath);

  const { migratedCommands, migratedSkills } = migrateOldArtifacts(commandsDir, skillsDir);

  pruneStaleBatonHooks(settings, new Set([STATUSLINE_CMD, HOOK_UPS_CMD, HOOK_PC_CMD, HOOK_SS_CMD]));

  const statusResult = patchStatusline(settings, opts.force ?? false);
  const wroteUps = mergeHook(settings, "UserPromptSubmit", undefined, HOOK_UPS_CMD);
  const wrotePc = mergeHook(settings, "PreCompact", "auto", HOOK_PC_CMD);
  const wroteSs = mergeHook(settings, "SessionStart", undefined, HOOK_SS_CMD);

  mkdirSync(dirname(settingsPath), { recursive: true });
  const tmpSettingsPath = `${settingsPath}.tmp`;
  writeFileSync(tmpSettingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  renameSync(tmpSettingsPath, settingsPath);

  const templateBody = readTemplate();
  const wroteBatonCommand = writeBatonCommand(commandsDir, batonCmdPath, templateBody);
  const wroteDropCommand = writeDropCommand(commandsDir, dropCmdPath);
  const skillResult = writeBatonSkill(skillsDir, batonSkillDir, batonSkillPath, templateBody);

  writeInstallManifest(hadBatonEntriesBeforeInstall ? null : backupPath);

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
    settingsPath,
    batonCommandPath: batonCmdPath,
    dropCommandPath: dropCmdPath,
    batonSkillPath,
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
