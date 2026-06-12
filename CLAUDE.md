# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

baton is a local-first session baton for coding agents (published as `ccbaton` on npm). The host-neutral contract is `.baton/BATON.md`; Claude Code, Codex CLI, and Gemini CLI are adapters around that file. Claude Code still gets the richest integration: statusline, `UserPromptSubmit`, `PreCompact`, `SessionStart`, and `/baton`, `/drop`, `/baton-codex`, `/baton-gemini`, and `/baton-agent` slash commands in `~/.claude/`.

## Commands

```bash
bun install          # install deps
bun test             # run all tests
bun test test/tokens.test.ts   # run a single test file
bun run build        # bundle to dist/cli.js (Node shebang, portable)
bun run typecheck    # tsc --noEmit
bun run src/cli.ts install --host all  # install from source into supported hosts
```

## Architecture

**Entry point:** `src/cli.ts` — dispatches subcommands (`statusline`, `hook <event>`, `install`, `check`, `uninstall`, `validate`, `status`, `catch`, `drop`, `redact`, `reconstruct`, `list`, `show`, `prune`, `recall`, `sidecar`). Also handles `--version`/`-v`. All subcommands read stdin or CLI args; none are interactive.

**Core modules:**

- `src/config.ts` — shared constants, paths (`userClaudeDir()`, `userSettingsPath()`), threshold values, `VERSION` (read from `package.json` via JSON import), and the self-locating `buildCommand()` that generates hook commands pointing at the current install location (source-mode uses `bun run`, published uses `node`).
- `src/statusline/` — renders the one-line status bar. `render.ts` orchestrates widgets; `widgets.ts` has individual renderers (model, branch, baton badge, rate limit, duration, cost); `bar.ts` draws the context gauge; `color.ts` wraps ANSI codes.
- `src/hooks/` — one file per Claude Code hook event:
  - `user-prompt-submit.ts` — nudges Claude to `/baton` when context crosses soft/hard thresholds (defined in `config.ts`). At the hard threshold, injects the full baton protocol as `assistant_mdm`. Also fires a time-based nudge when session age ≥ 5 hours (`SESSION_AGE_NUDGE_MS`) with at least 30k tokens in context (`SESSION_AGE_NUDGE_MIN_TOKENS`); the time nudge only fires when token pressure is `"none"` and is sent at most once per session via the `timeNudgeSent` flag in the state file.
  - `pre-compact.ts` — intercepts auto-compaction. If a fresh baton exists, blocks compaction. Otherwise writes a fallback baton deterministically from the transcript, then blocks.
  - `session-start.ts` — on `/clear` or resume, reads `BATON.md`, injects it as `additionalContext`, then archives it so the resume is one-shot.
- `src/baton/` — host-neutral baton lifecycle:
  - `archive.ts` — move baton to timestamped archive
  - `archive-library.ts` — `list`, `show`, `prune`, `recall` operations on the archive directory
  - `catch.ts` — CLI resume from nearest `BATON.md`
  - `drop.ts` — discard baton so `/clear` starts fresh
  - `fallback-writer.ts` — deterministic baton written from transcript when `PreCompact` fires without a fresh baton
  - `freshness.ts` — canonical/legacy lookup and freshness calculation
  - `find.ts` — walk up from cwd to locate nearest `BATON.md`
  - `reconstruct.ts` — rebuild a baton from a transcript JSONL file (`reconstruct` subcommand)
  - `redact.ts` — strip secrets from baton body before sending to a sidecar; loads default patterns plus user/project overrides
  - `redact-cmd.ts` — `redact` subcommand: print the nearest BATON.md with secrets stripped
  - `state.ts` — read/write the per-session state file
  - `status.ts` — project baton status and latest archive summary
  - `template-loader.ts` — reads the `/baton` command template
  - `validate.ts` — deterministic baton quality and secret scan checks
- `src/sidecar/` — headless second-opinion runners invoked via `/baton-codex` and `/baton-gemini`:
  - `run.ts` — shared orchestration: finds and redacts the baton, picks the host adapter, spawns the subprocess, streams output. Exposes `runSidecar({ host, mode, cwd, dryRun })` and the `HostAdapter` interface.
  - `prompts.ts` — defines `SidecarMode` (`review` | `critique` | `alternative`), per-mode preambles, and `composePrompt()` which prepends the preamble to the redacted baton body.
  - `codex.ts` — `codexAdapter`: invokes `codex exec -c model_reasoning_effort=xhigh --sandbox read-only --ephemeral -`, sending the prompt on stdin.
  - `gemini.ts` — `geminiAdapter`: sends the baton body on stdin with a short `--prompt` instruction (`--model pro --approval-mode plan`); Gemini appends `--prompt` to stdin input in headless mode. Keeping the baton off argv avoids `ps` exposure and Windows command-line length limits.
- `src/transcript/` — `read.ts` parses JSONL transcripts; `tokens.ts` extracts token snapshots from the latest assistant usage entry.
- `src/install/settings-patch.ts` — installs host adapters. Claude patching remains idempotent (`~/.claude/settings.json`, slash commands, statusline, backups, migration). Codex writes a managed hook block to `~/.codex/config.toml` plus `~/.agents/skills/baton/SKILL.md`. Gemini writes `~/.gemini/extensions/baton` with commands, context, and `hooks/hooks.json`. Also exports multi-host `installHosts()`, `checkHosts()`, and `uninstallHosts()`.

