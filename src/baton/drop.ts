import { BATON_REL_PATH } from "../config.ts";
import { archiveBaton } from "./archive.ts";
import { findBaton } from "./find.ts";

export interface DropOptions {
  cwd: string;
}

export function drop(opts: DropOptions): number {
  const baton = findBaton(opts.cwd);
  if (!baton) {
    process.stdout.write(
      `baton drop: no ${BATON_REL_PATH} found walking up from ${opts.cwd}. Nothing to drop.\n`,
    );
    return 0;
  }
  try {
    const archivePath = archiveBaton(baton, "dropped");
    process.stdout.write(`baton drop: archived ${baton} → ${archivePath}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`baton drop: failed to archive ${baton}: ${String(err)}\n`);
    return 1;
  }
}
