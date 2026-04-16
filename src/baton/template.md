---
name: baton
description: Snapshot the current Claude Code session into a structured BATON.md so a fresh session can resume without context rot. Invoke this skill whenever the user types /baton, says "save progress", "wrap up", "hand off the session", "snapshot", or "let's stop here"; when context is large and a stopping point is near; or when the baton hook has injected baton protocol instructions.
disable-model-invocation: false
---

# /baton — Session baton

You are about to write a baton that lets a **fresh** Claude Code session (no memory of this conversation) pick up exactly where you left off, with higher fidelity than auto-compaction would provide.

## Write the file

Write to `.claude/baton/BATON.md` in the current working directory. Create the `.claude/baton/` directory if it does not exist. Overwrite any existing file at that path.

## Required structure

Use this exact skeleton. Every section must appear. If a section has nothing to report, write `_none_` — do not omit the header.

```markdown
# Baton — <short project/task name>

_Written by Claude at <ISO timestamp>. Fresh session: read this top-to-bottom before doing anything else._

## Current Goal
<One sentence. The north star of this session. What is the user ultimately trying to achieve right now?>

## Completed This Session
- <Concrete, verifiable bullet. Include `path/to/file.ext:LINE` when referring to code.>
- <...>

## Active Work
**What:** <What is in-flight right now, one sentence.>
**Where:** <Files and line ranges currently being edited. `src/foo.ts:40-75`.>
**Why:** <The reason this approach was chosen, if non-obvious.>
**State:** <Unstarted | edited-not-tested | tested-failing | tested-passing | blocked>

## Next Concrete Action
<The literal first thing the fresh session should do. Not "continue the work" — something like "Open src/foo.ts and replace the placeholder on line 42 with a call to bar()". Must be executable without re-deriving context.>

## Decisions & Constraints
- <Decision + rationale. "Chose X over Y because Z.">
- <Hard constraint the user stated. "Must not introduce new dependencies.">

## Gotchas Discovered
- <Non-obvious thing you learned the hard way this session. "Bun test fails if X is absent — run `bun install` first.">

## User Preferences Observed
- <Style/workflow notes. "User prefers terse explanations.", "User wants tests before implementation.", etc. Only include if you actually observed it this session.>

## Open Questions for the User
- <Questions that were parked and need answers before proceeding. `_none_` if everything is clear.>

## Key Files (quick index)
- `path/to/file.ts` — <one-line role in this task>
- <...>

## Recent Test / Build State
<Last command run, exit code, and whether output was clean. E.g. "`bun test` — 12 passed, 0 failed, as of 14:32.">
```

## Authoring rules

1. **Write what's load-bearing, drop what's noise.** Do not recap every tool call. A baton is not a transcript.
2. **Every code reference must have `file:line` or a line range.** Never write "the function that handles X" — write `src/auth.ts:88-112`.
3. **"Next Concrete Action" is the single most important field.** If a fresh session can't start from it without re-reading the codebase, rewrite it.
4. **Do not summarize conversational back-and-forth.** Only capture decisions, constraints, and state.
5. **Do not invent user preferences.** Only include preferences you actually observed this session.
6. **If you are uncertain about any field, say so explicitly** rather than guessing. A fresh session trusts this document.

## After writing

Tell the user, exactly:

> Baton written to `.claude/baton/BATON.md`. Type `/clear` for a fresh session that auto-resumes — or open a new terminal and run `baton catch` if this session is ending.

Do not do any other work after writing the baton. The fresh session will pick up from the file.
