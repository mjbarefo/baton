import { readFileSync } from "node:fs";
import { BATON_REL_PATH, userHomeDir } from "../config.ts";
import { findBaton } from "./find.ts";
import { projectRootForBaton } from "./archive.ts";
import {
  DEFAULT_PATTERNS,
  loadProjectPatterns,
  loadUserPatterns,
  redactSecrets,
} from "./redact.ts";

export interface RedactCommandOptions {
  cwd: string;
}

export function runRedactCommand(opts: RedactCommandOptions = { cwd: process.cwd() }): number {
  const batonPath = findBaton(opts.cwd);
  if (!batonPath) {
    process.stderr.write(
      `baton redact: no ${BATON_REL_PATH} found walking up from ${opts.cwd}. Run /baton in Claude Code first to write a baton.\n`,
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
  const { body, hits } = redactSecrets(rawBody, patterns);
  const total = hits.reduce((sum, hit) => sum + hit.count, 0);

  process.stdout.write(body);
  process.stderr.write(`Redacted ${total} secret(s)\n`);
  return 0;
}
