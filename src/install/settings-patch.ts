import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  BATON_HOOK_TIMEOUT_S,
  SUBCOMMANDS,
  VERSION,
  buildCommand,
  hostInstallManifestPath,
  installManifestPath,
  legacyInstallManifestPath,
  userAgentsBatonSkillDir,
  userAgentsBatonSkillPath,
  userBatonAgentCommandPath,
  userBatonCodexCommandPath,
  userBatonCommandPath,
  userBatonGeminiCommandPath,
  userBatonSkillDir,
  userBatonSkillPath,
  userClaudeDir,
  userCommandsDir,
  userCodexConfigPath,
  userDropCommandPath,
  userGeminiBatonExtensionDir,
  userGeminiSettingsPath,
  userSettingsPath,
  userSkillsDir,
} from "../config.ts";
import { color } from "../statusline/color.ts";
import { readTemplateBodyWithOverride } from "../baton/template-loader.ts";

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
  "sidecar codex",
  "sidecar gemini",
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
  postinstall?: boolean;
}

export interface InstallReport {
  postinstall: boolean;
  backupPath: string | null;
  wroteStatusline: boolean;
  skippedStatuslineReason: string | null;
  replacedStatusline: string | null;
  wroteUserPromptSubmit: boolean;
  wrotePreCompact: boolean;
  wroteSessionStart: boolean;
  wroteBatonCommand: boolean;
  wroteDropCommand: boolean;
  wroteBatonCodexCommand: boolean;
  wroteBatonGeminiCommand: boolean;
  wroteBatonAgentCommand: boolean;
  settingsPath: string;
  batonCommandPath: string;
  dropCommandPath: string;
  batonCodexCommandPath: string;
  batonGeminiCommandPath: string;
  batonAgentCommandPath: string;
  migratedCommands: string[];
  migratedSkills: string[];
  templateSource: "bundled" | "override" | "extended";
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
  const basePath = `${settingsPath}.baton-backup-${ts}`;
  let path = basePath;
  for (let i = 1; existsSync(path); i++) {
    path = `${basePath}-${i}`;
  }
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

function batonCodexCommandBody(): string {
  return [
    "---",
    "name: baton-codex",
    "description: Run Codex CLI as a same-session sidecar using the current BATON.md for context. Invoke when the user runs /baton-codex and wants Codex to review, critique, or propose an alternative without starting a fresh session.",
    "disable-model-invocation: false",
    "---",
    "",
    "# /baton-codex — Codex sidecar",
    "",
    "This command continues in the current session. It is not a handoff command, and it must not run /clear.",
    "",
    "1. **Mode shortcut.** If the user's message already names a mode (`review`, `critique`, or `alternative`), use it as `<MODE>` and skip step 2.",
    "",
    "2. **Ask for the mode.** Call AskUserQuestion with exactly this shape:",
    "   - `header`: `\"Codex mode\"`",
    "   - `question`: `\"Which mode should Codex run in?\"`",
    "   - `multiSelect`: `false`",
    "   - `options`:",
    "     - `{ label: \"review\", description: \"Codex audits the plan for gaps and hidden assumptions\" }`",
    "     - `{ label: \"critique\", description: \"Codex argues against the approach\" }`",
    "     - `{ label: \"alternative\", description: \"Codex proposes a different approach\" }`",
    "",
    "   Use the user's answer as `<MODE>`.",
    "",
    "3. **Run the sidecar.** Run this exact command using the Bash tool, and nothing else:",
    "",
    "```bash",
    `${buildCommand("sidecar codex --mode")} <MODE>`,
    "```",
    "",
    "4. **Handle the result.**",
    "   - If the command exits non-zero, surface the stderr message to the user clearly (especially install hints like `'codex' not found on PATH`). Do not retry.",
    "   - If the command succeeds, the user has already seen Codex's output in the bash block — do not repeat it. If the user follows up, you may reference it. Do not act on Codex's suggestions or modify any files without explicit user direction.",
    "",
  ].join("\n");
}

function writeBatonCodexCommand(commandsDir: string, cmdPath: string): boolean {
  mkdirSync(commandsDir, { recursive: true });
  return writeFileIfChanged(cmdPath, batonCodexCommandBody());
}

function batonGeminiCommandBody(): string {
  return [
    "---",
    "name: baton-gemini",
    "description: Run Gemini CLI as a same-session sidecar using the current BATON.md for context. Invoke when the user runs /baton-gemini and wants Gemini to review, critique, or propose an alternative without starting a fresh session.",
    "disable-model-invocation: false",
    "---",
    "",
    "# /baton-gemini — Gemini sidecar",
    "",
    "This command continues in the current session. It is not a handoff command, and it must not run /clear.",
    "",
    "1. **Mode shortcut.** If the user's message already names a mode (`review`, `critique`, or `alternative`), use it as `<MODE>` and skip step 2.",
    "",
    "2. **Ask for the mode.** Call AskUserQuestion with exactly this shape:",
    "   - `header`: `\"Gemini mode\"`",
    "   - `question`: `\"Which mode should Gemini run in?\"`",
    "   - `multiSelect`: `false`",
    "   - `options`:",
    "     - `{ label: \"review\", description: \"Gemini audits the plan for gaps and hidden assumptions\" }`",
    "     - `{ label: \"critique\", description: \"Gemini argues against the approach\" }`",
    "     - `{ label: \"alternative\", description: \"Gemini proposes a different approach\" }`",
    "",
    "   Use the user's answer as `<MODE>`.",
    "",
    "3. **Run the sidecar.** Run this exact command using the Bash tool, and nothing else:",
    "",
    "```bash",
    `${buildCommand("sidecar gemini --mode")} <MODE>`,
    "```",
    "",
    "4. **Handle the result.**",
    "   - If the command exits non-zero, surface the stderr message to the user clearly (especially install hints like `'gemini' not found on PATH`). Do not retry.",
    "   - If the command succeeds, the user has already seen Gemini's output in the bash block — do not repeat it. If the user follows up, you may reference it. Do not act on Gemini's suggestions or modify any files without explicit user direction.",
    "",
  ].join("\n");
}

function writeBatonGeminiCommand(commandsDir: string, cmdPath: string): boolean {
  mkdirSync(commandsDir, { recursive: true });
  return writeFileIfChanged(cmdPath, batonGeminiCommandBody());
}

function batonAgentCommandBody(): string {
  const redactCommand = buildCommand("redact");
  return [
    "---",
    "name: baton-agent",
    "description: Launch a worktree-isolated subagent with a task-filtered, redacted BATON.md context. Invoke when the user runs /baton-agent followed by a concrete task for an isolated implementation agent.",
    "disable-model-invocation: false",
    "---",
    "",
    "# /baton-agent — Worktree-isolated subagent",
    "",
    "This command delegates a focused task to an Agent running in an isolated worktree. Follow these steps exactly.",
    "",
    "1. **Freshness check.** Locate the nearest `.baton/BATON.md` (or legacy `.claude/baton/BATON.md`) by walking up from the current working directory. If neither exists, tell the user:",
    "",
    "   > BATON.md not found — please run /baton first to create a snapshot, then re-run /baton-agent.",
    "",
    "   Stop. Do not proceed without a BATON.md.",
    "",
    "2. **Redact.** Run this exact command using the Bash tool and capture stdout as the redacted baton body:",
    "",
    "```bash",
    redactCommand,
    "```",
    "",
    "   Treat stderr as status output; it should report `Redacted N secret(s)`.",
    "",
    "3. **Parse task.** The task is everything after `/baton-agent` in the invocation.",
    "",
    "   Example: `/baton-agent refactor the statusline widgets to use a shared formatter`",
    "",
    "   Task: `refactor the statusline widgets to use a shared formatter`",
    "",
    "   If the user passed `--branch <name>`, keep that as the display slug and remove the flag plus value from the task text.",
    "",
    "4. **Synthesize filtered baton.** Using the `agent-template.md` structure below, inline-synthesize a focused slice of the redacted baton relevant to the task.",
    "",
    "   Keep:",
    "   - Goal",
    "   - Decisions and constraints that apply to this task",
    "   - Relevant file paths",
    "",
    "   Drop:",
    "   - Unrelated work threads",
    "   - Completed items that do not affect this task",
    "   - Context irrelevant to the task",
    "",
    "   ```markdown",
    "   ## Task",
    "   {{task}}",
    "",
    "   ## Relevant Context",
    "   {{filtered_goal_and_decisions}}",
    "",
    "   ## Files In Scope",
    "   {{relevant_file_paths}}",
    "",
    "   ## What to Ignore",
    "   {{unrelated_threads}}",
    "   ```",
    "",
    "5. **Confirm scope.** Show the filtered baton to the user in a fenced `markdown` code block and ask:",
    "",
    "   > Does this scope look right? Reply yes to launch, or describe what to adjust.",
    "",
    "   Do not proceed until the user confirms.",
    "",
    "6. **Derive display slug.** If the user passed `--branch <name>`, use that exact name as the display slug. Otherwise, take the first 4-5 significant words of the task, lowercase them, hyphenate them, and prefix with `baton-agent/`. This slug is for use in the post-launch summary only.",
    "",
    "   Example: `refactor the statusline widgets to use a shared formatter` becomes `baton-agent/refactor-statusline-widgets`.",
    "",
    "7. **Spawn subagent.** Call the Agent tool with `isolation: \"worktree\"` only. Do not attempt to specify a branch name — the runtime assigns it automatically and returns it in the result. The subagent prompt must include this structure:",
    "",
    "   ```markdown",
    "   ## Context",
    "   <filtered baton>",
    "",
    "   ## Your Task",
    "   <task>",
    "",
    "   Make all changes on the current worktree branch. Do not push.",
    "   ```",
    "",
    "8. **Surface result.** When the Agent tool returns, read the branch name from its result. Display it prominently:",
    "",
    "   > Changes are on branch `<branch-from-result>` — review with `git diff <default-branch>...<branch-from-result>`",
    "",
    "   Then present the result naturally.",
    "",
  ].join("\n");
}

function writeBatonAgentCommand(commandsDir: string, cmdPath: string): boolean {
  mkdirSync(commandsDir, { recursive: true });
  return writeFileIfChanged(cmdPath, batonAgentCommandBody());
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
 * Remove obsolete baton-owned artifacts left behind by older versions:
 * the handoff command/skill (renamed to baton long ago), and the baton skill
 * (the command file's frontmatter now auto-registers it as a skill, so the
 * separate SKILL.md was producing a duplicate /baton picker entry).
 *
 * Identified by frontmatter name. Skill dirs are only removed if SKILL.md is
 * the sole file inside, to avoid clobbering anything a user dropped in.
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

  const oldHandoffSkillDir = join(userSkillsDir, "handoff");
  const oldHandoffSkillFile = join(oldHandoffSkillDir, "SKILL.md");
  if (existsSync(oldHandoffSkillFile) && startsWithFrontmatter(oldHandoffSkillFile, "handoff")) {
    const entries = readdirSync(oldHandoffSkillDir);
    if (entries.length === 1 && entries[0] === "SKILL.md") {
      rmSync(oldHandoffSkillDir, { recursive: true });
      migratedSkills.push(oldHandoffSkillDir);
    }
  }

  const oldBatonSkillDir = join(userSkillsDir, "baton");
  const oldBatonSkillFile = join(oldBatonSkillDir, "SKILL.md");
  if (existsSync(oldBatonSkillFile) && startsWithFrontmatter(oldBatonSkillFile, "baton")) {
    const entries = readdirSync(oldBatonSkillDir);
    if (entries.length === 1 && entries[0] === "SKILL.md") {
      rmSync(oldBatonSkillDir, { recursive: true });
      migratedSkills.push(oldBatonSkillDir);
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
  const legacyManifest = legacyInstallManifestPath();
  if (existsSync(legacyManifest)) {
    mkdirSync(dirname(manifestPath), { recursive: true });
    copyFileSync(legacyManifest, manifestPath);
    return false;
  }
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
  const legacyManifestPath = legacyInstallManifestPath();
  let manifest: InstallManifest | null = null;
  const readableManifestPath = existsSync(manifestPath) ? manifestPath : legacyManifestPath;
  if (existsSync(readableManifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(readableManifestPath, "utf8")) as InstallManifest;
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
  removeIfBatonOwned(userBatonCodexCommandPath(), "baton-codex", removedFiles, skippedFiles);
  removeIfBatonOwned(userBatonGeminiCommandPath(), "baton-gemini", removedFiles, skippedFiles);
  removeIfBatonOwned(userBatonAgentCommandPath(), "baton-agent", removedFiles, skippedFiles);

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
  if (existsSync(legacyManifestPath)) rmSync(legacyManifestPath);

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
  const batonCodexCmdPath = userBatonCodexCommandPath();
  const batonGeminiCmdPath = userBatonGeminiCommandPath();
  const batonAgentCmdPath = userBatonAgentCommandPath();
  const skillsDir = userSkillsDir();

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

  const templateResult = readTemplateBodyWithOverride();
  const templateBody = templateResult.body;
  const wroteBatonCommand = writeBatonCommand(commandsDir, batonCmdPath, templateBody);
  const wroteDropCommand = writeDropCommand(commandsDir, dropCmdPath);
  const wroteBatonCodexCommand = writeBatonCodexCommand(commandsDir, batonCodexCmdPath);
  const wroteBatonGeminiCommand = writeBatonGeminiCommand(commandsDir, batonGeminiCmdPath);
  const wroteBatonAgentCommand = writeBatonAgentCommand(commandsDir, batonAgentCmdPath);

  writeInstallManifest(hadBatonEntriesBeforeInstall ? null : backupPath);

  return {
    postinstall: opts.postinstall ?? false,
    backupPath,
    wroteStatusline: statusResult.wrote,
    skippedStatuslineReason: statusResult.skipped,
    replacedStatusline: statusResult.replaced,
    wroteUserPromptSubmit: wroteUps,
    wrotePreCompact: wrotePc,
    wroteSessionStart: wroteSs,
    wroteBatonCommand,
    wroteDropCommand,
    wroteBatonCodexCommand,
    wroteBatonGeminiCommand,
    wroteBatonAgentCommand,
    settingsPath,
    batonCommandPath: batonCmdPath,
    dropCommandPath: dropCmdPath,
    batonCodexCommandPath: batonCodexCmdPath,
    batonGeminiCommandPath: batonGeminiCmdPath,
    batonAgentCommandPath: batonAgentCmdPath,
    migratedCommands,
    migratedSkills,
    templateSource: templateResult.source,
  };
}

function tick(wrote: boolean): string {
  return wrote ? color.green("✓") : color.dim("·");
}

export function printReport(r: InstallReport): void {
  // --postinstall: silent if nothing changed, one-liner if first install.
  if (r.postinstall) {
    const anyNew = r.wroteStatusline || r.wroteUserPromptSubmit || r.wrotePreCompact ||
      r.wroteSessionStart || r.wroteBatonCommand || r.wroteDropCommand ||
      r.wroteBatonCodexCommand || r.wroteBatonGeminiCommand || r.wroteBatonAgentCommand;
    if (!anyNew) return;
    process.stdout.write(
      color.green("✓") + ` baton v${VERSION} installed — restart Claude Code to activate.\n`,
    );
    return;
  }

  const lines: string[] = [];
  lines.push(color.cyan.bold(`baton v${VERSION}`) + " installed");
  lines.push("");

  if (r.skippedStatuslineReason) {
    lines.push(`  ${color.hex("#ff8800")("⚠")}  statusLine — ${color.dim(r.skippedStatuslineReason)}`);
  } else if (r.replacedStatusline) {
    lines.push(`  ${tick(true)}  statusLine ${color.dim(`(replaced "${r.replacedStatusline}"`)}`);
  } else {
    lines.push(`  ${tick(r.wroteStatusline)}  statusLine`);
  }
  lines.push(`  ${tick(r.wroteUserPromptSubmit)}  UserPromptSubmit hook`);
  lines.push(`  ${tick(r.wrotePreCompact)}  PreCompact hook`);
  lines.push(`  ${tick(r.wroteSessionStart)}  SessionStart hook`);
  const templateSuffix = r.templateSource !== "bundled" ? color.dim(` (template: ${r.templateSource})`) : "";
  lines.push(`  ${tick(r.wroteBatonCommand)}  /baton command${templateSuffix}`);
  lines.push(`  ${tick(r.wroteDropCommand)}  /drop command`);
  lines.push(`  ${tick(r.wroteBatonCodexCommand)}  /baton-codex command`);
  lines.push(`  ${tick(r.wroteBatonGeminiCommand)}  /baton-gemini command`);
  lines.push(`  ${tick(r.wroteBatonAgentCommand)}  /baton-agent command`);

  if (r.migratedCommands.length > 0 || r.migratedSkills.length > 0) {
    lines.push("");
    for (const p of r.migratedCommands) lines.push(`  ${color.dim("↳ migrated:")} ${color.dim(p)}`);
    for (const p of r.migratedSkills) lines.push(`  ${color.dim("↳ migrated:")} ${color.dim(p)}`);
  }

  lines.push("");
  if (r.backupPath) {
    lines.push(`  ${color.dim("settings backed up →")} ${color.dim(r.backupPath)}`);
    lines.push("");
  }
  lines.push(`  Restart Claude Code, then type ${color.cyan.bold("/baton")} to snapshot at any time.`);
  process.stdout.write(lines.join("\n") + "\n");
}

// --- check ---

export interface CheckReport {
  version: string;
  statusLine: { present: boolean; isCurrent: boolean; command: string | null };
  userPromptSubmit: boolean;
  preCompact: boolean;
  sessionStart: boolean;
  batonCommand: boolean;
  dropCommand: boolean;
  batonCodexCommand: boolean;
  batonGeminiCommand: boolean;
  batonAgentCommand: boolean;
  installedAt: string | null;
  backupPath: string | null;
  allPresent: boolean;
}

export function check(): CheckReport {
  const settings = existsSync(userSettingsPath()) ? loadSettings(userSettingsPath()) : {};

  const statusCmd = settings.statusLine?.command ?? null;

  function hasHook(event: string, cmd: string): boolean {
    for (const m of settings.hooks?.[event] ?? []) {
      for (const h of m.hooks ?? []) {
        if (h.command === cmd) return true;
      }
    }
    return false;
  }

  const statusPresent = !!statusCmd;
  const statusCurrent = statusCmd === STATUSLINE_CMD;
  const ups = hasHook("UserPromptSubmit", HOOK_UPS_CMD);
  const pc = hasHook("PreCompact", HOOK_PC_CMD);
  const ss = hasHook("SessionStart", HOOK_SS_CMD);
  const batonCmd = existsSync(userBatonCommandPath());
  const dropCmd = existsSync(userDropCommandPath());
  const batonCodexCmd = existsSync(userBatonCodexCommandPath());
  const batonGeminiCmd = existsSync(userBatonGeminiCommandPath());
  const batonAgentCmd = existsSync(userBatonAgentCommandPath());

  let installedAt: string | null = null;
  let backupPath: string | null = null;
  const manifestPath = existsSync(installManifestPath()) ? installManifestPath() : legacyInstallManifestPath();
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as InstallManifest;
      installedAt = manifest.installedAt ?? null;
      backupPath = manifest.settingsBackupPath ?? null;
    } catch { /* ignore */ }
  }

  const allPresent = statusPresent && statusCurrent && ups && pc && ss &&
    batonCmd && dropCmd && batonCodexCmd && batonGeminiCmd && batonAgentCmd;

  return {
    version: VERSION,
    statusLine: { present: statusPresent, isCurrent: statusCurrent, command: statusCmd },
    userPromptSubmit: ups,
    preCompact: pc,
    sessionStart: ss,
    batonCommand: batonCmd,
    dropCommand: dropCmd,
    batonCodexCommand: batonCodexCmd,
    batonGeminiCommand: batonGeminiCmd,
    batonAgentCommand: batonAgentCmd,
    installedAt,
    backupPath,
    allPresent,
  };
}

export function printCheckReport(r: CheckReport): void {
  const row = (label: string, ok: boolean, note = ""): string => {
    const icon = ok ? color.green("✓") : color.red("✗");
    const status = ok ? color.dim("installed") : color.red("missing");
    const suffix = note ? color.dim(` (${note})`) : "";
    return `  ${label.padEnd(20)} ${icon}  ${status}${suffix}`;
  };

  const lines: string[] = [];
  lines.push(color.cyan.bold(`baton v${r.version}`));
  lines.push("");
  lines.push(row("statusLine", r.statusLine.isCurrent,
    !r.statusLine.isCurrent && r.statusLine.present ? "present but stale — re-run install" : ""));
  lines.push(row("UserPromptSubmit", r.userPromptSubmit));
  lines.push(row("PreCompact", r.preCompact));
  lines.push(row("SessionStart", r.sessionStart));
  lines.push(row("/baton command", r.batonCommand));
  lines.push(row("/drop command", r.dropCommand));
  lines.push(row("/baton-codex command", r.batonCodexCommand));
  lines.push(row("/baton-gemini command", r.batonGeminiCommand));
  lines.push(row("/baton-agent command", r.batonAgentCommand));
  if (r.installedAt) {
    lines.push("");
    lines.push(`  ${color.dim("installed")} ${color.dim(r.installedAt.slice(0, 10))}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
}

// --- multi-host install/check/uninstall ---

export type HostName = "claude" | "codex" | "gemini";
export type HostSelection = HostName | "all";

export interface HostInstallSummary {
  host: HostName;
  dryRun: boolean;
  changed: boolean;
  details: string[];
}

export interface MultiHostInstallReport {
  hosts: HostInstallSummary[];
  claude?: InstallReport;
}

export interface HostCheckSummary {
  host: HostName;
  allPresent: boolean;
  details: Record<string, boolean | string | null>;
}

export interface MultiHostCheckReport {
  version: string;
  hosts: HostCheckSummary[];
  allPresent: boolean;
}

export interface HostUninstallSummary {
  host: HostName;
  changed: boolean;
  details: string[];
}

export interface MultiHostUninstallReport {
  hosts: HostUninstallSummary[];
  claude?: UninstallReport;
}

const MANAGED_START = "# >>> baton managed";
const MANAGED_END = "# <<< baton managed";
const CODEX_FEATURE_ADDED = "# baton-managed-added";
const CODEX_FEATURE_PREVIOUS_FALSE = "# baton-managed-previous=false";

function selectedHosts(host: HostSelection): HostName[] {
  return host === "all" ? ["claude", "codex", "gemini"] : [host];
}

function managedBlock(body: string): string {
  return `${MANAGED_START}\n${body.trim()}\n${MANAGED_END}\n`;
}

function stripManagedBlock(body: string): string {
  const re = new RegExp(`${escapeRegExp(MANAGED_START)}[\\s\\S]*?${escapeRegExp(MANAGED_END)}\\n?`, "g");
  return body.replace(re, "").replace(/\n{3,}/g, "\n\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeTextFile(path: string, body: string, dryRun: boolean): boolean {
  const changed = !existsSync(path) || readFileSync(path, "utf8") !== body;
  if (!dryRun && changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, "utf8");
  }
  return changed;
}

function featuresTableRange(lines: string[]): { start: number; end: number } | null {
  const start = lines.findIndex((line) => /^\s*\[features\]\s*(?:#.*)?$/.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function ensureCodexHooksFeature(config: string): string {
  const lines = config.split(/\r?\n/);
  const range = featuresTableRange(lines);
  if (!range) {
    const prefix = `[features]\ncodex_hooks = true ${CODEX_FEATURE_ADDED}\n`;
    return config.trim() ? `${prefix}\n${config.trimStart()}` : prefix;
  }

  for (let i = range.start + 1; i < range.end; i++) {
    const line = lines[i] ?? "";
    const match = line.match(/^(\s*codex_hooks\s*=\s*)(true|false)(.*)$/);
    if (!match) continue;
    if (match[2] === "true") return lines.join("\n");
    lines[i] = `${match[1]}true ${CODEX_FEATURE_PREVIOUS_FALSE}`;
    return lines.join("\n");
  }

  lines.splice(range.start + 1, 0, `codex_hooks = true ${CODEX_FEATURE_ADDED}`);
  return lines.join("\n");
}

function removeCodexHooksFeature(config: string): string {
  const lines = config.split(/\r?\n/);
  const next: string[] = [];
  for (const line of lines) {
    if (line.includes(CODEX_FEATURE_ADDED)) continue;
    if (line.includes(CODEX_FEATURE_PREVIOUS_FALSE)) {
      next.push(line.replace(/^(\s*codex_hooks\s*=\s*)true.*$/, "$1false"));
    } else {
      next.push(line);
    }
  }
  return next.join("\n").replace(/\n{3,}/g, "\n\n");
}

function codexHooksToml(): string {
  return [
    '[[hooks.SessionStart]]',
    'matcher = "resume|clear"',
    '[[hooks.SessionStart.hooks]]',
    'type = "command"',
    `command = ${JSON.stringify(HOOK_SS_CMD)}`,
    `timeout = ${BATON_HOOK_TIMEOUT_S}`,
    "",
    '[[hooks.UserPromptSubmit]]',
    '[[hooks.UserPromptSubmit.hooks]]',
    'type = "command"',
    `command = ${JSON.stringify(HOOK_UPS_CMD)}`,
    `timeout = ${BATON_HOOK_TIMEOUT_S}`,
  ].join("\n");
}

function installCodex(dryRun: boolean): HostInstallSummary {
  warnIfBunMissing();
  const details: string[] = [];
  const configPath = userCodexConfigPath();
  const priorConfig = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const strippedConfig = ensureCodexHooksFeature(stripManagedBlock(priorConfig)).trimEnd();
  const nextConfig = `${strippedConfig}${strippedConfig ? "\n\n" : ""}${managedBlock(codexHooksToml())}`;
  const configChanged = writeTextFile(configPath, nextConfig, dryRun);
  if (configChanged) details.push(`${dryRun ? "would update" : "updated"} ${configPath} (hook timeout: ${BATON_HOOK_TIMEOUT_S}s — override with BATON_HOOK_TIMEOUT_S)`);

  const template = readTemplateBodyWithOverride().body;
  const skillPath = userAgentsBatonSkillPath();
  const skillChanged = writeTextFile(skillPath, template, dryRun);
  if (skillChanged) details.push(`${dryRun ? "would write" : "wrote"} ${skillPath}`);

  if (!dryRun && (configChanged || skillChanged)) {
    mkdirSync(dirname(hostInstallManifestPath("codex")), { recursive: true });
    writeFileSync(
      hostInstallManifestPath("codex"),
      JSON.stringify({ installedAt: new Date().toISOString(), configPath, skillPath }, null, 2) + "\n",
      "utf8",
    );
  }

  return { host: "codex", dryRun, changed: configChanged || skillChanged, details };
}

function geminiCommandToml(description: string, prompt: string): string {
  return `description = ${JSON.stringify(description)}\nprompt = ${JSON.stringify(prompt)}\n`;
}

function geminiBatonPrompt(): string {
  return [
    "Run the baton workflow exactly as written below. Write the file to `.baton/BATON.md`, validate it once with `baton validate .baton/BATON.md`, report the result, and stop.",
    "",
    readTemplateBodyWithOverride().body,
  ].join("\n");
}

function geminiDropPrompt(): string {
  return [
    "Run `baton drop` using the shell tool. Relay the command output, then tell the user to start a fresh session if desired. Do not do any other work.",
  ].join("\n");
}

function geminiSidecarPrompt(host: HostName): string {
  return [
    `Run \`baton sidecar ${host} --mode review\` unless the user's command text names \`review\`, \`critique\`, or \`alternative\`; in that case use the named mode.`,
    "Surface any non-zero exit clearly. Do not act on the sidecar's suggestions without explicit user direction.",
  ].join("\n");
}

function geminiHooksJson(): string {
  return JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume|clear",
          hooks: [
            {
              name: "baton-session-start",
              type: "command",
              command: HOOK_SS_CMD,
            },
          ],
        },
      ],
      // BeforeAgent: fires after user prompt, before planning — Gemini's equivalent of Claude Code's UserPromptSubmit
      BeforeAgent: [
        {
          matcher: "*",
          hooks: [
            {
              name: "baton-before-agent",
              type: "command",
              command: HOOK_UPS_CMD,
            },
          ],
        },
      ],
    },
  }, null, 2) + "\n";
}