**Build:** `scripts/build.ts` uses `bun build` targeting Node, replaces the shebang, and copies `src/baton/template.md` to `dist/baton/template.md`.

## Key Design Decisions

- **Self-locating commands:** `buildCommand()` in `config.ts` generates absolute paths so hooks survive across `npx`/`bunx` exits. Source installs use `bun run .../cli.ts`; published installs use `node .../cli.js`.
- **Idempotent install:** `install()` is safe to run repeatedly — it detects existing hooks/statusline by command string, prunes stale entries pointing at old paths, and only writes files when content changed.
- **PreCompact blocks, with an escape hatch:** The hook outputs `{ decision: "block" }` — either because a fresh baton exists, or after writing a fallback — and counts consecutive blocks in the per-session state file. After `MAX_COMPACT_BLOCKS` ignored blocks (default 3, env `BATON_MAX_COMPACT_BLOCKS`), it allows compaction (empty stdout) and resets the counter, so an unattended session degrades to normal auto-compact instead of context-limit errors.
- **Transcript format:** Claude Code transcripts are JSONL, and the parser also accepts broader top-level `usage`/`tokens` shapes for Codex/Gemini-style fixtures. Only main-chain entries (not sidechain, not API errors) are used for token counting when those fields exist.
- **Token counting uses last usage entry only:** The most recent usage-bearing entry represents current context size. Summing all entries would double-count cached tokens.
- **Freshness window:** `BATON_FRESH_MS` (default 10 min, configurable via env) gates whether `SessionStart` injects and whether `PreCompact` considers an existing baton sufficient.
- **Hard-nudge re-arm:** The hard nudge injects the full baton protocol once, but if Claude doesn't act on it the session stays pinned at hard with no further signal. The hook counts prompts at hard (`promptsAtHard` in session state) and re-injects every `HARD_NUDGE_REARM_PROMPTS` (default 5, env `BATON_HARD_NUDGE_REARM_PROMPTS`).
- **Per-model nudge thresholds:** `nudgeThresholdsForModel()` in `config.ts` scales `NUDGE_SOFT`/`NUDGE_HARD` down for Sonnet (0.50/0.55) and Haiku (0.45/0.50), whose long-context quality degrades earlier. The statusline persists `modelId` to the session state file; the `UserPromptSubmit` hook reads it. `BATON_NUDGE_SOFT`/`BATON_NUDGE_HARD` env vars override per-model scaling.
- **State normalization:** The statusline writes `{ maxTokens }` to the per-session state file without a `level` field. `readState()` in `user-prompt-submit.ts` explicitly normalizes missing or invalid `level` values to `"none"`. Without this, a statusline-written state causes the soft nudge to silently skip — users jump straight to the hard-stop.
- **Sidecar host adapter pattern:** `run.ts` defines a `HostAdapter` interface (`binaryName`, `installHint`, `buildInvocation`). Each host (`codex.ts`, `gemini.ts`) exports a single adapter constant. Adding a new host requires only a new adapter file and a branch in `pickAdapter()` — no changes to the shared orchestration.
- **Canonical path with legacy read:** New writes use `.baton/BATON.md`; lookup also reads legacy `.claude/baton/BATON.md` for compatibility.
- **Shared user state:** New archives, state files, template overrides, redaction config, and install manifests live under `~/.baton/`, while legacy Claude paths are read for one release.
- **Sidecar redaction before send:** `run.ts` redacts the baton body using patterns from `src/baton/redact.ts` before constructing the prompt. Default patterns plus user (`~/.baton/ignore`, `~/.batonredact`, legacy `~/.claude/baton-ignore`) and project (`.batonignore`, `.batonredact`) overrides are all applied. Redaction count is printed to stderr so the user knows secrets were stripped.
- **Backup collision avoidance:** `backup()` in `settings-patch.ts` appends an incrementing numeric suffix (e.g. `-1`, `-2`) if the timestamped backup path already exists. This prevents silent overwrites when `install()` is called multiple times within the same second.
- **Output via explicit streams:** Use `process.stdout.write` / `process.stderr.write`, never `console.*`. baton runs as hooks whose stdout is parsed as protocol (JSON decisions, `additionalContext`), so a stray `console.log` corrupts it; standardizing on explicit streams keeps the stdout/stderr split unambiguous and gives exact control over bytes and newlines. Human-facing messages and warnings go to stderr.

## Testing

Tests use Bun's built-in test runner. Test files live in `test/` and use temp directories via `mkdtempSync`. Fixtures in `test/fixtures.ts` generate synthetic JSONL transcripts. Helper utilities are in `test/helpers/`.

No mocking framework — tests write real files to temp dirs and invoke the actual functions.

## Platform Notes

- Windows paths are normalized with `.replace(/\\/g, "/")` in `cliPath()` for shell compatibility.
- `chmod` in the build script is best-effort (no-op on Windows).
- `userHomeDir()` prefers `USERPROFILE` on win32, `HOME` otherwise.
