#!/usr/bin/env bun
import { renderStatusline } from "./statusline/render.ts";
import { runUserPromptSubmitHook } from "./hooks/user-prompt-submit.ts";
import { runPreCompactHook } from "./hooks/pre-compact.ts";
import { runSessionStartHook } from "./hooks/session-start.ts";
import { install, printReport, uninstall, printUninstallReport } from "./install/settings-patch.ts";
import { catchBaton } from "./baton/catch.ts";
import { drop } from "./baton/drop.ts";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function usage(): void {
  process.stderr.write(
    [
      "baton — context-aware session baton for Claude Code",
      "",
      "Usage:",
      "  baton                             Install into Claude Code",
      "  baton statusline                  Render statusline (Claude Code pipes StatusJSON on stdin)",
      "  baton hook user-prompt-submit     Hook handler (pipe hook payload on stdin)",
      "  baton hook pre-compact            Hook handler (pipe hook payload on stdin)",
      "  baton hook session-start          Hook handler (pipe hook payload on stdin)",
      "  baton install [--force]           Patch ~/.claude/settings.json and install /baton command",
      "                                   --force replaces an existing non-baton statusLine (e.g. ccstatusline)",
      "  baton uninstall                   Remove hooks/statusLine/commands; restore settings.json from backup",
      "  baton catch [--dry-run]           Resume from the nearest .claude/baton/BATON.md",
      "  baton drop                        Archive the nearest BATON.md so /clear starts fresh",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const [cmd, sub] = args;
  const rest = args.slice(1);
  switch (cmd) {
    case "statusline": {
      const raw = await readStdin();
      const line = await renderStatusline(raw);
      process.stdout.write(line + "\n");
      return 0;
    }
    case "hook": {
      const raw = await readStdin();
      if (sub === "user-prompt-submit") {
        await runUserPromptSubmitHook(raw);
        return 0;
      }
      if (sub === "pre-compact") {
        return await runPreCompactHook(raw);
      }
      if (sub === "session-start") {
        return await runSessionStartHook(raw);
      }
      usage();
      return 2;
    }
    case "install": {
      const force = args.includes("--force");
      const report = install({ force });
      printReport(report);
      return 0;
    }
    case "uninstall": {
      const report = uninstall();
      printUninstallReport(report);
      return 0;
    }
    case "catch": {
      const dryRun = rest.includes("--dry-run");
      return await catchBaton({ cwd: process.cwd(), dryRun });
    }
    case "drop": {
      return drop({ cwd: process.cwd() });
    }
    case undefined: {
      const force = args.includes("--force");
      const report = install({ force });
      printReport(report);
      return 0;
    }
    case "--help":
    case "-h":
    case "help":
      usage();
      return 0;
    default:
      usage();
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`baton: ${String(err)}\n`);
    process.exit(1);
  });