function installGemini(dryRun: boolean): HostInstallSummary {
  warnIfBunMissing();
  const details: string[] = [];
  const extDir = userGeminiBatonExtensionDir();
  const manifestChanged = writeTextFile(
    join(extDir, "gemini-extension.json"),
    JSON.stringify({
      name: "baton",
      version: VERSION,
      description: "Session baton snapshot and resume workflow for Gemini CLI.",
      contextFileName: "GEMINI.md",
    }, null, 2) + "\n",
    dryRun,
  );
  if (manifestChanged) details.push(`${dryRun ? "would write" : "wrote"} ${join(extDir, "gemini-extension.json")}`);

  const contextChanged = writeTextFile(
    join(extDir, "GEMINI.md"),
    [
      "# Baton extension",
      "",
      "Use baton when the user asks to save progress, snapshot, hand off, resume, or avoid context loss.",
      "The canonical project file is `.baton/BATON.md`; legacy `.claude/baton/BATON.md` files remain readable.",
      "",
    ].join("\n"),
    dryRun,
  );
  if (contextChanged) details.push(`${dryRun ? "would write" : "wrote"} ${join(extDir, "GEMINI.md")}`);

  const commandBodies: Array<[string, string]> = [
    ["baton.toml", geminiCommandToml("Write and validate .baton/BATON.md", geminiBatonPrompt())],
    ["drop.toml", geminiCommandToml("Archive the pending BATON.md", geminiDropPrompt())],
    // baton-codex.toml: asking Codex from inside Gemini is sensible.
    // baton-gemini.toml omitted: Gemini spawning a second Gemini instance for a "second opinion" is self-referential.
    ["baton-codex.toml", geminiCommandToml("Run Codex as a read-only baton sidecar", geminiSidecarPrompt("codex"))],
  ];
  const commandWrites = commandBodies.map(([file, body]) => {
    const path = join(extDir, "commands", file);
    const changed = writeTextFile(path, body, dryRun);
    if (changed) details.push(`${dryRun ? "would write" : "wrote"} ${path}`);
    return changed;
  });

  // Remove stale baton-gemini.toml left by older installs.
  const staleGeminiCmd = join(extDir, "commands", "baton-gemini.toml");
  const staleGeminiExists = existsSync(staleGeminiCmd);
  if (staleGeminiExists && !dryRun) unlinkSync(staleGeminiCmd);
  if (staleGeminiExists) details.push(`${dryRun ? "would remove stale" : "removed stale"} ${staleGeminiCmd}`);

  const hooksPath = join(extDir, "hooks", "hooks.json");
  const hooksChanged = writeTextFile(hooksPath, geminiHooksJson(), dryRun);
  if (hooksChanged) details.push(`${dryRun ? "would write" : "wrote"} ${hooksPath}`);

  const changed = manifestChanged || contextChanged || commandWrites.some(Boolean) || hooksChanged || staleGeminiExists;
  if (!dryRun && changed) {
    mkdirSync(dirname(hostInstallManifestPath("gemini")), { recursive: true });
    writeFileSync(
      hostInstallManifestPath("gemini"),
      JSON.stringify({ installedAt: new Date().toISOString(), extensionDir: extDir, hooksPath }, null, 2) + "\n",
      "utf8",
    );
  }

  return { host: "gemini", dryRun, changed, details };
}

