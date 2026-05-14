import { expect, test, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_HOME } from "./helpers/test-home.ts";

const actualConfig = await import("../src/config.ts");
const TEST_CLI_PATH = "/some/baton/src/cli.ts";

mock.module("../src/config.ts", () => ({
  ...actualConfig,
  cliPath: () => TEST_CLI_PATH,
  buildCommand: (sub: string) => `bun run "${TEST_CLI_PATH}" ${sub}`,
}));

const { install } = await import("../src/install/settings-patch.ts");

beforeEach(() => {
  rmSync(join(TEST_HOME, ".claude"), { recursive: true, force: true });
});

afterEach(() => {
  rmSync(join(TEST_HOME, ".claude"), { recursive: true, force: true });
});

test("install writes SessionStart hook entry and reports wroteSessionStart on clean install", () => {
  const report = install();

  expect(report.wroteSessionStart).toBe(true);

  const settings = JSON.parse(readFileSync(join(TEST_HOME, ".claude", "settings.json"), "utf8"));
  expect(settings.hooks.SessionStart).toHaveLength(1);
  expect(settings.hooks.SessionStart[0].hooks[0].command).toContain("hook session-start");
});

test("install writes settings under TEST_HOME with a literal space, not URL encoding", () => {
  const report = install();

  expect(report.settingsPath).toContain("baton test shared home");
  expect(report.settingsPath).not.toContain("%20");

  const rawSettings = readFileSync(join(TEST_HOME, ".claude", "settings.json"), "utf8");
  expect(rawSettings).not.toContain("%20");
});

test("install writes the /drop slash command with the CLI path baked in", () => {
  const report = install();

  expect(report.wroteDropCommand).toBe(true);

  const body = readFileSync(report.dropCommandPath, "utf8");
  expect(body).toContain("name: drop");
  expect(body).toContain("Type /clear to start a clean session");
  expect(body).toMatch(/bun run "[^"]+cli\.ts" drop/);
});

test("install writes the /baton-codex slash command pointing at sidecar codex", () => {
  const report = install();

  expect(report.wroteBatonCodexCommand).toBe(true);
  expect(report.batonCodexCommandPath).toMatch(/baton-codex\.md$/);

  const body = readFileSync(report.batonCodexCommandPath, "utf8");
  expect(body).toContain("name: baton-codex");
  expect(body).toContain("same-session sidecar");
  expect(body).toContain("It is not a handoff command");
  expect(body).toContain("AskUserQuestion");
  expect(body).toContain("multiSelect");
  expect(body).toContain("If the user's message already names a mode");
  expect(body).toContain("do not repeat it");
  expect(body).not.toContain("relay whatever it printed verbatim");
  expect(body).toMatch(/bun run "[^"]+cli\.ts" sidecar codex --mode/);
});

test("install writes the /baton-gemini slash command pointing at sidecar gemini", () => {
  const report = install();

  expect(report.wroteBatonGeminiCommand).toBe(true);
  expect(report.batonGeminiCommandPath).toMatch(/baton-gemini\.md$/);

  const body = readFileSync(report.batonGeminiCommandPath, "utf8");
  expect(body).toContain("name: baton-gemini");
  expect(body).toContain("same-session sidecar");
  expect(body).toContain("It is not a handoff command");
  expect(body).toContain("AskUserQuestion");
  expect(body).toContain("multiSelect");
  expect(body).toContain("If the user's message already names a mode");
  expect(body).toContain("do not repeat it");
  expect(body).not.toContain("relay whatever it printed verbatim");
  expect(body).toMatch(/bun run "[^"]+cli\.ts" sidecar gemini --mode/);
});

test("source-mode hook commands are self-locating bun invocations", () => {
  install();

  const settings = JSON.parse(readFileSync(join(TEST_HOME, ".claude", "settings.json"), "utf8"));

  expect(settings.statusLine.command).toMatch(/bun run "[^"]+cli\.ts" statusline/);
  expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/bun run "[^"]+cli\.ts" hook user-prompt-submit/);
});

test("install migrates old handoff/handoff-discard commands and reports them", () => {
  const commandsDir = join(TEST_HOME, ".claude", "commands");
  mkdirSync(commandsDir, { recursive: true });

  const oldHandoff = join(commandsDir, "handoff.md");
  const oldDiscard = join(commandsDir, "handoff-discard.md");
  writeFileSync(oldHandoff, "---\nname: handoff\ndescription: old\n---\n");
  writeFileSync(oldDiscard, "---\nname: handoff-discard\ndescription: old\n---\n");

  const report = install();

  expect(existsSync(oldHandoff)).toBe(false);
  expect(existsSync(oldDiscard)).toBe(false);
  expect(existsSync(report.batonCommandPath)).toBe(true);
  expect(existsSync(report.dropCommandPath)).toBe(true);
  expect(report.migratedCommands).toContain(oldHandoff);
  expect(report.migratedCommands).toContain(oldDiscard);
});

test("install removes hook events left empty after pruning stale baton hooks", () => {
  const claudeDir = join(TEST_HOME, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "baton hook session-start --old" }] }],
      },
    }),
  );

  install();

  const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
  expect(settings.hooks.Stop).toBeUndefined();
});

