import { expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TEST_HOME } from "./helpers/test-home.ts";

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
