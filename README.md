# baton

baton is a Claude Code session snapshot and handoff tool. It writes the current working state into a structured `BATON.md` so a fresh Claude Code session can resume with the goal, recent decisions, active files, gotchas, and next concrete action intact instead of relying on degraded compacted context.

## Prerequisites

- Bun `>=1.3`
- Claude Code

## Install

From this repo:

```bash
bun install
bun run src/cli.ts install
```

The installer patches `~/.claude/settings.json` with:

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
bun run src/cli.ts catch
bun run src/cli.ts catch --dry-run
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

```bash
bun run src/cli.ts install
bun run src/cli.ts statusline
bun run src/cli.ts hook user-prompt-submit
bun run src/cli.ts hook pre-compact
bun run src/cli.ts hook session-start
bun run src/cli.ts catch
bun run src/cli.ts drop
```

After publishing, the package binary is `baton`; the compiled binary path is prepared by `bun run build`.

## Migrating From Handoff To Baton

- In-flight `.claude/baton/HANDOFF.md` files can be renamed to `BATON.md` manually and will be picked up by the `SessionStart` hook as usual.
- The installer automatically removes old `~/.claude/commands/handoff*.md` and `~/.claude/skills/handoff/` on next install.
