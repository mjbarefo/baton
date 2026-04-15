import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface FixtureOptions {
  inputTokens: number;
  cacheRead?: number;
  cacheCreate?: number;
  outputTokens?: number;
  extraTurns?: number;
}

export function writeTranscriptFixture(dir: string, name: string, opts: FixtureOptions): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  const lines: string[] = [];
  const extra = opts.extraTurns ?? 2;
  for (let i = 0; i < extra; i++) {
    lines.push(
      JSON.stringify({
        type: "user",
        isSidechain: false,
        isApiErrorMessage: false,
        message: { role: "user", content: `turn ${i}` },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "assistant",
        isSidechain: false,
        isApiErrorMessage: false,
        message: {
          role: "assistant",
          content: [{ type: "text", text: `response ${i}` }],
          usage: {
            input_tokens: Math.floor(opts.inputTokens / 3),
            cache_read_input_tokens: Math.floor((opts.cacheRead ?? 0) / 3),
            output_tokens: Math.floor((opts.outputTokens ?? 0) / 3),
          },
        },
      }),
    );
  }
  // Final assistant turn carries the actual target usage.
  lines.push(
    JSON.stringify({
      type: "assistant",
      isSidechain: false,
      isApiErrorMessage: false,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "final response referencing src/foo.ts:42" }],
        usage: {
          input_tokens: opts.inputTokens,
          cache_read_input_tokens: opts.cacheRead ?? 0,
          cache_creation_input_tokens: opts.cacheCreate ?? 0,
          output_tokens: opts.outputTokens ?? 0,
        },
      },
    }),
  );
  writeFileSync(path, lines.join("\n") + "\n");
  return path;
}
