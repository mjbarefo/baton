# DEV.md

This is a working development backlog for baton. It is intentionally opinionated:
baton should stay small, local-first, deterministic, and boring in the places
where it touches user settings or session recovery.

## Product Direction

baton now treats `.baton/BATON.md` as the host-neutral contract and layers host
adapters around it. The core loop covers:

- install Claude Code hooks, statusline, and slash commands
- install Codex CLI hooks plus a baton skill
- install a Gemini CLI extension with commands, context, and hooks
- nudge before context pressure or rate-limit pressure makes a clean handoff hard
- block Claude Code auto-compaction and write a fallback baton when needed
- resume once from a fresh `BATON.md`, then archive it
- recover with `catch`, `reconstruct`, archive listing, search, and pruning
- redact deterministic fallback batons
- validate authored batons before telling users to clear/resume
- get a second opinion via headless Codex or Gemini sidecars without leaving the session

The next useful work should improve host-specific correctness and confidence in
the new adapters before adding larger features.

## Implemented In The Multi-Host Pass

- Canonical project path: `.baton/BATON.md`.
- Legacy path read compatibility: `.claude/baton/BATON.md`.
- Shared user state/archive/template/redaction paths under `~/.baton/`.
- `baton validate`, `baton status`, `baton check --json`, and `baton install --dry-run`.
- `baton install|check|uninstall --host claude|codex|gemini|all`.
- `baton catch --host claude|codex|gemini`.
- Host-neutral sidecar wording and shared redaction before external CLI execution.

## Recommended Next PR: Installer Hardening

The highest-risk area is now installer correctness across host config surfaces.
Claude settings are covered well, but Codex TOML and Gemini extension generation
should get broader fixture coverage before this is considered stable.

Add focused tests for:

- Codex TOML preservation around existing user config.
- Gemini extension hook generation and uninstall safety.
- Uninstall safety when generated skill/extension files are user-modified.
- `install --dry-run --host all` output shape.
- `check --json` stability for scripts.

## Other Feature Candidates

### Config File

Today most tuning is constants or environment variables. A future config file
could support:

- threshold overrides
- statusline widget selection
- freshness window
- archive retention defaults
- strict validation defaults

Do this after the multi-host installers settle, because config multiplies the
number of behavioral combinations that need tests.

### Archive Improvements

The archive is already useful. Next increments:

- `baton pin <id>` so prune never deletes important batons
- `baton recall --project <name>`
- `baton show --json` for tooling
- include validation status in `list`

### Post-Write Scrub

Fallback batons are redacted today; agent-authored `/baton` files are not. A
validator can warn first. Later, a separate `baton scrub` command could rewrite
a baton with redactions applied, but it should be opt-in because rewriting
agent-authored prose can hide useful context.

## Cleanup Candidates

### Split `settings-patch.ts`

`src/install/settings-patch.ts` owns settings mutation, artifact writing,
migration, uninstall, check, and reporting. It is well-tested but large.

Possible split:

- `settings.ts`: parse, backup, statusline patching, hook merge/prune
- `artifacts.ts`: command files, old artifact migration, ownership checks
- `manifest.ts`: install manifest read/write
- `report.ts`: terminal output
- `settings-patch.ts`: orchestration only

This should be done after the current installer cleanup lands, not in the same
PR as a feature.

### Centralize CLI Parsing

`src/cli.ts` is still readable, but new commands will make manual argument
parsing more fragile. Avoid a dependency for now; a small local helper for
flags, positional args, and usage errors is enough.

### Output Consistency

Use the same conventions across commands:

- `--json` means no ANSI and stable fields
- `--dry-run` never writes
- command failures include the path that failed
- validation-style commands use exit `1` for an expected failed check and `2`
  for bad usage

### Statusline UI Polish

Current statusline is compact and useful. Polish candidates:

- support `NO_COLOR`
- add `BATON: <goal> (8m)` or similar freshness age display when width allows
- make the hard/soft badge text configurable for terminals where symbols render
  poorly
- add snapshot tests for narrow terminal widths and no-color output

## Non-Goals For Now

- no network services
- no database
- no background daemon
- no LLM calls from the CLI
- no broad plugin framework before the core baton quality loop is stronger
- no automatic deletion of user-modified files without explicit confirmation

## Review Order

1. Harden Codex TOML and Gemini extension patching.
2. Split `settings-patch.ts` into host-specific installers plus shared helpers.
3. Add more transcript fixtures for Codex and Gemini formats.
4. Add validation status to archive listing.
