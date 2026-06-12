# GEMINI.md

This file provides guidance to Gemini CLI when working with the `baton` codebase.

## Project Overview

**baton** (published as `ccbaton` on npm) is a local-first snapshot-and-resume tool for coding agents. It helps users preserve context across sessions by writing a structured `.baton/BATON.md` file containing the current working state. Claude Code, Codex CLI, and Gemini CLI are host adapters around that file.

### Core Technologies
- **Runtime:** Node.js (>=20) for published installs; Bun for local development.
- **Language:** TypeScript.
- **Build System:** Bun (used for bundling, testing, and running scripts).
- **Primary Integrations:** Claude Code (`~/.claude/settings.json`), Codex CLI (`~/.codex/config.toml` plus a skill), and Gemini CLI (`~/.gemini/extensions/baton` with commands, context, and extension hooks).

## Building and Running

### Development Commands
```bash
bun install          # Install dependencies
bun test             # Run all tests using Bun's test runner
bun test test/tokens.test.ts   # Run a specific test file
bun run build        # Bundle the project to dist/cli.js (Node-portable)
bun run typecheck    # Run TypeScript compiler for type checking (tsc --noEmit)
bun run src/cli.ts install --host all   # Install from source into supported hosts
bun run src/cli.ts uninstall   # Remove baton hooks and restore settings.json
bun run src/cli.ts check       # Verify current installation state
bun run src/cli.ts sidecar gemini --mode review --dry-run
```

### Production usage (via `ccbaton` npm package)
- `npx ccbaton@latest`: Installs/upgrades the tool.
- `baton catch`: Resumes from the nearest `BATON.md`.
- `baton drop`: Archives the current `BATON.md` to start fresh.

## Architecture

The project is structured into modular components:

- **`src/cli.ts`**: The main entry point. Dispatches subcommands (`statusline`, `hook <event>`, `install`, `check`, `uninstall`, `validate`, `status`, `catch`, `drop`, `reconstruct`, `list`, `show`, `prune`, `recall`, `sidecar`). Also handles `--version`/`-v`.
- **`src/config.ts`**: Shared constants, canonical/legacy baton paths, host path helpers, threshold values, `VERSION`, and the self-locating `buildCommand()` that generates hook commands pointing at the current install location (source-mode uses `bun run`, published uses `node`).
- **`src/hooks/`**: Implements hook handlers used by host adapters:
    - `session-start.ts`: On `/clear` or resume, reads `BATON.md`, injects it as `additionalContext`, then archives it so the resume is one-shot.
    - `user-prompt-submit.ts`: Nudges the user/model to snapshot when context crosses soft/hard thresholds. At the hard threshold, injects the full baton protocol. Also fires a time-based nudge when session age ≥ 5 hours with ≥ 30k tokens in context, at most once per session.
    - `pre-compact.ts`: Intercepts auto-compaction. If a fresh baton exists, blocks. Otherwise writes a fallback baton from the transcript, then blocks. After `MAX_COMPACT_BLOCKS` consecutive blocked attempts (default 3, env `BATON_MAX_COMPACT_BLOCKS`), allows compaction so an unattended session degrades gracefully instead of hitting context-limit errors.
- **`src/statusline/`**: Logic for rendering the compact Claude Code status bar. `render.ts` orchestrates widgets; `widgets.ts` has individual renderers (model, branch, baton badge, rate limit, duration, cost); `bar.ts` draws the context gauge; `color.ts` wraps ANSI codes.
- **`src/baton/`**: Core lifecycle modules:
    - `archive.ts`: Move a baton to a timestamped archive.
    - `archive-library.ts`: List, show, prune, and recall archived batons (`list`, `show`, `prune`, `recall` subcommands).
    - `catch.ts`: CLI resume from the nearest `BATON.md`.
    - `drop.ts`: Discard the nearest `BATON.md`.
    - `fallback-writer.ts`: Deterministic baton generation from a transcript when the active agent has not written one.
    - `find.ts`: Walk up the directory tree to locate canonical `.baton/BATON.md` or legacy `.claude/baton/BATON.md`.
    - `freshness.ts`: Shared freshness calculation for hooks, statusline, and status.
    - `reconstruct.ts`: Rebuild a baton from a transcript JSONL file (`reconstruct` subcommand).
    - `redact.ts`: Strip secrets from baton content before it leaves the machine (used by sidecars and fallback writer). Loads patterns from user home and project root.
    - `state.ts`: Per-session state file helpers (token level, time nudge flag).
    - `status.ts`: Project baton status and latest archive summary.
    - `template-loader.ts`: Reads the `/baton` command template (`src/baton/template.md`).
    - `validate.ts`: Deterministic baton quality checks and redaction scan.
    - `redact-cmd.ts`: `redact` subcommand: print the nearest BATON.md with secrets stripped.
