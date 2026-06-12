import { expect, test, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TEST_HOME } from "./helpers/test-home.ts";

const actualConfig = await import("../src/config.ts");
const TEST_CLI_PATH = "/some/baton/src/cli.ts";

mock.module("../src/config.ts", () => ({
  ...actualConfig,
  cliPath: () => TEST_CLI_PATH,
  buildCommand: (sub: string) => `bun run "${TEST_CLI_PATH}" ${sub}`,
}));

const { install, uninstall } = await import("../src/install/settings-patch.ts");
const { installManifestPath, legacyInstallManifestPath } = await import("../src/config.ts");

const CLAUDE_DIR = join(TEST_HOME, ".claude");
const SETTINGS_PATH = join(CLAUDE_DIR, "settings.json");
const COMMANDS_DIR = join(CLAUDE_DIR, "commands");
const SKILLS_DIR = join(CLAUDE_DIR, "skills");
const BATON_CMD_PATH = join(COMMANDS_DIR, "baton.md");
const DROP_CMD_PATH = join(COMMANDS_DIR, "drop.md");
const BATON_CODEX_CMD_PATH = join(COMMANDS_DIR, "baton-codex.md");
const BATON_GEMINI_CMD_PATH = join(COMMANDS_DIR, "baton-gemini.md");
const BATON_AGENT_CMD_PATH = join(COMMANDS_DIR, "baton-agent.md");
const BATON_SKILL_DIR = join(SKILLS_DIR, "baton");
const BATON_SKILL_PATH = join(BATON_SKILL_DIR, "SKILL.md");

beforeEach(() => {
  rmSync(CLAUDE_DIR, { recursive: true, force: true });
  rmSync(join(TEST_HOME, ".baton"), { recursive: true, force: true });
});

afterEach(() => {
  rmSync(CLAUDE_DIR, { recursive: true, force: true });
  rmSync(join(TEST_HOME, ".baton"), { recursive: true, force: true });
});

test("reinstall-then-uninstall restores the ORIGINAL pre-baton settings, not a baton-polluted second backup", () => {
  // Seed a pristine, user-owned settings.json that has NO baton entries.
  mkdirSync(CLAUDE_DIR, { recursive: true });
  const originalSettings = {
    statusLine: { type: "command", command: "ccstatusline" },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "echo user-hook" }] }],
    },
  };
  writeFileSync(SETTINGS_PATH, JSON.stringify(originalSettings, null, 2), "utf8");

  // First install. Manifest captures the pristine settings backup.
  const first = install();
  expect(first.backupPath).not.toBeNull();
  const firstManifest = JSON.parse(readFileSync(installManifestPath(), "utf8"));
  expect(firstManifest.settingsBackupPath).toBe(first.backupPath);

  // Confirm the settings now carry baton hooks/statusline.
  const afterFirst = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  expect(afterFirst.statusLine.command).toContain("statusline");
  expect(afterFirst.hooks.UserPromptSubmit).toBeDefined();

  // Second install. Backup file now reflects baton-polluted state. Manifest
  // must still point at the FIRST backup, or uninstall will silently re-install.
  const second = install();
  const secondManifest = JSON.parse(readFileSync(installManifestPath(), "utf8"));
  expect(secondManifest.settingsBackupPath).toBe(first.backupPath);
  expect(secondManifest.settingsBackupPath).not.toBe(second.backupPath);

  // Uninstall. Settings must match the ORIGINAL pristine state.
  const report = uninstall();
  expect(report.restoredSettingsFrom).toBe(first.backupPath);
  const restored = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  expect(restored.statusLine.command).toBe("ccstatusline");
  expect(restored.hooks.Stop).toBeDefined();
  expect(restored.hooks.UserPromptSubmit).toBeUndefined();
  expect(restored.hooks.PreCompact).toBeUndefined();
  expect(restored.hooks.SessionStart).toBeUndefined();
});

