<p align="center">
  <img src="assets/mascot.png" alt="baton mascot — a small pixel-art runner with a green headband carrying a baton" width="128">
</p>

<h1 align="center">baton</h1>

<p align="center">
  <em>Snapshot-and-resume for Claude Code sessions. Never lose context to auto-compaction again.</em>
</p>

baton is a Claude Code session snapshot and handoff tool. It writes the current working state into a structured `BATON.md` so a fresh Claude Code session can resume with the goal, recent decisions, active files, gotchas, and next concrete action intact instead of relying on degraded compacted context.

## Prerequisites

- Node.js `>=20`
- Claude Code

Bun is only required for local development from this repository.

## Install

```bash
npx ccbaton@latest
```

Or with Bun:

```bash
bunx ccbaton@latest
```

The installer patches `~/.claude/settings.json` with self-locating commands that keep working after `npx`/`bunx` exits. Published installs use the bundled Node.js CLI; source-tree installs use `bun run src/cli.ts`.

If you install globally (`npm install -g ccbaton`), the `postinstall` script runs the installer automatically.

What gets installed:

- a statusline command
- `UserPromptSubmit`, `PreCompact`, and `SessionStart` hooks
- `/baton` and `/drop` slash commands
- the baton skill at `~/.claude/skills/baton/SKILL.md`

After installing, restart Claude Code. If the installer warns that `~/.claude/skills/` was newly created, a full restart is required before the `/baton` skill is available.

## Daily Flow

Use `/baton` when you reach a natural stopping point. Claude writes `.claude/baton/BATON.md` with the current session state.

Use `/clear` to start a clean session that automatically resumes from the baton. The `SessionStart` hook injects the baton into context, then archives it so the resume is one-shot.

Use `/drop` before `/clear` when you want to discard the pending baton and start completely fresh.

Use `baton catch` when the original session or terminal is already gone but `.claude/baton/BATON.md` still exists. If installed from the renamed package binary, use `baton catch`.

```bash
baton catch
baton catch --dry-run
```

## Statusline

The statusline shows model, branch, context usage, baton state, rate limit, duration, and cost in one compact row:

```text
Sonnet 4.5 │ main* │ [======----] 82k/200k │ BATON: Refactor settings-patch │ 5h 71% │ 12m │ $1.24
```

When context gets high, baton nudges Claude to snapshot. At the hard threshold, it injects the baton protocol directly so Claude writes the baton before auto-compaction can discard useful state. When the 5-hour rate-limit is above 90%, baton escalates the hard nudge earlier so you snapshot before hitting the wall.

## Configuration

`BATON_FRESH_MS` controls how long an existing `BATON.md` is considered fresh. The default is ten minutes:

```bash
BATON_FRESH_MS=1800000 claude
```

`SESSION_AGE_NUDGE_MS` controls the session-age nudge threshold. After 5 hours in a session with at least 30k tokens in context, baton suggests a snapshot even if token pressure is low. Configurable if you prefer a different window:

```bash
SESSION_AGE_NUDGE_MS=10800000 claude  # nudge after 3 hours instead
```

### Custom baton template

Create `~/.claude/baton-template.md` to override the default baton skeleton. The file must start with frontmatter:

```yaml
---
name: baton
description: Your description
---
```

To add sections instead of fully replacing, include `<!-- baton:extend -->` in your file — the bundled template body is spliced in at that point.

Re-run `npx ccbaton` to apply changes.

### Redaction

The PreCompact fallback baton (written when auto-compact was about to fire and no fresh `/baton` existed) is passed through a redaction step before writing to disk. Default patterns cover common API keys, AWS/GitHub tokens, JWTs, and bearer headers.

Add custom patterns to:
- `~/.claude/baton-ignore` — user-level, applied to every project
- `.batonignore` — project-level, applied to the current cwd only

Format: one regex per line, `#` for comments, optional `LABEL:::REGEX` to name the pattern. Empty lines ignored.

Redaction only applies to the fallback writer, not to Claude-authored `/baton` output. Don't paste secrets into your own batons.

To disable entirely (not recommended): `BATON_NO_REDACT=1`.

### Recovering from a lost baton

If you lost a baton but still have the transcript (Claude Code writes them to `~/.claude/projects/<slug>/<session-id>.jsonl`), you can rebuild a best-effort baton:

```bash
baton reconstruct ~/.claude/projects/my-project/abc123.jsonl
```

By default this writes to `<cwd>/.claude/baton/BATON.md`. Use `--out` for a custom location. The rebuilt baton uses the same fallback format as the PreCompact auto-write — deterministic, less structured than a Claude-authored baton, but enough to resume.

## Commands

```bash
npx ccbaton@latest          # install or upgrade
npx ccbaton check           # verify current install state (exits 1 if anything missing)
npx ccbaton uninstall       # remove hooks, statusline, commands; restore settings.json from backup
```

After installing globally, the `baton` binary is available directly:

```bash
baton --version
baton install [--force]     # --force replaces a non-baton statusLine
baton uninstall
baton check
baton catch [--dry-run]
baton drop
```

## Development

Bun is used to run tests and build the npm package:

```bash
bun install
bun test
bun run build
bun run src/cli.ts install
```

The package binary is `baton`; `bun run build` writes the portable Node.js CLI to `dist/cli.js` with a Node shebang for npm/npx execution.

## Migrating From Handoff To Baton

- In-flight `.claude/baton/HANDOFF.md` files can be renamed to `BATON.md` manually and will be picked up by the `SessionStart` hook as usual.
- The installer automatically removes old `~/.claude/commands/handoff*.md` and `~/.claude/skills/handoff/` on next install.