test("install prunes stale compiled hook commands from prior npx cache paths", () => {
  const claudeDir = join(TEST_HOME, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              {
                type: "command",
                command: 'node "C:/Users/me/AppData/Local/npm-cache/_npx/old/node_modules/ccbaton/dist/cli.js" hook user-prompt-submit',
              },
            ],
          },
        ],
      },
    }),
  );

  install();

  const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
  expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
  expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toMatch(/bun run "[^"]+cli\.ts" hook user-prompt-submit/);
});

test("install rewrites stale compiled statusline commands", () => {
  const claudeDir = join(TEST_HOME, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({
      statusLine: {
        type: "command",
        command: 'node "C:/Users/me/AppData/Local/npm-cache/_npx/old/node_modules/ccbaton/dist/cli.js" statusline',
      },
    }),
  );

  install();

  const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
  expect(settings.statusLine.command).toMatch(/bun run "[^"]+cli\.ts" statusline/);
});

test("install does not prune unrelated user hooks that mention baton", () => {
  const claudeDir = join(TEST_HOME, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "echo baton statusline" }] }],
      },
    }),
  );

  install();

  const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
  expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo baton statusline");
});

test("install uses user-level baton-template.md if present and valid", () => {
  const claudeDir = join(TEST_HOME, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const overridePath = join(claudeDir, "baton-template.md");
  const overrideContent = `---\nname: baton\ndescription: Custom baton\n---\n# Override Template`;
  writeFileSync(overridePath, overrideContent, "utf8");

  const report = install();
  expect(report.templateSource).toBe("override");

  const commandContent = readFileSync(report.batonCommandPath, "utf8");
  expect(commandContent).toBe(overrideContent);
});

test("install does not write a separate baton skill file (the command's frontmatter auto-registers as a skill)", () => {
  install();

  const skillPath = join(TEST_HOME, ".claude", "skills", "baton", "SKILL.md");
  expect(existsSync(skillPath)).toBe(false);
});

test("install migrates an old baton skill dir on upgrade", () => {
  const skillDir = join(TEST_HOME, ".claude", "skills", "baton");
  const skillPath = join(skillDir, "SKILL.md");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillPath, "---\nname: baton\ndescription: old skill\n---\n", "utf8");

  const report = install();

  expect(existsSync(skillPath)).toBe(false);
  expect(existsSync(skillDir)).toBe(false);
  expect(report.migratedSkills).toContain(skillDir);
});

test("install leaves a user-modified baton skill dir alone", () => {
  const skillDir = join(TEST_HOME, ".claude", "skills", "baton");
  const skillPath = join(skillDir, "SKILL.md");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillPath, "---\nname: not-baton\ndescription: user override\n---\n", "utf8");

  const report = install();

  expect(existsSync(skillPath)).toBe(true);
  expect(report.migratedSkills).not.toContain(skillDir);
});

test("install leaves baton skill dir alone when it has unexpected files", () => {
  const skillDir = join(TEST_HOME, ".claude", "skills", "baton");
  const skillPath = join(skillDir, "SKILL.md");
  const extra = join(skillDir, "user-notes.md");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillPath, "---\nname: baton\ndescription: old skill\n---\n", "utf8");
  writeFileSync(extra, "user notes\n", "utf8");

  const report = install();

  expect(existsSync(skillPath)).toBe(true);
  expect(existsSync(extra)).toBe(true);
  expect(report.migratedSkills).not.toContain(skillDir);
});

test("install skip warning rewrites for ccstatusline ownership", () => {
  const settingsPath = join(TEST_HOME, ".claude", "settings.json");
  mkdirSync(join(TEST_HOME, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({ statusLine: { type: "command", command: "ccstatusline" } }, null, 2),
  );
  const report = install();
  expect(report.skippedStatuslineReason).toContain("baton ccstatusline-setup");
  expect(report.skippedStatuslineReason).toContain("--force");
});

test("install skip warning unchanged for non-ccstatusline statusline", () => {
  const settingsPath = join(TEST_HOME, ".claude", "settings.json");
  mkdirSync(join(TEST_HOME, ".claude"), { recursive: true });
  writeFileSync(
    settingsPath,
    JSON.stringify({ statusLine: { type: "command", command: "starship" } }, null, 2),
  );
  const report = install();
  expect(report.skippedStatuslineReason).not.toContain("baton ccstatusline-setup");
  expect(report.skippedStatuslineReason).toContain("--force");
});

test("isCcstatuslineCommand recognizes invocation forms", async () => {
  const { isCcstatuslineCommand } = await import("../src/install/settings-patch.ts");
  expect(isCcstatuslineCommand("ccstatusline")).toBe(true);
  expect(isCcstatuslineCommand("npx ccstatusline@2.2.16")).toBe(true);
  expect(isCcstatuslineCommand("node /usr/lib/ccstatusline/dist/index.js")).toBe(true);
  expect(isCcstatuslineCommand("bun run ccstatusline")).toBe(true);
  expect(isCcstatuslineCommand("CCSTATUSLINE")).toBe(true);
  expect(isCcstatuslineCommand("echo ccstatusline-not-real")).toBe(false);
  expect(isCcstatuslineCommand("my-ccstatusliner")).toBe(false);
  expect(isCcstatuslineCommand(undefined)).toBe(false);
  expect(isCcstatuslineCommand("")).toBe(false);
});
