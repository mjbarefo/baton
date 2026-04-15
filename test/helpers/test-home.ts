import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const TEST_HOME = join(tmpdir(), "baton test shared home");

mkdirSync(TEST_HOME, { recursive: true });
process.env.USERPROFILE = TEST_HOME;
process.env.HOME = TEST_HOME;
