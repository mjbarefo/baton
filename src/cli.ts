#!/usr/bin/env bun
import { renderStatusline } from "./statusline/render.ts";
import { runUserPromptSubmitHook } from "./hooks/user-prompt-submit.ts";
import { runPreCompactHook } from "./hooks/pre-compact.ts";
import { runSessionStartHook } from "./hooks/session-start.ts";
import { install, printReport, uninstall, printUninstallReport, check, printCheckReport } from "./install/settings-patch.ts";
import { VERSION } from "./config.ts";
import { catchBaton } from "./baton/catch.ts";
import { drop } from "./baton/drop.ts";
import { runReconstruct } from "./baton/reconstruct.ts";
import { runRedactCommand } from "./baton/redact-cmd.ts";
import { runSidecar, type SidecarHost } from "./sidecar/run.ts";
import { isSidecarMode, type SidecarMode } from "./sidecar/prompts.ts";
import {
  listArchives,
  showArchive,
  pruneArchives,
  recallArchives,
  printList,
  printPrune,
  printRecall,
} from "./baton/archive-library.ts";

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
      "  redact                      print the nearest BATON.md with secrets redacted",
      "  reconstruct <transcript-path> [--out <path>]   rebuild a baton from a transcript JSONL",
      "  list [--json]               list archived batons",
      "  show <id|prefix>            show an archived baton",
      "  prune [--keep N] [--older-than-days D] [--dry-run]  delete old archived batons",
      "  recall <query> [--json]     search archived batons",
      "  sidecar codex [--mode review|critique|alternative] [--dry-run]",
      "                              run Codex CLI headlessly with the current BATON.md",
      "                              as a same-session second opinion (read-only, ephemeral)",
      "  sidecar gemini [--mode review|critique|alternative] [--dry-run]",
      "                              run Gemini CLI headlessly with the current BATON.md",
      "                              as a same-session second opinion (read-only plan mode)",
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
    case "redact": {
      return runRedactCommand({ cwd: process.cwd() });
    }
    case "reconstruct": {
      const args2 = args.slice(1);
      const transcriptArg = args2.find(a => !a.startsWith("--"));
      if (!transcriptArg) {
        process.stderr.write("baton reconstruct: missing <transcript-path>\n");
        return 2;
      }
      const outFlagIdx = args2.indexOf("--out");
      if (outFlagIdx >= 0 && (args2[outFlagIdx + 1] === undefined || args2[outFlagIdx + 1]?.startsWith("--"))) {
        process.stderr.write("baton reconstruct: --out requires a path argument\n");
        return 2;
      }
      const outPath = outFlagIdx >= 0 ? args2[outFlagIdx + 1] : undefined;
      return runReconstruct({ transcriptPath: transcriptArg, outPath });
    }
    case "list": {
      const json = rest.includes("--json");
      const entries = listArchives();
      if (json) {
        process.stdout.write(JSON.stringify(entries, null, 2) + "\n");
      } else {
        printList(entries);
      }
      return 0;
    }
    case "show": {
      const idArg = rest.find(a => !a.startsWith("--"));
      if (!idArg) {
        process.stderr.write("baton show: missing <id|prefix>\n");
        return 2;
      }
      const content = showArchive(idArg);
      process.stdout.write(content);
      return 0;
    }
    case "prune": {
      const keepIdx = rest.indexOf("--keep");
      const olderIdx = rest.indexOf("--older-than-days");
      const dryRun = rest.includes("--dry-run");
      const keep = keepIdx >= 0 ? parseInt(rest[keepIdx + 1] ?? "", 10) : undefined;
      const olderThanDays = olderIdx >= 0 ? parseInt(rest[olderIdx + 1] ?? "", 10) : undefined;
      if (keep !== undefined && isNaN(keep)) {
        process.stderr.write("baton prune: --keep requires a number\n");
        return 2;
      }
      if (olderThanDays !== undefined && isNaN(olderThanDays)) {
        process.stderr.write("baton prune: --older-than-days requires a number\n");
        return 2;
      }
      const result = pruneArchives({ keep, olderThanDays, dryRun });
      printPrune(result, dryRun);
      return 0;
    }
    case "sidecar": {
      const host = args[1];
      if (host !== "codex" && host !== "gemini") {
        process.stderr.write(
          `baton sidecar: missing or unknown host "${host ?? ""}" (expected 'codex' or 'gemini')\n`,
        );
        return 2;
      }
      const subArgs = args.slice(2);
      const modeIdx = subArgs.indexOf("--mode");
      let mode: SidecarMode = "review";
      if (modeIdx >= 0) {
        const value = subArgs[modeIdx + 1];
        if (!value || value.startsWith("--")) {
          process.stderr.write("baton sidecar: --mode requires a value (review|critique|alternative)\n");
          return 2;
        }
        if (!isSidecarMode(value)) {
          process.stderr.write(
            `baton sidecar: unknown --mode "${value}" (expected review|critique|alternative)\n`,
          );
          return 2;
        }
        mode = value;
      }
      const dryRun = subArgs.includes("--dry-run");
      return await runSidecar({ host: host as SidecarHost, mode, cwd: process.cwd(), dryRun });
    }
    case "recall": {
      const json = rest.includes("--json");
      const query = rest.find(a => !a.startsWith("--"));
      if (!query) {
        process.stderr.write("baton recall: missing <query>\n");
        return 2;
      }
      const results = recallArchives(query);
      if (json) {
        process.stdout.write(JSON.stringify(results, null, 2) + "\n");
      } else {
        printRecall(results);
      }
      return 0;
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
