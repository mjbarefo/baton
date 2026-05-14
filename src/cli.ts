#!/usr/bin/env bun
import { renderStatusline } from "./statusline/render.ts";
import { runUserPromptSubmitHook } from "./hooks/user-prompt-submit.ts";
import { runPreCompactHook } from "./hooks/pre-compact.ts";
import { runSessionStartHook } from "./hooks/session-start.ts";
import {
  check,
  checkHosts,
  install,
  installHosts,
  printCheckReport,
  printMultiHostCheckReport,
  printMultiHostInstallReport,
  printMultiHostUninstallReport,
  printReport,
  printUninstallReport,
  uninstall,
  uninstallHosts,
  type HostSelection,
} from "./install/settings-patch.ts";
import { VERSION } from "./config.ts";
import { catchBaton } from "./baton/catch.ts";
import { drop } from "./baton/drop.ts";
import { runReconstruct } from "./baton/reconstruct.ts";
import { runValidate } from "./baton/validate.ts";
import { batonStatus, printBatonStatus } from "./baton/status.ts";
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
      `baton v${VERSION} — context-aware session baton for coding agents`,
      "",
      "  npx ccbaton@latest          install or upgrade",
      "  npx ccbaton check           verify current install",
      "  npx ccbaton uninstall       remove",
      "",
      "Subcommands:",
      "  install [--host claude|codex|gemini|all] [--dry-run] [--force]",
      "                              install host-native baton integration",
      "                              --force replaces an existing non-baton statusLine",
      "  uninstall [--host claude|codex|gemini|all]   remove host integration",
      "  check [--host claude|codex|gemini|all] [--json]  show install status",
      "  validate [path] [--json] [--strict]  validate a BATON.md",
      "  status [--json]             show project baton status",
      "  catch [--host claude|codex|gemini] [--dry-run]  resume from BATON.md",
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

function flagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  const value = args[idx + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function hostSelection(args: string[], allowAll = true): HostSelection | null {
  const raw = flagValue(args, "--host");
  if (!raw) return "claude";
  if (raw === "claude" || raw === "codex" || raw === "gemini") return raw;
  if (allowAll && raw === "all") return raw;
  return null;
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
      const dryRun = args.includes("--dry-run");
      const host = hostSelection(args);
      if (!host) {
        process.stderr.write("baton install: --host must be claude, codex, gemini, or all\n");
        return 2;
      }
      if (postinstall && host !== "claude") {
        process.stderr.write("baton install: --postinstall is only valid for --host claude (or no --host)\n");
        return 2;
      }
      if (postinstall) {
        try {
          const report = install({ force, postinstall });
          printReport(report);
        } catch (err) {
          process.stderr.write(`baton: postinstall failed (non-fatal): ${String(err)}\n`);
        }
        return 0;
      }
      if (host !== "claude" || dryRun) {
        const report = installHosts({ host, force, dryRun });
        printMultiHostInstallReport(report);
        return 0;
      }
      const report = install({ force, postinstall });
      printReport(report);
      return 0;
    }
    case "check": {
      const json = args.includes("--json");
      const host = hostSelection(args);
      if (!host) {
        process.stderr.write("baton check: --host must be claude, codex, gemini, or all\n");
        return 2;
      }
      if (host !== "claude" || json) {
        const report = checkHosts(host);
        if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        else printMultiHostCheckReport(report);
        return report.allPresent ? 0 : 1;
      }
      const report = check();
      printCheckReport(report);
      return report.allPresent ? 0 : 1;
    }
    case "uninstall": {
      const host = hostSelection(args);
      if (!host) {
        process.stderr.write("baton uninstall: --host must be claude, codex, gemini, or all\n");
        return 2;
      }
      if (host !== "claude") {
        const report = uninstallHosts(host);
        printMultiHostUninstallReport(report);
        return 0;
      }
      const report = uninstall();
      printUninstallReport(report);
      return 0;
    }
    case "catch": {
      const dryRun = rest.includes("--dry-run");
      const host = hostSelection(args, false);
      if (!host || host === "all") {
        process.stderr.write("baton catch: --host must be claude, codex, or gemini\n");
        return 2;
      }
      return await catchBaton({ cwd: process.cwd(), dryRun, host });
    }
    case "validate": {
      return runValidate(args.slice(1), process.cwd());
    }
    case "status": {
      const json = rest.includes("--json");
      const report = batonStatus(process.cwd());
      if (json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      else printBatonStatus(report);
      return report.baton.exists ? 0 : 1;
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
