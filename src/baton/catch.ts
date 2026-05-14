import { spawn, spawnSync } from "node:child_process";
import { BATON_REL_PATH } from "../config.ts";
import { archiveBaton } from "./archive.ts";
import { freshestExistingBatonWalkingUp } from "./freshness.ts";

function isOnPath(bin: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  return spawnSync(lookup, [bin], { stdio: "ignore" }).status === 0;
}

export type CatchHost = "claude" | "codex" | "gemini";

export interface CatchOptions {
  cwd: string;
  dryRun?: boolean;
  host?: CatchHost;
}

export async function catchBaton(opts: CatchOptions): Promise<number> {
  const batonResult = freshestExistingBatonWalkingUp(opts.cwd);
  const baton = batonResult?.path ?? null;
  const host = opts.host ?? "claude";
  if (!baton) {
    process.stderr.write(
      `baton catch: no ${BATON_REL_PATH} found walking up from ${opts.cwd}. It may already have been consumed by /clear or another baton catch.\n`,
    );
    return 1;
  }

  if (opts.dryRun) {
    const invocation = catchInvocation(host, "<resume prompt>");
    process.stdout.write(`[dry-run] would archive ${baton} and spawn ${JSON.stringify(invocation)}\n`);
    return 0;
  }

  const [bin] = catchInvocation(host, "");
  if (!isOnPath(bin)) {
    process.stderr.write(`baton catch: '${bin}' not found on PATH — install it first.\n`);
    return 1;
  }

  // Archive BEFORE spawning so the resume is a clean one-shot. Binary existence
  // is confirmed above so the baton is only relocated once we know spawn will work.
  const archivePath = archiveBaton(baton);
  process.stdout.write(`baton catch: archived baton → ${archivePath}\n`);

  const initialPrompt =
    `Read ${archivePath} top-to-bottom. Confirm in one short sentence that you understand the state. ` +
    `Then execute the "Next Concrete Action" from that file. Do not re-plan — trust the baton.`;

  const [, argv] = catchInvocation(host, initialPrompt);
  const child = spawn(bin, argv, {
    stdio: "inherit",
    cwd: opts.cwd,
  });
  return new Promise((res) => {
    child.on("exit", (code) => res(code ?? 0));
    child.on("error", (err) => {
      process.stderr.write(`baton catch: failed to spawn ${host}: ${String(err)}\n`);
      process.stderr.write(`baton catch: your baton is preserved at: ${archivePath}\n`);
      res(1);
    });
  });
}

function catchInvocation(host: CatchHost, prompt: string): [string, string[]] {
  if (host === "codex") return ["codex", [prompt]];
  if (host === "gemini") return ["gemini", ["--prompt", prompt]];
  return ["claude", [prompt]];
}