function dryRunClaude(): HostInstallSummary {
  const r = check();
  const details: string[] = [];
  if (!r.statusLine.isCurrent) details.push(`would update ${userSettingsPath()} statusLine`);
  if (!r.userPromptSubmit || !r.preCompact || !r.sessionStart) details.push(`would update ${userSettingsPath()} hooks`);
  if (!r.batonCommand || !r.dropCommand || !r.batonCodexCommand || !r.batonGeminiCommand) {
    details.push(`would write Claude slash commands under ${userCommandsDir()}`);
  }
  return { host: "claude", dryRun: true, changed: details.length > 0, details };
}

export function installHosts(opts: InstallOptions & { host?: HostSelection; dryRun?: boolean } = {}): MultiHostInstallReport {
  const host = opts.host ?? "claude";
  const dryRun = opts.dryRun ?? false;
  const report: MultiHostInstallReport = { hosts: [] };
  for (const h of selectedHosts(host)) {
    if (h === "claude") {
      if (dryRun) {
        report.hosts.push(dryRunClaude());
      } else {
        const claude = install(opts);
        report.claude = claude;
        report.hosts.push({
          host: "claude",
          dryRun: false,
          changed: claude.wroteStatusline || claude.wroteUserPromptSubmit || claude.wrotePreCompact ||
            claude.wroteSessionStart || claude.wroteBatonCommand || claude.wroteDropCommand ||
            claude.wroteBatonCodexCommand || claude.wroteBatonGeminiCommand,
          details: ["Claude Code hooks, statusline, and slash commands checked"],
        });
      }
    } else if (h === "codex") {
      report.hosts.push(installCodex(dryRun));
    } else {
      report.hosts.push(installGemini(dryRun));
    }
  }
  return report;
}

