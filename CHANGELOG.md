# Changelog

Notable user-facing changes per release. Dates are commit days (UTC).
The package also ships a dual V1/V2 plugin — see the README for the surface
matrix; everything below concerns the V2 path unless stated otherwise.

## 1.5.0 — 2026-10-16

Highlights: two new context-health signals — the **provider-reported prompt
cache** (exact) and a **waste detector** for redundant tool output already in
the context.

- **Prompt cache (provider-reported)**: `session.step.ended` carries
  `tokens.cache.{read,write}` — the provider's EXACT prompt-cache figures. Shown
  as `prompt cache read=X (Y% of input) · write=Z` in `/context-breakdown`
  (a `### Prompt cache` section), `/context`, the `./cx` panel and the live log.
  It is a **subset of `input`**, so it is deliberately **not** added to the
  category sum (no double-count). `n/a` when the provider reports nothing;
  persisted as `cacheRead`/`cacheWrite` and inherited by mirror writes (a
  non-measuring write cannot drop them).
- **Waste detector**: finds tool output already in the context that is redundant
  — the **same target** invoked repeatedly (the same file read twice, the same
  URL fetched again) or **byte-identical output**. Reported as a `### Potential
  reclaim (redundant tool output)` section in `/context-breakdown` (top findings
  with tool + target) plus a `reclaim ~X redundant tool output (N dup)` panel/log
  line. The number is the non-largest member of each duplicate group — an honest
  *"N copies are in context; trimming/compaction could reclaim ~X"*, never "the
  model wasted effort". Findings are **path-free** in the persisted/exported
  form; the estimate is computed on both the hook and the fallback path.
- Tests: T23/T23a/T23b (cache persistence, surfaces, sanitisation), T24–T24c
  (reclaim algorithm, target extraction, hook capture via call-id correlation,
  path-free persistence + rendering).
- Legacy `state.json` entries (without the new fields) behave exactly as before.

## 1.4.1 — 2026-10-14

Highlights: the `toolOut` category is now split **by tool name**, and a
`(stale — compacted)` marker tells you when the numbers predate a compaction.

- **Tool results by tool**: `/context-breakdown` (a `### Tool results by tool
  (main)` section) and the `./cx` panel (`tool results by tool` line) split the
  `toolOut` column by tool name (`webfetch`, `read`, `bash`, …) — top-N with a
  `+N more` tail. Aggregated on both the hook and the fallback path from each
  tool part's `name`; names are sanitised and the map is bounded (overflow folds
  into `other tools`). Persisted as `toolOutByTool` in `state.json`.
- **Compaction staleness marker**: opencode's compaction fires no `context`
  hook, so `/context` right after `/compact` used to show stale pre-compaction
  numbers with no hint. Such an entry is now flagged (`compactStale`) and every
  surface (sidebar, panel, `/context`, `/context-breakdown`) shows
  `(stale — compacted)` until the next model request refreshes the breakdown.
- Legacy `state.json` entries (no new fields) behave exactly as before.
- Tests: T19/T19a (staleness mark lifecycle + surfaces), T20–T20c (per-tool
  split on both paths, sanitisation/bounding, persistence + rendering).
- **Refactor (behaviour-preserving)**: extracted the shared category helpers
  (`sumCategories` / `breakdownCategories`) into `lib/estimate.js`, removing
  four hand-rolled copies of the residual-`other` computation (V2 live log,
  state writer, command report, TUI panel); the TUI now imports the ONE token
  estimator and per-tool split from `lib/estimate.js` instead of keeping byte
  copies; dropped unused module exports; unified the per-tool map cap. New
  guard test T21.

## 1.4.0 — 2026-10-13

Highlights: a new **toolOut** category names what used to drown in `other` —
tool results (webfetch pages, file reads, subagent reports) are now measured
separately instead of hiding in the residual bucket.

- New category **toolOut** (tool results). `other` was the residual of every
  uncounted input — in practice dominated by tool outputs (a webfetch-heavy
  session showed ~300k of unexplained "other"). Results are now estimated from
  the context payload (`text` / `json` / `error` / `content` parts) and in the
  fallback path (persisted `state.content`); `other` shrinks to genuinely
  uncounted input (images/media, unknown part types). Legacy `state.json`
  entries without the field normalise to 0.
- `/context`, `/context-breakdown`, the log and the sidebar carry the new
  category (`out` column / line); the panel's contributors note is reworded
  (contributors attribute outputs per tool call, `toolOut` only totals them).
- The npm `description` and `keywords` now describe the current feature set
  (panel, cost, picker) instead of the original "log file + sidebar".
- `/context` and `/context-breakdown` instructions are tag-delimited
  (`<context-summary>` / `<context-breakdown>`): models sometimes echoed the
  instruction line itself into the reply; the tags give an unambiguous payload
  boundary. The human-readable log receives the body only, without the
  instruction block.
