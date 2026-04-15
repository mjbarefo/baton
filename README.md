# baton

baton is a Claude Code session snapshot and handoff tool. It writes the current working state into a structured `BATON.md` so a fresh Claude Code session can resume with the goal, recent decisions, active files, gotchas, and next concrete action intact instead of relying on degraded compacted context.

## Prerequisites

- Node.js `>=20`
- Claude Code

Bun is only required for local development from this repository.

## Install

After the package has been published to npm, run the installer directly:

```bash
npx -y ccbaton@latest
```

Or with Bun's npm package runner:

```bash
bunx -y ccbaton@latest
```

Before the first npm publish, install from a local checkout:

```bash
bun install
bun run build
node dist/cli.js install
```

The installer patches `~/.claude/settings.json` with self-locating commands that keep working after `npx`/`bunx` exits. Published installs use the bundled Node.js CLI; source-tree installs use `bun run src/cli.ts`.

- a statusline command
- `UserPromptSubmit`, `PreCompact`, and `SessionStart` hooks
- `/baton` and `/drop` slash commands
- the baton skill at `~/.claude/skills/baton/SKILL.md`

After installing, restart Claude Code if the installer says the top-level skills directory was newly created.

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
Sonnet 4.5 | main* | [======----] 82k/200k | baton:fresh | 5h 71% | 12m | $1.24
```

When context gets high, baton nudges Claude to snapshot. At the hard threshold, it injects the baton protocol directly so Claude writes the baton before auto-compaction can discard useful state.

## Configuration

`BATON_FRESH_MS` controls how long an existing `BATON.md` is considered fresh. The default is ten minutes:

```bash
BATON_FRESH_MS=1800000 claude
```

## Commands

After installing from npm, the `baton` binary is available through npm's normal bin resolution:

```bash
baton install
baton statusline
baton hook user-prompt-submit
baton hook pre-compact
baton hook session-start
baton catch
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