function codexCheck(): HostCheckSummary {
  const configPath = userCodexConfigPath();
  const config = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const codexHooksFeature = /^\s*codex_hooks\s*=\s*true\b/m.test(config);
  const hooks = config.includes(MANAGED_START) &&
    config.includes("hook session-start") &&
    config.includes("hook user-prompt-submit");
  const skill = existsSync(userAgentsBatonSkillPath());
  return {
    host: "codex",
    allPresent: codexHooksFeature && hooks && skill,
    details: { configPath, codexHooksFeature, hooks, skillPath: userAgentsBatonSkillPath(), skill },
  };
}

function geminiCheck(): HostCheckSummary {
  const extDir = userGeminiBatonExtensionDir();
  const manifest = existsSync(join(extDir, "gemini-extension.json"));
  const batonCommand = existsSync(join(extDir, "commands", "baton.toml"));
  const hooksJson = existsSync(join(extDir, "hooks", "hooks.json"));
  const staleGeminiCmd = existsSync(join(extDir, "commands", "baton-gemini.toml"));
  const settingsPath = userGeminiSettingsPath();
  const settings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
  const legacySettingsHooks = settings.includes(HOOK_SS_CMD) && settings.includes(HOOK_UPS_CMD);
  return {
    host: "gemini",
    allPresent: manifest && batonCommand && hooksJson && !staleGeminiCmd,
    details: { extensionDir: extDir, manifest, batonCommand, hooksJson, staleGeminiCmd, settingsPath, legacySettingsHooks },
  };
}

