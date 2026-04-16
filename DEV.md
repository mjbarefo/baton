# DEV.md — Code Review Findings

Critical review of the baton codebase, adversarially vetted. Line numbers accurate as of v0.2.2.

---

## Fixed in This Review

**Pre-compact allows compaction when fallback write fails** — `src/hooks/pre-compact.ts`
The catch block on fallback writer failure returned 0 with no stdout, letting Claude Code proceed with auto-compaction. Fixed to always emit `{ decision: "block" }` in the catch path, directing the user to `/baton` manually.

**Session-start ordering: inject before archive** — `src/hooks/session-start.ts` — intentional, documented.
Reviewed and confirmed: inject-first is the correct ordering. Archive-first was tried but rejected — if stdout delivery fails after archive, the baton is permanently gone (data loss). If archive fails after inject, the baton re-injects on the next `/clear` (double-resume — annoying but recoverable). The comment in `session-start.ts:50-55` documents this reasoning explicitly.

**`BATON_FRESH_MS` silently becomes NaN** — `src/config.ts`
`Number("10m")` produces `NaN`, making all freshness checks return `false` (every baton treated as stale). Fixed to validate and fall back to the 10-minute default with a stderr warning.

**Duplicated `findBaton()`** — `src/baton/catch.ts`, `src/baton/drop.ts`
Identical directory walk-up logic was copy-pasted in both files. Extracted to `src/baton/find.ts`.

**Soft nudge silently skipped when statusline writes maxTokens-only state** — `src/hooks/user-prompt-submit.ts`
The statusline persists `{ maxTokens }` to the state file without a `level` field. `readState()` was not normalizing missing level values, so the parsed state had `level: undefined`, which failed the `=== "none"` guard and caused the soft nudge to skip entirely — users would jump straight to the hard-stop. Fixed by explicitly defaulting missing or invalid `level` to `"none"` in `readState()`.

**`readFirstTimestamp` did full-file parse on hot path** — `src/transcript/read.ts`
The initial implementation parsed the entire transcript to get the first timestamp for session-age calculation. Fixed with a forward chunk-reader (64KB at a time) that stops at the first valid timestamp found, matching the pattern of the existing tail-reader `readLatestAssistantUsageEntry`.

---

## Minor Notes

**Archive EXDEV fallback leaves original if unlink fails** — `src/baton/archive.ts:22-23`
If `copyFileSync` succeeds but `unlinkSync` throws (e.g. file locked on Windows), the original `BATON.md` stays alongside the archive. Next `/clear` would re-inject it. Very low probability scenario; consequence is a redundant context injection the user can `/drop`. Fix: check for existing baton before injection in `session-start.ts`, or retry the unlink.

---

## Test Coverage Gaps

| Module | Tests | Priority |
|--------|-------|----------|
| `src/hooks/user-prompt-submit.ts` | None | **High** — level transitions (none→soft, soft→hard, hard→hard no-op), state pruning, template load failure; regression test specifically needed: maxTokens-only state file present before soft threshold (the state normalization bug path) |
| `src/config.ts` | None | **High** — `BATON_FRESH_MS` NaN path now exists; `cliPath()` source vs. compiled detection |
| `src/hooks/pre-compact.ts` | Partial | **High** — fallback-write failure path (the fixed bug) needs a regression test |
| `src/baton/archive.ts` | Indirect | **Medium** — EXDEV cross-filesystem fallback, unlink failure path |
| `src/baton/template-loader.ts` | None | **Medium** — missing template file, frontmatter with no closing `---` |
| `src/statusline/widgets.ts` | None | **Low** — badge state coverage, rate limit edge cases |
| `src/statusline/bar.ts` | Partial | **Low** — `max=0` guard, tick position at extremes |
| `src/transcript/read.ts` | Indirect | **Low** — single-line file, very large file, UTF-8 boundary |
| `src/statusline/render.ts` | None | **Low** — malformed JSON, missing fields |