test("uninstall reads a legacy Claude install manifest", () => {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  const originalSettings = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-hook" }] }] } };
  writeFileSync(SETTINGS_PATH, JSON.stringify(originalSettings, null, 2), "utf8");
  const backupPath = `${SETTINGS_PATH}.legacy-backup`;
  writeFileSync(backupPath, JSON.stringify(originalSettings, null, 2), "utf8");
  mkdirSync(join(CLAUDE_DIR, "baton"), { recursive: true });
  writeFileSync(
    legacyInstallManifestPath(),
    JSON.stringify({ installedAt: "2026-01-01T00:00:00.000Z", settingsBackupPath: backupPath }),
    "utf8",
  );
  install();
  rmSync(installManifestPath(), { force: true });

  const report = uninstall();

  expect(report.restoredSettingsFrom).toBe(backupPath);
  expect(existsSync(legacyInstallManifestPath())).toBe(false);
});

test("uninstall skips a user-modified baton.md and surfaces it in the report", () => {
  install();
  expect(existsSync(BATON_CMD_PATH)).toBe(true);

  // User rewrites baton.md entirely (different frontmatter name).
  writeFileSync(
    BATON_CMD_PATH,
    "---\nname: my-custom-baton\ndescription: user override\n---\n\nHello\n",
    "utf8",
  );

  const report = uninstall();

  expect(existsSync(BATON_CMD_PATH)).toBe(true);
  const skipped = report.skippedFiles.find((s) => s.path === BATON_CMD_PATH);
  expect(skipped).toBeDefined();
  expect(skipped!.reason).toContain("user-modified");
  expect(report.removedFiles).not.toContain(BATON_CMD_PATH);

  // The untouched drop.md and SKILL.md should still have been removed.
  expect(existsSync(DROP_CMD_PATH)).toBe(false);
  expect(report.removedFiles).toContain(DROP_CMD_PATH);
});

test("uninstall skips a user-modified drop.md and surfaces it", () => {
  install();
  expect(existsSync(DROP_CMD_PATH)).toBe(true);

  writeFileSync(DROP_CMD_PATH, "not a baton file at all\n", "utf8");

  const report = uninstall();

  expect(existsSync(DROP_CMD_PATH)).toBe(true);
  const skipped = report.skippedFiles.find((s) => s.path === DROP_CMD_PATH);
  expect(skipped).toBeDefined();
  expect(skipped!.reason).toContain("user-modified");
});

test("uninstall refuses to recursively delete skills/baton/ when it contains unexpected files", () => {
  install();
  // Simulate a leftover skill from a pre-cleanup baton install where the user
  // also dropped their own file in the directory.
  mkdirSync(BATON_SKILL_DIR, { recursive: true });
  writeFileSync(BATON_SKILL_PATH, "---\nname: baton\ndescription: stale\n---\n", "utf8");
  const extra = join(BATON_SKILL_DIR, "user-notes.md");
  writeFileSync(extra, "my own notes, do not delete\n", "utf8");

  const report = uninstall();

  // Directory and both files must survive.
  expect(existsSync(BATON_SKILL_DIR)).toBe(true);
  expect(existsSync(BATON_SKILL_PATH)).toBe(true);
  expect(existsSync(extra)).toBe(true);

  const skipped = report.skippedFiles.find((s) => s.path === BATON_SKILL_DIR);
  expect(skipped).toBeDefined();
  expect(skipped!.reason).toContain("unexpected files");
  expect(skipped!.reason).toContain("user-notes.md");
  expect(report.removedFiles).not.toContain(BATON_SKILL_PATH);
  expect(report.removedFiles).not.toContain(BATON_SKILL_DIR);
});

test("uninstall refuses to delete skills/baton/ when SKILL.md has been replaced by the user", () => {
  install();
  // Simulate a leftover skills/baton/SKILL.md whose frontmatter the user has
  // since rewritten — uninstall must not nuke it.
  mkdirSync(BATON_SKILL_DIR, { recursive: true });
  writeFileSync(
    BATON_SKILL_PATH,
    "---\nname: not-baton\ndescription: overwritten\n---\n",
    "utf8",
  );

  const report = uninstall();

  expect(existsSync(BATON_SKILL_DIR)).toBe(true);
  expect(existsSync(BATON_SKILL_PATH)).toBe(true);

  const skippedDir = report.skippedFiles.find(
    (s) => s.path === BATON_SKILL_DIR && s.reason.includes("refusing recursive delete"),
  );
  expect(skippedDir).toBeDefined();
  const skippedFile = report.skippedFiles.find(
    (s) => s.path === BATON_SKILL_PATH && s.reason.includes("user-modified"),
  );
  expect(skippedFile).toBeDefined();
});