- `state.json` hygiene: entries untouched for 30 days are pruned on the next
  write (deleted / abandoned sessions used to linger until the LRU cap).
  Resuming a month-old session re-derives its inherited fields once and
  self-heals on the next event.
- Tested against opencode **2.0.28**; `@opencode/plugin` types devDep pinned
  `2.0.28` (data-layer types unchanged; OpenTUI catalog stays `0.5.17`).

## 1.3.0 — 2026-10-09

Highlights: per-session cost in `/cx` (family-aggregated for the main session),
a searchable family-session picker, and `/cx` reachable from subagent session
views.

- `/cx` panel: new **cost** column (upstream #45417). The main session shows
  the family-aggregated spend, each subagent its own; `-` when the host has no
  cost for a session.
- New panel key `s` — a searchable picker over all family sessions
  (title / model / cost / running marker). `Enter` navigates: root sessions
  focus their tab, subagent sessions switch the route.
- `/cx` now works from **subagent session views**: those views have no prompt
  input, so the command is also in the command palette and bound to
  `<leader>c` (ctrl+x, then c) and `f4`. The panel family is rooted at the
  topmost ancestor, so the whole family is shown, not just the child subtree.
- OpenTUI pinned `0.5.17`; `@opencode/plugin` types devDep pinned `2.0.26`
  (drift-watch now tracks both). Tested against opencode **2.0.26**.

## 1.2.2 — 2026-10-08

- TUI entry split for maintainability: `tui.tsx` down to ~195 lines; the
  components and the data layer moved to `lib/` (`tui-sidebar.tsx`,
  `tui-panel.tsx`, `tui-data.js` + `.d.ts`, `tui-theme.js`). No behavior
  change. The pragma regression gate now covers every `lib/*.tsx`.
- E2E hardened: deterministic fail-closed plugin-load check (isolated global
  config via `OPENCODE_CONFIG_DIR` + the isolated instance's own log file +
  a live-surface stamp), cleanup of spawned CLI instances, WMI probe timeouts.

## 1.2.1 — 2026-10-08

- The panel / percentage denominator now equals **opencode's compaction
  ceiling** (v2.0.23+ `calculateCeiling`: window = `limit.input ||
  limit.context`; reserve = max(10% of the window, 16k when the window is at
  least 32k)) — percentages read as "% to compaction", not "% of the raw
  window" (upstream #51271).
- `state.json`: new `reserve` field; the panel and `/context` show
  `compact at X (N reserve)`.
- Unit harness extended to 34 checks (measured contributors, redacted-export
  invariants, ceiling formula, hydrate seeding).
- OpenTUI pinned `0.5.16`.

## 1.2.0 — 2026-10-04

- New: **zero-LLM `/cx` session panel** — a family table (role / model /
  ctx% / updated) for the current session and all subagent descendants, plus a
  `largest contributors (measured)` section computed from the in-process
  message list (per tool call, with message clock times and bounded previews).
- Redacted export (`e`): no message text, no full session ids, no tool output
  content — written under `%TEMP%/opencode-context-indicator/exports/`.
- Keys: `esc` closes, `r` refreshes, `e` exports.

## 1.1.6 — 2026-10-04

- OpenTUI pinned `0.5.14` (opencode 2.0.21+), optional-peer floor aligned.
- `index.js` split into `lib/` modules (no behavior change).

## 1.1.5 — 2026-10-02

- Security hardening: sanitized table metadata, validated `state.json`
  (prototype-poisoning keys dropped), ownership-safe state lock, tmp hygiene.

## 1.1.4 — 2026-10-02

- Removed a stray `opencode/process` import from the TUI entry; the prepublish
  gate now rejects bare `opencode/*` specifiers (not bridged at runtime).

## 1.1.3 — 2026-10-01

- Stable context denominator across plugin instances: a transient
  `ctx.model.list()` miss falls back to the shared snapshot instead of
  clobbering persisted windows.

## 1.1.2 — 2026-10-01

- Graceful sidebar/panel disable on npm installs (upstream #33884: `node_modules`
  plugins skip the host Solid transform, so slots would freeze) — a single hint
  is logged instead; `@opentui/solid` is shipped pinned; `file://` install docs.

## 1.1.1 — 2026-10-01

- Fixed `Cannot find package 'react'` when loaded from the npm cache: the
  `@jsxImportSource @opentui/solid` pragma must be the file's first line.

## 1.1.0 — 2026-10-01

- New: `/context` (compact summary) and `/context-breakdown` (full table, main
  + all subagent sessions) slash commands.
- Stable per-model window limits; strict subagent discovery.

## 1.0.0 — 2026-09-30

- Initial release: dual V1/V2 plugin, real-time context indicator, per-category
  token breakdown (system / tool schemas / user / assistant / reasoning / tool
  args / residual), TUI sidebar.
