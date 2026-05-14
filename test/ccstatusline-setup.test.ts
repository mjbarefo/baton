import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("ccstatusline-setup prints expected blocks", () => {
  const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
  const result = spawnSync("bun", ["run", cliPath, "ccstatusline-setup"], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  const out = result.stdout;
  expect(out).toContain("widget badge");
  expect(out).toContain("widget context-bar");
  expect(out).toMatch(/timeout:\s+3000/);
  expect(out).toContain("preserveColors");
  expect(out).toContain("Run `ccstatusline` in a terminal");
});

test("widget badge end-to-end: empty payload → '\\n', exit 0", () => {
  const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
  const result = spawnSync("bun", ["run", cliPath, "widget", "badge"], {
    input: "{}",
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("\n");
});

test("widget unknown name → '\\n' stdout, stderr diagnostic, exit 0", () => {
  const cliPath = join(import.meta.dir, "..", "src", "cli.ts");
  const result = spawnSync("bun", ["run", cliPath, "widget", "bogus"], {
    input: "{}",
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  expect(result.stdout).toBe("\n");
  expect(result.stderr).toContain("unknown widget");
});
