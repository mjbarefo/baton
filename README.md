<p align="center">
  <img src="assets/mascot.png" alt="baton mascot — a small pixel-art runner with a green headband carrying a baton" width="128">
</p>

<h1 align="center">baton</h1>

<p align="center">
  <em>Local-first snapshot-and-resume for coding agents.</em>
</p>

baton writes the current working state into a structured `.baton/BATON.md` so a fresh Claude Code, Codex CLI, or Gemini CLI session can resume with the goal, recent decisions, active files, gotchas, and next concrete action intact.

The baton file is the host-neutral contract. Claude Code, Codex CLI, and Gemini CLI are adapters around that contract.

## Prerequisites

- Node.js `>=20`
- At least one supported host: Claude Code, Codex CLI, or Gemini CLI

Bun is only required for local development from this repository.

## Install

```bash
npx ccbaton@latest
```

Or with Bun:

```bash
bunx ccbaton@latest
```

The default install remains Claude-compatible:

```bash
baton install
```

Install host-native integrations explicitly:

```bash
baton install --host claude
baton install --host codex
baton install --host gemini
baton install --host all
baton install --dry-run --host all
```

What gets installed:

| Host | Integration | Notes |
| --- | --- | --- |
| Claude Code | statusline, `UserPromptSubmit`, `PreCompact`, `SessionStart`, `/baton`, `/drop`, `/baton-codex`, `/baton-gemini` | Closest parity. Claude remains the only host with `PreCompact` fallback blocking. |
| Codex CLI | `~/.codex/config.toml` hooks plus a baton skill in `~/.agents/skills/baton/` | Supports native resume/nudge surfaces where hooks are available. |
| Gemini CLI | `~/.gemini/extensions/baton` extension with commands, context, and lifecycle hooks | Uses Gemini extension and command surfaces. |

## Daily Flow

Use the host-native baton command when you reach a stopping point. The agent writes `.baton/BATON.md`, runs `baton validate`, and stops.

Use a fresh session to resume. Where the host supports session-start hooks, baton injects the pending baton into context and archives it so the resume is one-shot.

Use `baton catch` when the original session or terminal is gone but `.baton/BATON.md` still exists:

```bash
baton catch --host claude
baton catch --host codex
baton catch --host gemini
baton catch --dry-run --host codex
```

Use `baton drop` before starting fresh when you want to discard the pending baton.

Use sidecars when you want a read-only second opinion on the current baton:

```bash
baton sidecar codex --mode review
baton sidecar gemini --mode critique
baton sidecar codex --mode alternative --dry-run
```

Sidecars are review tools. They receive a redacted baton, run in read-only or plan mode, and are instructed not to modify files or run commands.

## Baton Files

The canonical project baton path is:

```text
.baton/BATON.md
```

For one release, baton also reads the legacy Claude path:

```text
.claude/baton/BATON.md
```

New writes use `.baton/BATON.md`. Shared user state now lives under `~/.baton/`; legacy `~/.claude/baton/*`, `~/.claude/baton-template.md`, and `~/.claude/baton-ignore` are still read for compatibility.

## Status And Validation

```bash
baton status
baton status --json
baton validate
baton validate .baton/BATON.md
baton validate --strict --json
baton check --host all
baton check --host all --json
```

Validation checks that required sections appear exactly once, the current goal and next action are concrete, active work has a valid state, recent test/build state is explicit, and secret-like content is not present.

## Configuration

`BATON_FRESH_MS` controls how long an existing `BATON.md` is considered fresh. The default is ten minutes:

```bash
BATON_FRESH_MS=1800000 claude
```

`SESSION_AGE_NUDGE_MS` controls the session-age nudge threshold. After 5 hours in a session with at least 30k tokens in context, baton suggests a snapshot even if token pressure is low:

```bash
SESSION_AGE_NUDGE_MS=10800000 claude
```

### Nudge thresholds

The soft and hard nudges fire at ratios of the model's context window. Defaults are 0.55 (soft) and 0.60 (hard), but models with weaker long-context robustness are nudged earlier: Sonnet at 0.50/0.55, Haiku at 0.45/0.50. The model is detected automatically from the statusline payload.

`BATON_NUDGE_SOFT` and `BATON_NUDGE_HARD` override the ratios globally (a value strictly between 0 and 1); an explicit env setting wins over per-model scaling:

```bash
BATON_NUDGE_SOFT=0.45 BATON_NUDGE_HARD=0.50 claude
```

`BATON_MAX_COMPACT_BLOCKS` controls the PreCompact escape hatch: after this many consecutive blocked auto-compact attempts in one session (default 3), baton stops intercepting and lets auto-compact run rather than risking context-limit errors.

### Custom baton template

Create `~/.baton/template.md` to override the default baton skeleton. The legacy `~/.claude/baton-template.md` path is still read for compatibility.

The file must start with frontmatter:

```yaml
---
name: baton
description: Your description
---
```

To add sections instead of fully replacing, include `<!-- baton:extend -->` in your file. The bundled template body is spliced in at that point.

### Redaction

Fallback batons and sidecar prompts are passed through a redaction step before writing or external CLI execution. Default patterns cover common API keys, AWS/GitHub tokens, JWTs, and bearer headers.

Add custom patterns to:

- `~/.baton/ignore` or `~/.batonredact` — user-level, applied to every project
- `.batonignore` or `.batonredact` — project-level, applied to the current project

The legacy `~/.claude/baton-ignore` file is still read for compatibility.

Run `baton redact` to print the nearest BATON.md with secrets stripped — useful for piping a sanitized baton to other tools.

Format: one regex per line, `#` for comments, optional `LABEL:::REGEX` to name the pattern. Empty lines are ignored.

To disable entirely, use `BATON_NO_REDACT=1`.

## Recovery

If you lost a baton but still have a transcript, rebuild a best-effort baton:

```bash
baton reconstruct path/to/session.jsonl
```

By default this writes to `<cwd>/.baton/BATON.md`. Use `--out` for a custom location. The rebuilt baton uses the same deterministic fallback format as the auto-write.

Archived batons are stored in `~/.baton/archive/`; legacy `~/.claude/baton/archive/` entries are still listed:

```bash
baton list
baton show <id|prefix>
baton recall <query>
baton prune --older-than-days 30 --keep 50
```

## Commands

```bash
npx ccbaton@latest
npx ccbaton check --host all
npx ccbaton uninstall --host all

baton --version
baton install [--host claude|codex|gemini|all] [--dry-run] [--force]
baton uninstall [--host claude|codex|gemini|all]
baton check [--host claude|codex|gemini|all] [--json]
baton status [--json]
baton validate [path] [--json] [--strict]
baton catch [--host claude|codex|gemini] [--dry-run]
baton drop
baton sidecar codex|gemini --mode review|critique|alternative [--dry-run]
```

## Development

Bun is used to run tests and build the npm package:

```bash
bun install
bun test
bun run build
bun run src/cli.ts install --host all
```

The package binary is `baton`; `bun run build` writes the portable Node.js CLI to `dist/cli.js` with a Node shebang for npm/npx execution.

## Migrating From Handoff To Baton

- In-flight `.baton/HANDOFF.md` files can be renamed to `BATON.md` manually and will be picked up by the `SessionStart` hook as usual.
- The installer automatically removes old `~/.claude/commands/handoff*.md` and `~/.claude/skills/handoff/` on next Claude install.