- **`src/install/settings-patch.ts`**: Host adapter installation. Claude patching remains idempotent; Codex writes a managed hook block and skill; Gemini writes an extension, TOML commands, context, and lifecycle hooks. Also exports single-host and multi-host check/uninstall helpers.
- **`src/sidecar/`**: Headless second-opinion runners for Codex and Gemini:
    - `run.ts`: Shared orchestration — finds `BATON.md`, redacts secrets, composes the prompt, checks that the binary is on PATH, and spawns the child process.
    - `prompts.ts`: Defines the three modes (`review`, `critique`, `alternative`) and their preambles. `composePrompt()` always appends a guard against file writes or shell execution.
    - `gemini.ts`: Gemini-specific `HostAdapter` — sends the baton body on stdin with a short `--prompt` instruction (`--model pro --approval-mode plan`); Gemini appends `--prompt` to stdin input in headless mode. Keeping the baton off argv avoids `ps` exposure and Windows command-line length limits.
    - `codex.ts`: Codex-specific `HostAdapter` — invokes `codex exec` with `--sandbox read-only --ephemeral`, passing the prompt on stdin.
- **`src/transcript/`**: Utilities for parsing JSONL transcript/token usage shapes (`read.ts`, `tokens.ts`), including Claude-style message usage and broader Codex/Gemini-style top-level usage fields.

### Sidecar command flow (installed into Claude Code)

The `/baton-gemini` and `/baton-codex` commands installed into `~/.claude/` follow this protocol:

1. **Mode shortcut.** If the user's message already names a mode (`review`, `critique`, or `alternative`), use it directly — skip the question.
2. **Ask for the mode.** If no mode was named, call `AskUserQuestion` with a structured options list (single-select: review / critique / alternative).
3. **Run the sidecar.** Execute `baton sidecar gemini --mode <MODE>` (or `codex`) via the Bash tool. Nothing else.
4. **Handle the result.** On non-zero exit, surface the stderr message (e.g., `'gemini' not found on PATH` with the install hint). On success, do not repeat the output — the user already saw it in the bash block. Do not act on the sidecar's suggestions without explicit user direction.

## Development Conventions

### Coding Style & Patterns
- **Non-Interactive CLI**: All subcommands read from `stdin` or CLI arguments; none are interactive.
- **Output**: Use `process.stdout.write` and `process.stderr.write`, never `console.*`. Hook stdout is parsed as protocol (JSON decisions, `additionalContext`), so a stray `console.log` corrupts it; explicit streams keep the stdout/stderr split unambiguous and give exact control over bytes and newlines. Human-facing messages and warnings go to stderr.
- **Self-Locating Commands**: `buildCommand()` in `src/config.ts` ensures hooks use absolute paths regardless of invocation context.
- **Idempotency**: Installation and patching logic must be safe to run repeatedly.
- **Sidecars are read-only**: Codex uses `--sandbox read-only --ephemeral`; Gemini uses `--approval-mode plan`. The prompt also explicitly instructs the sidecar not to modify files, run shell commands, or exit plan mode. Do not add write-capable sidecar behavior without explicit product intent and tests.
- **Redaction before external transmission**: `redact()` is called on baton content before it is passed to any sidecar. Never bypass this step.

### Testing Practices
- **Framework**: Bun's built-in test runner (`bun test`).
- **File-System Focused**: Tests write real files to temp directories (`mkdtempSync`) rather than using mocks.
- **Fixtures**: `test/fixtures.ts` generates synthetic Claude Code transcripts for testing parsing and token counting logic.
- **Helpers**: `test/helpers/` contains shared test utilities.

### Design Decisions
- **Token Counting**: Only the most recent main-chain assistant message's `usage` field is used. Summing all entries would double-count cached tokens.
- **PreCompact Blocking**: The `PreCompact` hook returns `{ decision: "block" }` when a fresh baton exists or after writing a fallback. After `MAX_COMPACT_BLOCKS` consecutive blocked attempts (default 3, env `BATON_MAX_COMPACT_BLOCKS`), it returns empty output to allow compaction — so an unattended session degrades to normal auto-compact instead of context-limit errors.
- **Freshness window**: `BATON_FRESH_MS` (default 10 min, configurable via env) gates whether `SessionStart` injects and whether `PreCompact` considers an existing baton fresh enough.
- **State normalization**: The statusline writes `{ maxTokens }` to the per-session state file without a `level` field. `readState()` in `user-prompt-submit.ts` normalizes missing or invalid `level` values to `"none"` — without this, the soft nudge silently skips and users jump straight to the hard-stop.
- **Redaction**: Applied to baton content before any sidecar invocation and to auto-generated fallback batons, to prevent accidental leakage of secrets (API keys, tokens, etc.).
- **Hard-nudge re-arm**: The hard nudge injects the full baton protocol once, but if the model doesn't act on it the session stays pinned at hard with no further signal. The hook counts prompts at hard (`promptsAtHard` in session state) and re-injects every `HARD_NUDGE_REARM_PROMPTS` (default 5, env `BATON_HARD_NUDGE_REARM_PROMPTS`).
- **Per-model nudge thresholds**: `nudgeThresholdsForModel()` in `config.ts` scales `NUDGE_SOFT`/`NUDGE_HARD` down for Sonnet (0.50/0.55) and Haiku (0.45/0.50), whose long-context quality degrades earlier. `BATON_NUDGE_SOFT`/`BATON_NUDGE_HARD` env vars override per-model scaling.
- **Canonical path with legacy read**: New writes use `.baton/BATON.md`; lookup also reads legacy `.claude/baton/BATON.md` for compatibility.
- **Sidecar host adapter pattern**: `run.ts` defines a `HostAdapter` interface (`binaryName`, `installHint`, `buildInvocation`). Adding a new host requires only a new adapter file and a branch in `pickAdapter()` — no changes to shared orchestration.