function claudeCheckSummary(): HostCheckSummary {
  const r = check();
  return {
    host: "claude",
    allPresent: r.allPresent,
    details: {
      settingsPath: userSettingsPath(),
      statusLine: r.statusLine.isCurrent,
      userPromptSubmit: r.userPromptSubmit,
      preCompact: r.preCompact,
      sessionStart: r.sessionStart,
      batonCommand: r.batonCommand,
      dropCommand: r.dropCommand,
      batonCodexCommand: r.batonCodexCommand,
      batonGeminiCommand: r.batonGeminiCommand,
    },
  };
}

export function checkHosts(host: HostSelection = "claude"): MultiHostCheckReport {
  const hosts = selectedHosts(host).map((h) => {
    if (h === "claude") return claudeCheckSummary();
    if (h === "codex") return codexCheck();
    return geminiCheck();
  });
  return {
    version: VERSION,
    hosts,
    allPresent: hosts.every((h) => h.allPresent),
  };
}

function uninstallCodex(): HostUninstallSummary {
  const details: string[] = [];
  const configPath = userCodexConfigPath();
  if (existsSync(configPath)) {
    const prior = readFileSync(configPath, "utf8");
    const next = removeCodexHooksFeature(stripManagedBlock(prior));
    if (next !== prior) {
      writeFileSync(configPath, next, "utf8");
      details.push(`updated ${configPath}`);
    }
  }
  const skillDir = userAgentsBatonSkillDir();
  const skillPath = userAgentsBatonSkillPath();
  // Ownership check works because installCodex writes src/baton/template.md, which starts with ---\nname: baton\n
  if (existsSync(skillPath) && startsWithFrontmatter(skillPath, "baton")) {
    rmSync(skillDir, { recursive: true, force: true });
    details.push(`removed ${skillDir}`);
  }
  const manifest = hostInstallManifestPath("codex");
  if (existsSync(manifest)) {
    rmSync(manifest);
    details.push(`removed ${manifest}`);
  }
  return { host: "codex", changed: details.length > 0, details };
}

