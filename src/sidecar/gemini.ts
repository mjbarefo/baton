import type { HostAdapter } from "./run.ts";

export const geminiAdapter: HostAdapter = {
  binaryName: "gemini",
  installHint: "Install Gemini CLI from https://github.com/google-gemini/gemini-cli (npm: @google/gemini-cli).",
  buildInvocation(prompt: string): { argv: string[]; stdin: string } {
    // The baton body goes on stdin, not argv: argv would leak the (redacted)
    // baton to `ps` while Gemini runs and hit the ~32KB command-line limit on
    // Windows. Gemini's --prompt is documented as "appended to input on stdin",
    // so a short trailing instruction keeps it in headless mode.
    return {
      argv: [
        "--prompt",
        "Respond to the briefing provided on stdin above.",
        "--model",
        "pro",
        "--approval-mode",
        "plan",
      ],
      stdin: prompt,
    };
  },
};