test("clean uninstall after a single install removes every baton artifact, including a stale skill leftover", () => {
  install();
  expect(existsSync(BATON_CMD_PATH)).toBe(true);
  expect(existsSync(DROP_CMD_PATH)).toBe(true);
  expect(existsSync(BATON_CODEX_CMD_PATH)).toBe(true);
  expect(existsSync(BATON_GEMINI_CMD_PATH)).toBe(true);
  expect(existsSync(BATON_AGENT_CMD_PATH)).toBe(true);
  // Simulate a leftover skill from a pre-cleanup install. The current installer
  // does not write this file, but uninstall must still clean it up if present.
  mkdirSync(BATON_SKILL_DIR, { recursive: true });
  writeFileSync(BATON_SKILL_PATH, "---\nname: baton\ndescription: stale\n---\n", "utf8");

  const report = uninstall();

  expect(existsSync(BATON_CMD_PATH)).toBe(false);
  expect(existsSync(DROP_CMD_PATH)).toBe(false);
  expect(existsSync(BATON_CODEX_CMD_PATH)).toBe(false);
  expect(existsSync(BATON_GEMINI_CMD_PATH)).toBe(false);
  expect(existsSync(BATON_AGENT_CMD_PATH)).toBe(false);
  expect(existsSync(BATON_SKILL_PATH)).toBe(false);
  expect(existsSync(BATON_SKILL_DIR)).toBe(false);
  expect(existsSync(installManifestPath())).toBe(false);
  expect(report.removedFiles).toContain(BATON_CMD_PATH);
  expect(report.removedFiles).toContain(DROP_CMD_PATH);
  expect(report.removedFiles).toContain(BATON_CODEX_CMD_PATH);
  expect(report.removedFiles).toContain(BATON_GEMINI_CMD_PATH);
  expect(report.removedFiles).toContain(BATON_AGENT_CMD_PATH);
  expect(report.removedFiles).toContain(BATON_SKILL_PATH);
  // Nothing should be flagged as user-modified.
  const preserved = report.skippedFiles.filter((s) => s.reason !== "not found");
  expect(preserved).toHaveLength(0);
});

test("uninstall skips a user-modified baton-codex.md and surfaces it", () => {
  install();
  expect(existsSync(BATON_CODEX_CMD_PATH)).toBe(true);

  writeFileSync(
    BATON_CODEX_CMD_PATH,
    "---\nname: my-custom-codex\ndescription: user override\n---\n\nHello\n",
    "utf8",
  );

  const report = uninstall();

  expect(existsSync(BATON_CODEX_CMD_PATH)).toBe(true);
  const skipped = report.skippedFiles.find((s) => s.path === BATON_CODEX_CMD_PATH);
  expect(skipped).toBeDefined();
  expect(skipped!.reason).toContain("user-modified");
  expect(report.removedFiles).not.toContain(BATON_CODEX_CMD_PATH);
});

test("uninstall skips a user-modified baton-gemini.md and surfaces it", () => {
  install();
  expect(existsSync(BATON_GEMINI_CMD_PATH)).toBe(true);

  writeFileSync(
    BATON_GEMINI_CMD_PATH,
    "---\nname: my-custom-gemini\ndescription: user override\n---\n\nHello\n",
    "utf8",
  );

  const report = uninstall();

  expect(existsSync(BATON_GEMINI_CMD_PATH)).toBe(true);
  const skipped = report.skippedFiles.find((s) => s.path === BATON_GEMINI_CMD_PATH);
  expect(skipped).toBeDefined();
  expect(skipped!.reason).toContain("user-modified");
  expect(report.removedFiles).not.toContain(BATON_GEMINI_CMD_PATH);
});

