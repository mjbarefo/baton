import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { BATON_REL_PATH } from "../config.ts";
import { archiveBaton } from "./archive.ts";

function findBaton(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, BATON_REL_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export interface CatchOptions {
  cwd: string;
  dryRun?: boolean;
}

export async function catchBaton(opts: CatchOptions): Promise<number> {
  const baton = findBaton(opts.cwd);
  if (!baton) {
    process.stderr.write(
      `baton catch: no ${BATON_REL_PATH} found walking up from ${opts.cwd}. It may already have been consumed by /clear or another baton catch.\n`,
    );
    return 1;
  }

  if (opts.dryRun) {
    process.stdout.write(`[dry-run] would archive ${baton} and spawn claude with resume prompt\n`);
    return 0;
  }

  // Archive BEFORE spawning claude so the resume is a clean one-shot.
  const archivePath = archiveBaton(baton);
  process.stdout.write(`baton catch: archived baton → ${archivePath}\n`);

  const initialPrompt =
    `Read ${archivePath} top-to-bottom. Confirm in one short sentence that you understand the state. ` +
    `Then execute the "Next Concrete Action" from that file. Do not re-plan — trust the baton.`;

  const child = spawn("claude", [initialPrompt], {
    stdio: "inherit",
    cwd: opts.cwd,
  });
  return new Promise((res) => {
    child.on("exit", (code) => res(code ?? 0));
    child.on("error", (err) => {
      process.stderr.write(`baton catch: failed to spawn claude: ${String(err)}\n`);
      process.stderr.write(`baton catch: your baton is preserved at: ${archivePath}\n`);
      res(1);
    });
  });
}
