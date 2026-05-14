import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWidgetFlags } from "../src/widget/flags.ts";
import { safeParseStatusJSON } from "../src/widget/json.ts";
import { runWidget } from "../src/widget/dispatch.ts";
import { batonStateDir } from "../src/config.ts";

function captureStdio<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  (process.stdout as { write: (s: string) => boolean }).write = (s: string) => { out += s; return true; };
  (process.stderr as { write: (s: string) => boolean }).write = (s: string) => { err += s; return true; };
  return fn()
    .then((result) => ({ result, out, err }))
    .finally(() => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    });
}

describe("parseWidgetFlags", () => {
  test("defaults", () => {
    expect(parseWidgetFlags([])).toEqual({ color: false, maxWidth: undefined });
  });
  test("--color sets color", () => {
    expect(parseWidgetFlags(["--color"]).color).toBe(true);
  });
  test("--max-width N (valid)", () => {
    expect(parseWidgetFlags(["--max-width", "20"]).maxWidth).toBe(20);
  });
  test("--max-width non-integer → undefined", () => {
    expect(parseWidgetFlags(["--max-width", "abc"]).maxWidth).toBeUndefined();
  });
  test("--max-width ≤ 0 → undefined", () => {
    expect(parseWidgetFlags(["--max-width", "0"]).maxWidth).toBeUndefined();
    expect(parseWidgetFlags(["--max-width", "-3"]).maxWidth).toBeUndefined();
  });
  test("--max-width followed by --color does not consume --color", () => {
    const result = parseWidgetFlags(["--max-width", "--color"]);
    expect(result.maxWidth).toBeUndefined();
    expect(result.color).toBe(true);
  });
  test("--max-width at end of argv does not crash", () => {
    expect(parseWidgetFlags(["--max-width"])).toEqual({ color: false, maxWidth: undefined });
  });
});

describe("safeParseStatusJSON", () => {
  test("valid JSON returns object", () => {
    expect(safeParseStatusJSON('{"cwd":"/x"}')).toEqual({ cwd: "/x" });
  });
  test("malformed JSON returns empty object", () => {
    expect(safeParseStatusJSON("not json")).toEqual({});
  });
  test("empty input returns empty object", () => {
    expect(safeParseStatusJSON("")).toEqual({});
  });
});

describe("runWidget", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "baton-widget-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("unknown widget name → stdout '\\n', stderr diagnostic", async () => {
    const { out, err } = await captureStdio(() => runWidget("bogus", [], "{}"));
    expect(out).toBe("\n");
    expect(err).toContain("unknown widget");
  });

  test("malformed JSON does not crash; stdout '\\n'", async () => {
    const { out } = await captureStdio(() => runWidget("badge", [], "not json"));
    expect(out).toBe("\n");
  });

  test("writes state file when session_id + context_window_size present", async () => {
    const sessionId = `t-${process.pid}-${Date.now()}`;
    const raw = JSON.stringify({
      session_id: sessionId,
      context_window: { context_window_size: 200000 },
    });
    await captureStdio(() => runWidget("badge", [], raw));
    const statePath = join(batonStateDir(), `${sessionId}.json`);
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.maxTokens).toBe(200000);
  });
});

describe("renderBadgeWidget", () => {
  let tmpHome: string;
  let tmpCwd: string;
  let batonPath: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "baton-widget-badge-home-"));
    tmpCwd = mkdtempSync(join(tmpdir(), "baton-widget-badge-cwd-"));
    batonPath = join(tmpCwd, ".claude/baton/BATON.md");
    mkdirSync(join(tmpCwd, ".claude/baton"), { recursive: true });
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(tmpCwd, { recursive: true, force: true });
  });

  test("fresh baton emits goal", async () => {
    writeFileSync(batonPath, "# T\n\n## Current Goal\nDo the thing\n");
    const { renderBadgeWidget } = await import("../src/widget/badge.ts");
    const out = renderBadgeWidget({ cwd: tmpCwd }, { color: true, maxWidth: 40 });
    expect(out).toMatch(/BATON.*Do the thing/);
  });

  test("idle emits empty string", async () => {
    const { renderBadgeWidget } = await import("../src/widget/badge.ts");
    expect(renderBadgeWidget({ cwd: tmpCwd }, { color: false, maxWidth: undefined })).toBe("");
  });

  test("hard nudge emits ⚠ HARD", async () => {
    const sessionId = `t-${process.pid}-${Date.now()}`;
    mkdirSync(batonStateDir(), { recursive: true });
    writeFileSync(join(batonStateDir(), `${sessionId}.json`), JSON.stringify({ level: "hard" }));
    const { renderBadgeWidget } = await import("../src/widget/badge.ts");
    const out = renderBadgeWidget({ session_id: sessionId }, { color: false, maxWidth: undefined });
    expect(out).toContain("⚠ HARD");
  });

  test("soft nudge emits ⚠ soft", async () => {
    const sessionId = `t-${process.pid}-${Date.now()}-2`;
    mkdirSync(batonStateDir(), { recursive: true });
    writeFileSync(join(batonStateDir(), `${sessionId}.json`), JSON.stringify({ level: "soft" }));
    const { renderBadgeWidget } = await import("../src/widget/badge.ts");
    const out = renderBadgeWidget({ session_id: sessionId }, { color: false, maxWidth: undefined });
    expect(out).toContain("⚠ soft");
  });

  test("--color absent strips ANSI", async () => {
    writeFileSync(batonPath, "# T\n\n## Current Goal\nFoo\n");
    const { renderBadgeWidget } = await import("../src/widget/badge.ts");
    const out = renderBadgeWidget({ cwd: tmpCwd }, { color: false, maxWidth: 40 });
    expect(out).not.toMatch(/\x1b\[/);
  });

  test("--max-width truncates", async () => {
    writeFileSync(batonPath, "# T\n\n## Current Goal\nA very long goal that should be cut\n");
    const { stripAnsi } = await import("../src/statusline/color.ts");
    const { renderBadgeWidget } = await import("../src/widget/badge.ts");
    const out = renderBadgeWidget({ cwd: tmpCwd }, { color: true, maxWidth: 12 });
    expect(stripAnsi(out).length).toBeLessThanOrEqual(12);
  });
});

describe("renderContextBarWidget", () => {
  test("renders bar at 30%", async () => {
    const { renderContextBarWidget } = await import("../src/widget/context-bar.ts");
    const out = renderContextBarWidget(
      { context_window: { used_percentage: 30, context_window_size: 200000 } },
      { color: false, maxWidth: undefined },
    );
    expect(out).toContain("█");
    expect(out).toContain("/");
  });

  test("red zone at 70% emits ⚠ BATON NOW", async () => {
    const { renderContextBarWidget } = await import("../src/widget/context-bar.ts");
    const out = renderContextBarWidget(
      { context_window: { used_percentage: 70, context_window_size: 200000 } },
      { color: false, maxWidth: undefined },
    );
    expect(out).toContain("⚠ BATON NOW");
  });

  test("no tokens (no used_percentage, no transcript) → empty", async () => {
    const { renderContextBarWidget } = await import("../src/widget/context-bar.ts");
    expect(
      renderContextBarWidget({}, { color: false, maxWidth: undefined }),
    ).toBe("");
  });
});
