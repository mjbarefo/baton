import { BATON_REL_PATH } from "../config.ts";
import { archiveBaton, PartialArchiveError } from "./archive.ts";
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
    if (err instanceof PartialArchiveError) {
      process.stdout.write(`baton drop: archived ${baton} → ${err.archivePath}\n`);
      process.stderr.write(
        `baton drop: source file could not be removed — it may re-inject on next /clear. Run /drop again.\n`,
      );
      return 1;
    }
    process.stderr.write(`baton drop: failed to archive ${baton}: ${String(err)}\n`);
    return 1;
  }
}