function uninstallGemini(): HostUninstallSummary {
  // Baton uses the Gemini extension mechanism (~/.gemini/extensions/baton/), not settings.json.
  const details: string[] = [];
  const extDir = userGeminiBatonExtensionDir();
  const manifest = join(extDir, "gemini-extension.json");
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
      if (parsed.name === "baton") {
        rmSync(extDir, { recursive: true, force: true });
        details.push(`removed ${extDir}`);
      }
    } catch { /* leave unrecognized extension alone */ }
  }
  const installManifest = hostInstallManifestPath("gemini");
  if (existsSync(installManifest)) {
    rmSync(installManifest);
    details.push(`removed ${installManifest}`);
  }
  return { host: "gemini", changed: details.length > 0, details };
}

export function uninstallHosts(host: HostSelection = "claude"): MultiHostUninstallReport {
  const report: MultiHostUninstallReport = { hosts: [] };
  for (const h of selectedHosts(host)) {
    if (h === "claude") {
      const claude = uninstall();
      report.claude = claude;
      report.hosts.push({
        host: "claude",
        changed: claude.restoredSettingsFrom !== null || claude.fallbackSurgical || claude.removedFiles.length > 0,
        details: ["Claude Code settings and slash commands checked"],
      });
    } else if (h === "codex") {
      report.hosts.push(uninstallCodex());
    } else {
      report.hosts.push(uninstallGemini());
    }
  }
  return report;
}

export function printMultiHostInstallReport(r: MultiHostInstallReport): void {
  for (const host of r.hosts) {
    const prefix = host.dryRun ? "baton install dry-run" : "baton install";
    process.stdout.write(`${prefix} [${host.host}] ${host.changed ? "changes" : "already current"}\n`);
    for (const detail of host.details) process.stdout.write(`  ${detail}\n`);
  }
}

export function printMultiHostCheckReport(r: MultiHostCheckReport): void {
  process.stdout.write(`baton v${r.version}\n\n`);
  for (const host of r.hosts) {
    process.stdout.write(`  ${host.host.padEnd(8)} ${host.allPresent ? "installed" : "missing"}\n`);
    for (const [key, value] of Object.entries(host.details)) {
      process.stdout.write(`    ${key}: ${String(value)}\n`);
    }
  }
}

export function printMultiHostUninstallReport(r: MultiHostUninstallReport): void {
  for (const host of r.hosts) {
    process.stdout.write(`baton uninstall [${host.host}] ${host.changed ? "changed" : "no changes"}\n`);
    for (const detail of host.details) process.stdout.write(`  ${detail}\n`);
  }
}