test("uninstall skips a user-modified baton-agent.md and surfaces it", () => {
  install();
  expect(existsSync(BATON_AGENT_CMD_PATH)).toBe(true);

  writeFileSync(
    BATON_AGENT_CMD_PATH,
    "---\nname: my-custom-agent\ndescription: user override\n---\n\nHello\n",
    "utf8",
  );

  const report = uninstall();

  expect(existsSync(BATON_AGENT_CMD_PATH)).toBe(true);
  const skipped = report.skippedFiles.find((s) => s.path === BATON_AGENT_CMD_PATH);
  expect(skipped).toBeDefined();
  expect(skipped!.reason).toContain("user-modified");
  expect(report.removedFiles).not.toContain(BATON_AGENT_CMD_PATH);
});

test("uninstall with no prior manifest falls back to surgical settings edit without touching unrelated hooks", () => {
  // Seed settings with a mix of user hooks and baton hooks, but no manifest.
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo user-hook" }] }],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: 'bun run "/some/ccbaton/src/cli.ts" hook user-prompt-submit' }] },
        ],
      },
    }),
    "utf8",
  );

  const report = uninstall();

  expect(report.restoredSettingsFrom).toBeNull();
  expect(report.fallbackSurgical).toBe(true);

  const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo user-hook");
  expect(settings.hooks.UserPromptSubmit).toBeUndefined();
});

test("install manifest is preserved across many reinstalls, always pointing at the first backup", () => {
  // Seed pristine state.
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify({ foo: "bar" }, null, 2), "utf8");

  const first = install();
  // Run a handful of reinstalls to ensure the manifest never gets clobbered.
  for (let i = 0; i < 3; i++) {
    install();
  }
  const manifest = JSON.parse(readFileSync(installManifestPath(), "utf8"));
  expect(manifest.settingsBackupPath).toBe(first.backupPath);

  // And the restored settings must be the pristine original.
  uninstall();
  const restored = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  expect(restored).toEqual({ foo: "bar" });
});

test("legacy baton install upgrades to a surgical uninstall baseline instead of recording a polluted backup", () => {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({
      statusLine: { type: "command", command: 'bun run "/some/ccbaton/src/cli.ts" statusline' },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo user-hook" }] }],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: 'bun run "/some/ccbaton/src/cli.ts" hook user-prompt-submit' }] },
        ],
      },
      theme: "user-setting",
    }, null, 2),
    "utf8",
  );

  const installReport = install();
  expect(installReport.backupPath).not.toBeNull();

  const manifest = JSON.parse(readFileSync(installManifestPath(), "utf8"));
  expect(manifest.settingsBackupPath).toBeNull();

  const uninstallReport = uninstall();
  expect(uninstallReport.restoredSettingsFrom).toBeNull();
  expect(uninstallReport.fallbackSurgical).toBe(true);

  const restored = JSON.parse(readFileSync(SETTINGS_PATH, "utf8"));
  expect(restored.statusLine).toBeUndefined();
  expect(restored.hooks.Stop[0].hooks[0].command).toBe("echo user-hook");
  expect(restored.hooks.UserPromptSubmit).toBeUndefined();
  expect(restored.theme).toBe("user-setting");
});

test("uninstall reports extras by name when skills/baton/ has multiple unexpected files", () => {
  install();
  // Simulate a leftover skill dir with extras; uninstall must list them all.
  mkdirSync(BATON_SKILL_DIR, { recursive: true });
  writeFileSync(BATON_SKILL_PATH, "---\nname: baton\ndescription: stale\n---\n", "utf8");
  writeFileSync(join(BATON_SKILL_DIR, "a.md"), "a", "utf8");
  writeFileSync(join(BATON_SKILL_DIR, "b.txt"), "b", "utf8");

  const report = uninstall();

  const skipped = report.skippedFiles.find((s) => s.path === BATON_SKILL_DIR);
  expect(skipped).toBeDefined();
  expect(skipped!.reason).toContain("a.md");
  expect(skipped!.reason).toContain("b.txt");

  // Directory contents must be untouched.
  const entries = readdirSync(BATON_SKILL_DIR).sort();
  expect(entries).toEqual(["SKILL.md", "a.md", "b.txt"]);
});
