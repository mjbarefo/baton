import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { BATON_REL_PATH, userHomeDir } from "../config.ts";
import { findBaton } from "../baton/find.ts";
import { projectRootForBaton } from "../baton/archive.ts";
import {
  redact,
  loadUserPatterns,
  loadProjectPatterns,
  DEFAULT_PATTERNS,
} from "../baton/redact.ts";
import { composePrompt, isSidecarMode, type SidecarMode } from "./prompts.ts";
import { codexAdapter } from "./codex.ts";
import { geminiAdapter } from "./gemini.ts";

export type SidecarHost = "codex" | "gemini";

export function isSidecarHost(value: unknown): value is SidecarHost {
  return value === "codex" || value === "gemini";
}

export interface HostAdapter {
  binaryName: string;
  installHint: string;
  buildInvocation(prompt: string): { argv: string[]; stdin?: string };
}

export interface SidecarOptions {
  host: SidecarHost;
  mode: SidecarMode;
  cwd: string;
  dryRun?: boolean;
}

function pickAdapter(host: SidecarHost): HostAdapter {
  if (host === "codex") return codexAdapter;
  if (host === "gemini") return geminiAdapter;
  throw new Error(`baton sidecar: unknown host "${host as string}"`);
}

function isOnPath(bin: string): boolean {
  const lookup = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(lookup, [bin], { stdio: "ignore" });
  return result.status === 0;
}


export async function runSidecar(opts: SidecarOptions): Promise<number> {
  if (!isSidecarHost(opts.host)) {
    process.stderr.write(`baton sidecar: unknown host "${String(opts.host)}" (expected codex|gemini)\n`);
    return 2;
  }
  if (!isSidecarMode(opts.mode)) {
    process.stderr.write(
      `baton sidecar: invalid mode "${String(opts.mode)}" (expected review|critique|alternative)\n`,
    );
    return 2;
  }

  const batonPath = findBaton(opts.cwd);
  if (!batonPath) {
    process.stderr.write(
      `baton sidecar: no ${BATON_REL_PATH} found walking up from ${opts.cwd}. Write a baton first with /baton or a host-native baton command.\n`,
    );
    return 1;
  }

  const batonRoot = projectRootForBaton(batonPath);
  const rawBody = readFileSync(batonPath, "utf8");
  const patterns = [
    ...DEFAULT_PATTERNS,
    ...loadUserPatterns(userHomeDir()),
    ...loadProjectPatterns(batonRoot),
  ];
  const { body: redactedBody, hits } = redact(rawBody, patterns);
  if (hits.length > 0) {
    const total = hits.reduce((sum, h) => sum + h.count, 0);
    process.stderr.write(
      `baton sidecar: redacted ${total} secret${total === 1 ? "" : "s"} before sending to ${opts.host}\n`,
    );
  }

  const adapter = pickAdapter(opts.host);
  const prompt = composePrompt(opts.mode, redactedBody);
  const invocation = adapter.buildInvocation(prompt);

  if (opts.dryRun) {
    process.stdout.write(JSON.stringify([adapter.binaryName, ...invocation.argv]) + "\n");
    process.stderr.write(prompt + "\n");
    return 0;
  }

  if (!isOnPath(adapter.binaryName)) {
    process.stderr.write(
      `baton sidecar: '${adapter.binaryName}' not found on PATH. ${adapter.installHint}\n`,
    );
    return 2;
  }

  const child = spawn(adapter.binaryName, invocation.argv, {
    stdio: invocation.stdin === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    cwd: opts.cwd,
  });
  if (invocation.stdin !== undefined) {
    child.stdin?.end(invocation.stdin);
  }
  return new Promise((res) => {
    child.on("exit", (code) => res(code ?? 0));
    child.on("error", (err) => {
      process.stderr.write(
        `baton sidecar: failed to spawn ${adapter.binaryName}: ${String(err)}\n`,
      );
      res(1);
    });
  });
}
