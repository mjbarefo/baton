# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

baton is a Claude Code plugin (published as `ccbaton` on npm) that snapshots session state into a structured `BATON.md` so a fresh `/clear` session can resume without context rot. It installs a statusline, three hooks (`UserPromptSubmit`, `PreCompact`, `SessionStart`), and `/baton` + `/drop` slash commands into `~/.claude/`.

## Commands

```bash
bun install          # install deps
bun test             # run all tests
bun test test/tokens.test.ts   # run a single test file
bun run build        # bundle to dist/cli.js (Node shebang, portable)
bun run typecheck    # tsc --noEmit
bun run src/cli.ts install     # install from source into ~/.claude/
```

## Architecture

**Entry point:** `src/cli.ts` — dispatches subcommands (`statusline`, `hook <event>`, `install`, `catch`, `drop`). All subcommands read stdin or CLI args; none are interactive.

**Core modules:**

- `src/config.ts` — shared constants, paths (`userClaudeDir()`, `userSettingsPath()`), threshold values, and the self-locating `buildCommand()` that generates hook commands pointing at the current install location (source-mode uses `bun run`, published uses `node`).
- `src/statusline/` — renders the one-line status bar. `render.ts` orchestrates widgets; `widgets.ts` has individual renderers (model, branch, baton badge, rate limit, duration, cost); `bar.ts` draws the context gauge; `color.ts` wraps ANSI codes.
- `src/hooks/` — one file per Claude Code hook event:
  - `user-prompt-submit.ts` — nudges Claude to `/baton` when context crosses soft/hard thresholds (defined in `config.ts`). At the hard threshold, injects the full baton protocol as `assistant_mdm`. Also fires a time-based nudge when session age ≥ 5 hours (`SESSION_AGE_NUDGE_MS`) with at least 30k tokens in context (`SESSION_AGE_NUDGE_MIN_TOKENS`); the time nudge only fires when token pressure is `"none"` and is sent at most once per session via the `timeNudgeSent` flag in the state file.
  - `pre-compact.ts` — intercepts auto-compaction. If a fresh baton exists, blocks compaction. Otherwise writes a fallback baton deterministically from the transcript, then blocks.
  - `session-start.ts` — on `/clear` or resume, reads `BATON.md`, injects it as `additionalContext`, then archives it so the resume is one-shot.
- `src/baton/` — baton lifecycle: `archive.ts` (move to timestamped archive), `catch.ts` (CLI resume), `drop.ts` (discard baton), `fallback-writer.ts` (deterministic baton from transcript), `template-loader.ts` (reads the `/baton` command template).
- `src/transcript/` — `read.ts` parses JSONL transcripts; `tokens.ts` extracts token snapshots from the latest assistant usage entry.
- `src/install/settings-patch.ts` — patches `~/.claude/settings.json` idempotently: merges hooks, sets statusline, writes skill + command files, prunes stale entries, migrates old "handoff" artifacts. Backs up settings before modifying.

**Build:** `scripts/build.ts` uses `bun build` targeting Node, replaces the shebang, and copies `src/baton/template.md` to `dist/baton/template.md`.

## Key Design Decisions

- **Self-locating commands:** `buildCommand()` in `config.ts` generates absolute paths so hooks survive across `npx`/`bunx` exits. Source installs use `bun run .../cli.ts`; published installs use `node .../cli.js`.
- **Idempotent install:** `install()` is safe to run repeatedly — it detects existing hooks/statusline by command string, prunes stale entries pointing at old paths, and only writes files when content changed.
- **PreCompact blocks, never allows:** The hook always outputs `{ decision: "block" }` — either because a fresh baton exists, or after writing a fallback. It never returns `"allow"`.
- **Transcript format:** Claude Code transcripts are JSONL. Each line has `type`, `isSidechain`, `isApiErrorMessage`, and `message` with standard Claude API fields. Only main-chain entries (not sidechain, not API errors) are used for token counting.
- **Token counting uses last assistant entry only:** The most recent main-chain assistant message's `usage` field represents current context size. Summing all entries would double-count cached tokens.
- **Freshness window:** `BATON_FRESH_MS` (default 10 min, configurable via env) gates whether `SessionStart` injects and whether `PreCompact` considers an existing baton sufficient.
- **State normalization:** The statusline writes `{ maxTokens }` to the per-session state file without a `level` field. `readState()` in `user-prompt-submit.ts` explicitly normalizes missing or invalid `level` values to `"none"`. Without this, a statusline-written state causes the soft nudge to silently skip — users jump straight to the hard-stop.

## Testing

Tests use Bun's built-in test runner. Test files live in `test/` and use temp directories via `mkdtempSync`. Fixtures in `test/fixtures.ts` generate synthetic JSONL transcripts. Helper utilities are in `test/helpers/`.

No mocking framework — tests write real files to temp dirs and invoke the actual functions.

## Platform Notes

- Windows paths are normalized with `.replace(/\\/g, "/")` in `cliPath()` for shell compatibility.
- `chmod` in the build script is best-effort (no-op on Windows).
- `userHomeDir()` prefers `USERPROFILE` on win32, `HOME` otherwise.
