import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BATON_REL_PATH } from "../config.ts";

/**
 * Walk up the directory tree from startDir looking for a BATON.md file.
 * Returns the absolute path if found, null if the filesystem root is reached.
 */
export function findBaton(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, BATON_REL_PATH);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
