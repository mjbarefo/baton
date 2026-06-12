import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BATON_REL_PATH, LEGACY_BATON_REL_PATH } from "../config.ts";

/**
 * Walk up the directory tree from startDir looking for a BATON.md file.
 * The host-neutral `.baton/BATON.md` path wins, but the legacy Claude path is
 * still readable for one compatibility window.
 * Returns the absolute path if found, null if the filesystem root is reached.
 */
export function findBaton(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    for (const relPath of [BATON_REL_PATH, LEGACY_BATON_REL_PATH]) {
      const candidate = join(dir, relPath);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
