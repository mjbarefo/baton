import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BATON_FRESH_MS, BATON_REL_PATH, LEGACY_BATON_REL_PATH } from "../config.ts";

export interface BatonFreshness {
  path: string;
  relPath: string;
  exists: boolean;
  fresh: boolean;
  ageMs: number | null;
  legacy: boolean;
}

export const BATON_REL_PATHS = [BATON_REL_PATH, LEGACY_BATON_REL_PATH] as const;

export function freshnessForPath(path: string, relPath = path): BatonFreshness {
  if (!existsSync(path)) {
    return {
      path,
      relPath,
      exists: false,
      fresh: false,
      ageMs: null,
      legacy: relPath === LEGACY_BATON_REL_PATH,
    };
  }

  try {
    const stat = statSync(path);
    const ageMs = Date.now() - stat.mtimeMs;
    return {
      path,
      relPath,
      exists: true,
      fresh: ageMs < BATON_FRESH_MS,
      ageMs,
      legacy: relPath === LEGACY_BATON_REL_PATH,
    };
  } catch {
    return {
      path,
      relPath,
      exists: false,
      fresh: false,
      ageMs: null,
      legacy: relPath === LEGACY_BATON_REL_PATH,
    };
  }
}

export function batonCandidates(cwd: string): BatonFreshness[] {
  return BATON_REL_PATHS.map((relPath) => freshnessForPath(join(cwd, relPath), relPath));
}

export function freshestExistingBaton(cwd: string): BatonFreshness | null {
  const candidates = batonCandidates(cwd).filter((candidate) => candidate.exists);
  if (candidates.length === 0) return null;
  const fresh = candidates.find((candidate) => candidate.fresh);
  return fresh ?? candidates[0]!;
}

export function freshestExistingBatonWalkingUp(cwd: string): BatonFreshness | null {
  let dir = resolve(cwd);
  while (true) {
    const baton = freshestExistingBaton(dir);
    if (baton) return baton;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
