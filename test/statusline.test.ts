import { expect, test, describe, beforeEach, afterEach } from "bun:test";
import { renderBatonBadge } from "../src/statusline/widgets.ts";
import { renderStatusline } from "../src/statusline/render.ts";
import { join } from "node:path";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { batonStateDir } from "../src/config.ts";

const ANSI_RE = /\x1b\[[0-9;]*m/g;

describe("renderBatonBadge", () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;
  let stateFilePath: string | null;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "baton-statusline-"));
    originalHome = process.env.HOME;
    originalUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpHome;
    process.env.USERPROFILE = tmpHome;
    stateFilePath = null;
  });

  afterEach(() => {
    if (stateFilePath) {
      rmSync(stateFilePath, { force: true });
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("returns idle badge for invalid level", () => {
    const sessionId = `test-invalid-level-${process.pid}-${Date.now()}`;
    const dir = batonStateDir();
    mkdirSync(dir, { recursive: true });
    stateFilePath = join(dir, `${sessionId}.json`);
    writeFileSync(stateFilePath, JSON.stringify({ level: "invalid", maxTokens: 200_000 }));

    const badge = renderBatonBadge(undefined, sessionId, 200_000);

    expect(badge).toContain("→");
    expect(badge).not.toContain("⚠ soft");
    expect(badge).not.toContain("⚠ HARD");
  });

  describe("baton goal", () => {
    let tmpCwd: string;
    let batonPath: string;

    beforeEach(() => {
      tmpCwd = mkdtempSync(join(tmpdir(), "baton-cwd-"));
      batonPath = join(tmpCwd, ".claude/baton/BATON.md");
      mkdirSync(join(tmpCwd, ".claude/baton"), { recursive: true });
    });

    afterEach(() => {
      rmSync(tmpCwd, { recursive: true, force: true });
    });

    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    test("shows extracted goal from fresh baton", () => {
      writeFileSync(batonPath, "# Title\n\n## Current Goal\nRefactor settings-patch for idempotent install\n");
      const badge = renderBatonBadge(tmpCwd, undefined);
      const cleanBadge = badge.replace(/\x1b\[[0-9;]*m/g, "");
      expect(cleanBadge).toContain("BATON: Refactor settings-patch for idempotent…");
    });

    test("truncates long goals with ellipsis", () => {
      writeFileSync(batonPath, "# Title\n\n## Current Goal\nThis is a very long goal that will exceed forty characters easily and definitely needs to be truncated\n");
      const badge = renderBatonBadge(tmpCwd, undefined);
      const cleanBadge = badge.replace(/\x1b\[[0-9;]*m/g, "");
      expect(cleanBadge).toContain("BATON: This is a very long goal that will exce…");
    });

    test("collapses whitespace in goal", () => {
      writeFileSync(batonPath, "# Title\n\n## Current Goal\n   Goal  with\t   extra whitespace   \n");
      const badge = renderBatonBadge(tmpCwd, undefined);
      const cleanBadge = badge.replace(/\x1b\[[0-9;]*m/g, "");
      expect(cleanBadge).toContain("BATON: Goal with extra whitespace");
    });

    test("falls back to default badge for missing goal section", () => {
      writeFileSync(batonPath, "# Title\n\n## Other Section\nNo goal here\n");
      const badge = renderBatonBadge(tmpCwd, undefined);
      expect(badge).toContain("BATON ✓");
    });

    test("falls back to default badge for _none_ goal", () => {
      writeFileSync(batonPath, "# Title\n\n## Current Goal\n_none_\n");
      const badge = renderBatonBadge(tmpCwd, undefined);
      expect(badge).toContain("BATON ✓");
    });

    test("falls back to default badge for _unknown_ goal", () => {
      writeFileSync(batonPath, "# Title\n\n## Current Goal\n_unknown_\n");
      const badge = renderBatonBadge(tmpCwd, undefined);
      expect(badge).toContain("BATON ✓");
    });

    test("invalidates cache when mtime changes", async () => {
      writeFileSync(batonPath, "## Current Goal\nFirst Goal\n");
      let badge = renderBatonBadge(tmpCwd, undefined);
      expect(badge.replace(/\x1b\[[0-9;]*m/g, "")).toContain("BATON: First Goal");

      await delay(10);
      writeFileSync(batonPath, "## Current Goal\nSecond Goal\n");
      badge = renderBatonBadge(tmpCwd, undefined);
      expect(badge.replace(/\x1b\[[0-9;]*m/g, "")).toContain("BATON: Second Goal");
    });

    test("prioritizes fresh baton over hard nudge level", () => {
      writeFileSync(batonPath, "## Current Goal\nFresh Goal\n");

      const sessionId = `test-hard-nudge-${process.pid}-${Date.now()}`;
      const dir = batonStateDir();
      mkdirSync(dir, { recursive: true });
      stateFilePath = join(dir, `${sessionId}.json`);
      writeFileSync(stateFilePath, JSON.stringify({ level: "hard", maxTokens: 200_000 }));

      const badge = renderBatonBadge(tmpCwd, sessionId);
      expect(badge.replace(/\x1b\[[0-9;]*m/g, "")).toContain("BATON: Fresh Goal");
    });
  });
});

describe("renderStatusline width adaptation", () => {
  let originalColumns: number | undefined;

  beforeEach(() => {
    originalColumns = process.stdout.columns;
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      writable: true,
      configurable: true,
    });
  });

  const dummyPayload = JSON.stringify({
    model: { display_name: "Sonnet 4.5" },
    worktree: { branch: "main", is_dirty: true },
    context_window: { context_window_size: 200000, used_percentage: 41 },
    rate_limits: { five_hour: { used_percentage: 71 } },
    cost: { total_duration_ms: 720000, total_cost_usd: 1.24 },
  });

  function setColumns(cols: number | undefined) {
    Object.defineProperty(process.stdout, "columns", {
      value: cols,
      writable: true,
      configurable: true,
    });
  }

  test("columns = 200 -> all widgets present", async () => {
    setColumns(200);
    const line = await renderStatusline(dummyPayload);
    expect(line).toContain("Sonnet 4.5");
    expect(line).toContain("main*");
    expect(line).toContain("71%");
    expect(line).toContain("12m");
    expect(line).toContain("$1.24");
  });

  test("columns = 60 -> cost and duration dropped; rateLimit, baton badge, branch, bar, model remain", async () => {
    setColumns(60);
    const line = await renderStatusline(dummyPayload);
    expect(line).toContain("Sonnet 4.5");
    expect(line).toContain("main*");
    expect(line).not.toContain("$1.24");
    expect(line).not.toContain("12m");
  });

  test("columns = 40 -> drop loop trims low-priority widgets but keeps more than the first segment", async () => {
    setColumns(40);
    const line = await renderStatusline(dummyPayload);

    expect(line).toContain("Sonnet 4.5");
    expect(line).toContain("main*");
    expect(line).not.toContain("71%");
    expect(line).not.toContain("12m");
    expect(line).not.toContain("$1.24");
  });

  test("columns < 40 -> everything dropped except the first segment", async () => {
    setColumns(35);
    const line = await renderStatusline(dummyPayload);
    expect(line).toContain("Sonnet 4.5");
    expect(line).not.toContain("main*");
    expect(line).not.toContain("$1.24");
  });

  test("columns = undefined -> all widgets present (no truncation)", async () => {
    setColumns(undefined);
    const line = await renderStatusline(dummyPayload);
    expect(line).toContain("Sonnet 4.5");
    expect(line).toContain("main*");
    expect(line).toContain("71%");
    expect(line).toContain("12m");
    expect(line).toContain("$1.24");
  });

  test("widget absent gracefully skips and drops remaining if needed", async () => {
    setColumns(44);
    const noCostPayload = JSON.stringify({
      model: { display_name: "Sonnet 4.5" },
      worktree: { branch: "main", is_dirty: true },
      context_window: { context_window_size: 200000, used_percentage: 41 },
    });
    const line = await renderStatusline(noCostPayload);
    const stripped = line.replace(ANSI_RE, "");

    expect(line).toContain("Sonnet 4.5");
    expect(line).not.toContain("$");
    expect(stripped.length).toBeLessThanOrEqual(44);
  });

  test("fresh baton goal shrinks to fit narrow widths", async () => {
    setColumns(44);
    const tmpCwd = mkdtempSync(join(tmpdir(), "baton-statusline-width-"));
    try {
      mkdirSync(join(tmpCwd, ".claude/baton"), { recursive: true });
      writeFileSync(
        join(tmpCwd, ".claude/baton/BATON.md"),
        "# Title\n\n## Current Goal\nShip a very small but still meaningful baton goal in the statusline\n",
      );

      const line = await renderStatusline(JSON.stringify({
        cwd: tmpCwd,
        model: { display_name: "Sonnet 4.5" },
        context_window: { context_window_size: 200000, used_percentage: 41 },
      }));
      const stripped = line.replace(ANSI_RE, "");

      expect(stripped).toContain("BATON:");
      expect(stripped.length).toBeLessThanOrEqual(44);
    } finally {
      rmSync(tmpCwd, { recursive: true, force: true });
    }
  });

  test("ANSI codes are not counted in visible length", async () => {
    setColumns(60);
    const line = await renderStatusline(dummyPayload);
    const stripped = line.replace(ANSI_RE, "");

    expect(stripped.length).toBeLessThanOrEqual(59);
  });
});

describe("renderStatusline state persistence", () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), "baton-statusline-persist-"));
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  test("persists maxTokens and rateLimit5hPct to state file", async () => {
    const sessionId = "persist-test-session";
    const payload = JSON.stringify({
      session_id: sessionId,
      context_window: { context_window_size: 150000, used_percentage: 10 },
      rate_limits: { five_hour: { used_percentage: 95 } },
    });

    await renderStatusline(payload);

    const statePath = join(batonStateDir(), `${sessionId}.json`);
    expect(existsSync(statePath)).toBe(true);

    const state = JSON.parse(readFileSync(statePath, "utf8"));
    expect(state.maxTokens).toBe(150000);
    expect(state.rateLimit5hPct).toBe(95);
  });

  test("does not overwrite rateLimit5hPct with undefined on partial payloads", async () => {
    const sessionId = "persist-partial-session";

    // First render has both
    const initialPayload = JSON.stringify({
      session_id: sessionId,
      context_window: { context_window_size: 150000 },
      rate_limits: { five_hour: { used_percentage: 95 } },
    });
    await renderStatusline(initialPayload);

    // Second render is missing rate limit
    const partialPayload = JSON.stringify({
      session_id: sessionId,
      context_window: { context_window_size: 150000 },
    });
    await renderStatusline(partialPayload);

    const statePath = join(batonStateDir(), `${sessionId}.json`);
    const state = JSON.parse(readFileSync(statePath, "utf8"));

    expect(state.maxTokens).toBe(150000);
    expect(state.rateLimit5hPct).toBe(95); // Should still be 95
  });
});
