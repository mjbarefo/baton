import { describe, expect, test } from "bun:test";
import { extractFilePaths } from "../src/baton/fallback-writer.ts";
import type { TranscriptEntry } from "../src/transcript/read.ts";

function entry(text: string): TranscriptEntry {
  return {
    type: "assistant",
    isSidechain: false,
    isApiErrorMessage: false,
    message: { role: "assistant", content: text },
  };
}

describe("extractFilePaths", () => {
  test("matches real file paths and strips trailing punctuation", () => {
    expect(
      extractFilePaths([
        entry("Changed src/app.ts:12 and ./test/fallback-writer.test.ts, plus C:\\repo\\baton\\src\\cli.ts."),
      ]),
    ).toEqual(["src/app.ts:12", "./test/fallback-writer.test.ts", "C:\\repo\\baton\\src\\cli.ts"]);
  });

  test("rejects URLs, version numbers, abbreviations, and bare filenames", () => {
    expect(
      extractFilePaths([
        entry("Ignore example.com, https://example.com/api.ts, 1.2.3, U.S.A., and package.json."),
      ]),
    ).toEqual([]);
  });

  test("deduplicates case-insensitively", () => {
    expect(extractFilePaths([entry("See src/App.ts and src/app.ts")])).toEqual(["src/app.ts"]);
  });
});
