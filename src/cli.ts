#!/usr/bin/env bun
import { renderStatusline } from "./statusline/render.ts";
import { runUserPromptSubmitHook } from "./hooks/user-prompt-submit.ts";
import { runPreCompactHook } from "./hooks/pre-compact.ts";
import { runSessionStartHook } from "./hooks/session-start.ts";
import { install, printReport, uninstall, printUninstallReport, check, printCheckReport } from "./install/settings-patch.ts";
import { VERSION } from "./config.ts";
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
      `baton v${VERSION} — context-aware session baton for Claude Code`,
      "",
      "  npx ccbaton@latest          install or upgrade",
      "  npx ccbaton check           verify current install",
      "  npx ccbaton uninstall       remove",
      "",
      "Subcommands:",
      "  install [--force]           patch ~/.claude/settings.json",
      "                              --force replaces an existing non-baton statusLine",
      "  uninstall                   restore settings.json from backup, remove artifacts",
      "  check                       show current install status (read-only)",
      "  catch [--dry-run]           resume from the nearest BATON.md",
      "  drop                        archive the nearest BATON.md so /clear starts fresh",
      "",
      "Internal (Claude Code pipes data on stdin):",
      "  statusline                  render the statusline",
      "  hook user-prompt-submit     UserPromptSubmit handler",
      "  hook pre-compact            PreCompact handler",
      "  hook session-start          SessionStart handler",
      "",
    ].join("\n"),
  );
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--version") || args.includes("-v")) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
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
      const postinstall = args.includes("--postinstall");
      if (postinstall) {
        try {
          const report = install({ force, postinstall });
          printReport(report);
        } catch (err) {
          process.stderr.write(`baton: postinstall failed (non-fatal): ${String(err)}\n`);
        }
        return 0;
      }
      const report = install({ force, postinstall });
      printReport(report);
      return 0;
    }
    case "check": {
      const report = check();
      printCheckReport(report);
      return report.allPresent ? 0 : 1;
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
    case "--version":
    case "-v":
      process.stdout.write(`${VERSION}\n`);
      return 0;
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
