import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { batonStatus } from "../src/baton/status.ts";
import { validateBaton } from "../src/baton/validate.ts";
import { TEST_HOME } from "./helpers/test-home.ts";

let tmp: string;

const VALID_BATON = `# Baton — test

_Written by test at 2026-05-14T00:00:00.000Z._

## Current Goal
Ship multi-host baton support.

## Completed This Session
- Updated \`src/config.ts:1\`.

## Active Work
**What:** Wiring validation.
**Where:** \`src/baton/validate.ts:1-120\`
**Why:** Bad batons should fail before resume.
**State:** tested-passing

## Next Concrete Action
Open src/cli.ts and add the validate command branch.

## Decisions & Constraints
- Use .baton/BATON.md as canonical.

## Gotchas Discovered
_none_

## User Preferences Observed
_none_

## Open Questions for the User
_none_

## Key Files (quick index)
- \`src/baton/validate.ts\` — validator

## Recent Test / Build State
\`bun test test/validate-status.test.ts\` — not run in this environment.
`;

beforeEach(() => {
  tmp = join(tmpdir(), `baton-validate-${crypto.randomUUID()}`);
  mkdirSync(tmp, { recursive: true });
  // .git sentinel bounds findGitignoreBatonMatch's upward walk to tmp
  mkdirSync(join(tmp, ".git"), { recursive: true });
  rmSync(join(TEST_HOME, ".baton"), { recursive: true, force: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(join(TEST_HOME, ".baton"), { recursive: true, force: true });
  rmSync(join(TEST_HOME, ".config", "git"), { recursive: true, force: true });
});

test("validateBaton accepts a concrete baton", () => {
  const path = join(tmp, ".baton", "BATON.md");
  mkdirSync(join(tmp, ".baton"), { recursive: true });
  writeFileSync(path, VALID_BATON);

  const report = validateBaton(path);

  expect(report.valid).toBe(true);
  expect(report.errors).toHaveLength(0);
});

test("validateBaton rejects vague goals and next action", () => {
  const path = join(tmp, ".baton", "BATON.md");
  mkdirSync(join(tmp, ".baton"), { recursive: true });
  writeFileSync(
    path,
    VALID_BATON
      .replace("Ship multi-host baton support.", "_unknown_")
      .replace("Open src/cli.ts and add the validate command branch.", "continue the work"),
  );

  const report = validateBaton(path);

  expect(report.valid).toBe(false);
  expect(report.errors.map((e) => e.code)).toContain("weak-current-goal");
  expect(report.errors.map((e) => e.code)).toContain("weak-next-action");
});

test("validateBaton scans project .batonignore from the project root", () => {
  const path = join(tmp, ".baton", "BATON.md");
  mkdirSync(join(tmp, ".baton"), { recursive: true });
  writeFileSync(join(tmp, ".batonignore"), "fixture secret:::MYSECRET-[A-Z]+\n");
  writeFileSync(path, VALID_BATON.replace("_none_\n\n## User Preferences", "MYSECRET-ABC\n\n## User Preferences"));

  const report = validateBaton(path);

  expect(report.valid).toBe(false);
  expect(report.errors.map((e) => e.code)).toContain("secret");
});

test("batonStatus finds canonical baton and extracts goal", () => {
  const path = join(tmp, ".baton", "BATON.md");
  mkdirSync(join(tmp, ".baton"), { recursive: true });
  writeFileSync(path, VALID_BATON);

  const report = batonStatus(tmp);

  expect(report.baton.path).toBe(path);
  expect(report.baton.fresh).toBe(true);
  expect(report.baton.goal).toBe("Ship multi-host baton support.");
});

test("batonStatus warns when .gitignore contains a pattern matching .baton/", () => {
  writeFileSync(join(tmp, ".gitignore"), ".baton/\n");

  const report = batonStatus(tmp);

  expect(report.gitignoreWarning).toContain(".baton/");
  expect(report.gitignoreWarning).toContain(join(tmp, ".gitignore"));
});

test("batonStatus has no gitignore warning when .gitignore does not match .baton/", () => {
  writeFileSync(join(tmp, ".gitignore"), "node_modules/\ndist/\n");

  const report = batonStatus(tmp);

  expect(report.gitignoreWarning).toBeNull();
});

test("batonStatus has no gitignore warning when no .gitignore exists", () => {
  const report = batonStatus(tmp);
  expect(report.gitignoreWarning).toBeNull();
});

test("batonStatus warns when global ~/.config/git/ignore matches .baton/", () => {
  const globalIgnore = join(TEST_HOME, ".config", "git", "ignore");
  mkdirSync(join(TEST_HOME, ".config", "git"), { recursive: true });
  writeFileSync(globalIgnore, ".baton/\n");

  const report = batonStatus(tmp);

  expect(report.gitignoreWarning).toContain(".baton/");
  expect(report.gitignoreWarning).toContain(globalIgnore);
});

test("batonStatus has no warning when global ~/.config/git/ignore does not match .baton/", () => {
  const globalIgnore = join(TEST_HOME, ".config", "git", "ignore");
  mkdirSync(join(TEST_HOME, ".config", "git"), { recursive: true });
  writeFileSync(globalIgnore, "node_modules/\n*.log\n");

  const report = batonStatus(tmp);

  expect(report.gitignoreWarning).toBeNull();
});

test("batonStatus: project .gitignore match takes precedence over global ignore", () => {
  // Both exist — we get the project-level match back first.
  writeFileSync(join(tmp, ".gitignore"), ".baton/\n");
  const globalIgnore = join(TEST_HOME, ".config", "git", "ignore");
  mkdirSync(join(TEST_HOME, ".config", "git"), { recursive: true });
  writeFileSync(globalIgnore, ".baton/\n");

  const report = batonStatus(tmp);

  expect(report.gitignoreWarning).toContain(join(tmp, ".gitignore"));
});
