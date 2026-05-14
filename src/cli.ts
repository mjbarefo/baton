#!/usr/bin/env bun
import { renderStatusline } from "./statusline/render.ts";
import { runUserPromptSubmitHook } from "./hooks/user-prompt-submit.ts";
import { runPreCompactHook } from "./hooks/pre-compact.ts";
import { runSessionStartHook } from "./hooks/session-start.ts";
import { install, printReport, uninstall, printUninstallReport, check, printCheckReport } from "./install/settings-patch.ts";
import { VERSION, buildCommand } from "./config.ts";
import { runWidget } from "./widget/dispatch.ts";
import { color } from "./statusline/color.ts";
import { catchBaton } from "./baton/catch.ts";
import { drop } from "./baton/drop.ts";
import { runReconstruct } from "./baton/reconstruct.ts";
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
import {
  backupCcstatusline,
  listCcstatuslineBackups,
  restoreCcstatusline,
  printBackup as printCcsBackup,
  printRestore as printCcsRestore,
  printList as printCcsList,
} from "./install/ccstatusline-backup.ts";

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
      "  ccstatusline-setup          print copy-paste instructions for wiring",
      "                              baton widgets into ccstatusline",
      "  ccstatusline-backup [--out <path>]",
      "                              snapshot ~/.config/ccstatusline/settings.json",
      "                              into ~/.claude/baton/ccstatusline-backups/",
      "  ccstatusline-restore [<path>] [--list]",
      "                              restore ccstatusline settings.json from the",
      "                              latest baton-managed backup, or from <path>;",
      "                              --list shows available backups instead",
      "",
      "Internal (Claude Code pipes data on stdin):",
      "  statusline                  render the statusline",
      "  widget <name>               render a baton widget for ccstatusline composition",
      "                              (name: badge|context-bar; flags: --color, --max-width N)",
      "  hook user-prompt-submit     UserPromptSubmit handler",
      "  hook pre-compact            PreCompact handler",
      "  hook session-start          SessionStart handler",
      "",
    ].join("\n"),
  );
}

function buildCcstatuslineSetup(): string {
  const isTTY = !!process.stdout.isTTY;
  const dim = (s: string): string => (isTTY ? color.dim(s) : s);
  const bold = (s: string): string => (isTTY ? color.bold(s) : s);
  const badgeCmd = buildCommand("widget badge --color --max-width 40");
  const barCmd = buildCommand("widget context-bar --color --max-width 12");
  return [
    bold("baton + ccstatusline composition"),
    "",
    dim("Tip: run `baton ccstatusline-backup` before editing your ccstatusline"),
    dim("config so you can `baton ccstatusline-restore` if something goes wrong."),
    "",
    "Two baton widgets to add to ccstatusline:",
    "",
    bold("1. Baton badge") + " — shows BATON.md goal when fresh, or ⚠ soft / ⚠ HARD when nudges have fired.",
    "",
    `   Command path:  ${badgeCmd}`,
    "   maxWidth:      <leave blank — badge is already sized via --max-width>",
    "   timeout:       3000",
    "   preserveColors: ON",
    "",
    dim("   (--max-width 40 covers `BATON: ` (7 chars) + ~32 chars of goal title before"),
    dim("   ellipsis; this matches the standalone statusline's default goal budget.)"),
    "",
    bold("2. Baton context-bar") + " — colored against baton's soft/hard thresholds (the same ones that drive nudges).",
    "",
    `   Command path:  ${barCmd}`,
    "   maxWidth:      <leave blank — bar is already sized via --max-width>",
    "   timeout:       3000",
    "   preserveColors: ON",
    "",
    bold("How to add each one in ccstatusline:"),
    "",
    "  1. Run `ccstatusline` in a terminal.",
    "  2. Use the TUI to add a Custom Command widget on the line/position you want.",
    "  3. Paste the command path above into the command field.",
    "  4. Press `t` to set timeout to 3000.",
    "  5. Press `p` to turn ON preserveColors (so baton's threshold colors render).",
    "  6. Save and exit.",
    "",
    "Both widgets read Claude Code's statusline JSON on stdin and emit one line on",
    "stdout. They always exit 0; on error, stderr gets a diagnostic and stdout is",
    "empty (the widget collapses). Drop `--color` from the command path if you'd",
    "rather have ccstatusline's per-widget color settings paint the output.",
    "",
    "If you have not yet pointed ccstatusline at Claude Code:",
    "  Set `statusLine.command` in ~/.claude/settings.json to `ccstatusline`",
    "  (or your preferred invocation form), then re-run `baton install`.",
    "",
  ].join("\n");
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
    case "widget": {
      const widgetName = args[1] ?? "";
      const widgetArgs = args.slice(2);
      const raw = await readStdin();
      await runWidget(widgetName, widgetArgs, raw);
      return 0;
    }
    case "ccstatusline-setup": {
      process.stdout.write(buildCcstatuslineSetup());
      return 0;
    }
    case "ccstatusline-backup": {
      const outIdx = rest.indexOf("--out");
      if (outIdx >= 0 && (rest[outIdx + 1] === undefined || rest[outIdx + 1]?.startsWith("--"))) {
        process.stderr.write("baton ccstatusline-backup: --out requires a path argument\n");
        return 2;
      }
      const out = outIdx >= 0 ? rest[outIdx + 1] : undefined;
      const outcome = backupCcstatusline({ out });
      printCcsBackup(outcome);
      return outcome.sourceExisted ? 0 : 1;
    }
    case "ccstatusline-restore": {
      if (rest.includes("--list")) {
        printCcsList(listCcstatuslineBackups());
        return 0;
      }
      const fromArg = rest.find((a) => !a.startsWith("--"));
      try {
        const result = restoreCcstatusline({ from: fromArg });
        printCcsRestore(result);
        return 0;
      } catch (err) {
        process.stderr.write(`baton ccstatusline-restore: ${(err as Error).message}\n`);
        return 1;
      }
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
