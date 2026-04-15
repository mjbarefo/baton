import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

rmSync("dist", { recursive: true, force: true });

const build = spawnSync(
  "bun",
  ["build", "src/cli.ts", "--target=node", "--outfile", "dist/cli.js"],
  { stdio: "inherit" },
);

if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);

const cli = readFileSync("dist/cli.js", "utf8");
writeFileSync("dist/cli.js", cli.replace(/^#![^\n]*\n/, "#!/usr/bin/env node\n"), "utf8");

mkdirSync("dist/baton", { recursive: true });
copyFileSync("src/baton/template.md", "dist/baton/template.md");

try {
  chmodSync("dist/cli.js", 0o755);
} catch {
  // chmod is best-effort on Windows.
}
