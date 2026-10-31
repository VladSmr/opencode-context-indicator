# Changelog

Notable user-facing changes per release. Dates are commit days (UTC).
The package also ships a dual V1/V2 plugin — see the README for the surface
matrix; everything below concerns the V2 path unless stated otherwise.

## 1.8.0 — 2026-10-31

- **The TUI sidebar and the `/cx` panel are live for npm installs too**
  (workaround for upstream anomalyco/opencode#33884). OpenCode skips its
  Solid/Babel JSX transform for any file inside a `node_modules` directory, so a
  JSX-built slot mounted from an npm install rendered once and then froze on
  "no data yet"; 1.7.x avoided that by disabling the surfaces entirely. The TUI
  tree is now built with `jsx()` plus getter props (`lib/tui-h.ts`), which needs
  no transform at all: the host rewrites the literal
  `@opentui/solid/jsx-runtime` import to its own in-process module, so the
  surfaces stay reactive from any install path. The npm-path auto-disable and its
  console hint are gone; `file://` installs behave exactly as before.
  - Relative imports of `.ts` files now carry the extension (`./lib/tui-h.ts`):
    the host decides which files get the runtime rewrite by walking the import
    graph with `import.meta.resolve`, which never probes extensions. An
    extensionless import silently kept the literal `@opentui/solid` specifier
    and failed with `Cannot find package '@opentui/solid'` - gate (b) now
    rejects it.
- **No runtime dependencies at all.** `@opentui/solid` moved from
  `dependencies` to `devDependencies` (types + local typecheck only, still
  pinned to an exact version). A fresh install drops from ~28 MB / ~800 files to
  a 147 KB tarball (27 files, ~419 KB unpacked), and the duplicate
  `@opentui/core`
  / Babel toolchain
  (`@babel/core`, `babel-plugin-module-resolver`, `babel-preset-solid`, `s-js`,
  `entities`) no longer lands in the opencode cache next to the host's own copy.
- **Baseline: opencode 2.2.5 / OpenTUI 0.8.** Dev dependencies, the peer floor
  and the typecheck now target `@opentui/solid` + `@opentui/core` `0.8.0` and
  `@opencode/plugin` `2.2.5` (opencode 2.2.3 made OpenTUI 0.8 mandatory for TUI
  plugins; 2.2.5 is the latest release at the time of writing and still ships
  0.8.0). `jsx()`/getter semantics are unchanged in 0.8 - `spreadExpression`
  still reads every prop inside a `createRenderEffect` - so the JSX-free tree
  behaves exactly as before; the whole gate set (types, fast gate, Check C) was
  re-run on a real 2.2.5 host. A host that still ships OpenTUI 0.7 (opencode
  2.2.0-2.2.2) may not load the TUI surfaces.
- **Denominator follows opencode 2.2.5.** The context window used for every
  percentage is now `input && context ? min(input, context) : input || context`,
  mirroring core's `inputWindow()` after #60660: a provider that reports an
  input limit above the context window cannot use it in full, because the
  context also holds the reply. Before this release an input limit above the
  context window was used as-is, which overstated the window (and printed a
  compact-at point the host never reaches). Covered by unit test T37. opencode
  2.2.5 also accepts a percentage `compaction.buffer`; that setting is not
  visible to plugins, so a percentage buffer still shows the default reserve.
- **Gates cover the failure mode end to end.** Fast gate (b) is rewritten: the
  TUI surface must contain no `.tsx`/`.jsx` file and no `@jsx*` pragma, every
  TUI source must parse with esbuild `loader:"ts"` (JSX syntax fails), and
  imports must stay inside the host-bridged allowlist. Gate (c) now walks the
  real import graph and fails if a host-bridged module is a production
  dependency. New e2e **Check C**: `npm pack` → extract into a throwaway
  `node_modules/opencode-context-indicator` → isolated `--standalone` TUI →
  assert an env-gated getter-driven probe keeps re-rendering (a frozen tree
  writes the same value forever). `node test/e2e-tui.mjs --check-c` runs it
  alone, without an LLM call.
- **Docs:** the README no longer describes a `file://`-only live sidebar;
  "Live sidebar" documents the JSX-free design and the size win.

## 1.7.1 — 2026-10-29

- **Fixed: the live log no longer prints `ctx=0` above real categories.** A hook
  breakdown whose instance has no request counters (a mirror that only saw the
  compaction, so `input`/`ctx` are still 0) used to be printed as-is: the header
  contradicted the category lines below it. Such an entry now takes the same
  path as a missing/fallback one and borrows the hook-measured `state.json`
  snapshot whole (categories, counters, residual and a `snapshot=` stamp; a
  snapshot without a timestamp is still marked `snapshot=unknown`). A counter is
  knowledge only when it is positive: a borrowed entry whose own counters are 0,
  or a ctx-only snapshot with no input, prints the unknown counter as `?`, and
  the residual as `n/a (input unknown on this instance)` instead of a fabricated
  `0` (`other = input - sum` needs an input). The same rule now applies to a
  local hook entry that knows `ctx` but not `input`. T36 covers all four cases:
  whole-entry borrow, no snapshot, zero-counter snapshot, ctx-only snapshot
  (86 checks).
- **Fixed: the compaction reserve is 15 % again (1.7.0 regression).** 1.7.0
  switched the denominator to a 10 % share on the strength of an unreleased
  branch head. Every RELEASED host from 2.1.4 through 2.2.2 (2.1.4, 2.2.0,
  2.2.1, 2.2.2) still has `RESERVE_SHARE = 0.15` in
  `packages/core/src/session/compaction.ts` (verified tag by tag), so on those
  hosts 1.7.0 overstated the ceiling and the `compact at` line by ~5 % of the
  window (~26 k tokens at 512 k) and therefore under-reported every `%`. The
  plugin now mirrors `max(floor(window * 0.15), window >= 32_000 ? 16_000 : 0)`
  again; the formula, the 16 k floor and the `2 * RESERVE_MIN` gate are
  unchanged. Docs, the T16/T26 tables and the seed expectations are back on the
  15 % numbers.
- Dev: the isolated e2e (plugin load + state write) was re-run against the
  **2.2.2** Desktop CLI (`opencode v2.2.2`); the Desktop 2.2.2 `app.asar` still
  carries the `@opencode/plugin/gui` / `@opencode/plugin/rpc` bridge and the
  `ComposerPill` / `Rpc.define` / `session.panel` symbols the experimental panel
  uses, and `opencode-cli.exe` still exposes `opentui:runtime-module:` plus the
  `node_modules` exclusion filter.

## 1.7.0 — 2026-10-29

Desktop GUI release (experimental): the plugin now has a surface in the
OpenCode Desktop app, not just in the terminal.

- **Desktop side-panel tab.** A new `./gui-experimental` part contributes a
  "Context" tab to the session side region: model, `ctx / usable (percent)`, the
  eight categories as value + bar + share, the measurement time and source tag,
  a stale-after-compaction marker, the compaction reserve, and one line per
  subagent with its own window and percentage. Opened from the `+` menu of the
  side region, the command palette, or the `/cx` slash command.
- **Composer pill.** A small always-on `NN% ctx` capsule above the composer,
  amber from 65 % and red from 85 % of the usable window; clicking it opens the
  tab. It hides itself while the server part is unavailable instead of showing a
  stale number.
- **New public RPC contract (`./rpc`).** A Desktop window has no filesystem
  access, so the panel cannot read `state.json`; the server part now registers
  an RPC contract (id `context-indicator`, method `family`) that returns the root
  session plus every descendant as flat rows, and the GUI polls it through
  `ctx.client.rpc()`. The contract is exported so other plugins and clients can
  read the same data.
- **One family walk instead of two.** `/context-breakdown` and the RPC now share
  `collectFamilyReports()`: the descendant BFS, the shared wall-clock budget and
  the per-session collection exist once. The RPC uses a 2 s budget (a poll runs
  far more often than a command).
- **Experimental warning.** The host GUI API (`@opencode/plugin/gui`) is marked
  experimental upstream and may change between releases; if it does, the GUI
  part stops loading while the server part, the slash commands and the TUI
  surfaces keep working. The Desktop part is not covered by CI (it needs a real
  window); CI typechecks it, builds the bundle and validates the artifact.
- **Fixed: hook-measured categories are authoritative in `state.json`.** The
  file is shared by every plugin instance, and the Desktop window's instance
  never serves a model request, so its breakdown is always the client-context
  fallback (no system prompt, no tool schemas). It used to overwrite the
  hook-measured categories milliseconds after the hook wrote them, which is what
  made the panel show `system 0` / `tool schemas 0` / a grossly inflated `other`
  and could blank `user`/`assistant`. Entries now carry their `source`, and only
  a hook breakdown may replace hook numbers (a fallback still fills a session
  that no hook has ever measured). The same rule now applies to the command
  report and to the live log, so all three surfaces agree.
- **Fixed: the stale-after-compaction mark survives a fallback write.** A
  conversation rebuilt from the persisted messages is not a measurement of the
  compacted context; only a fresh hook breakdown clears the mark now, so the
  panel keeps saying "stale after compaction" instead of silently dropping it.
  The compaction hook also marks the entry as "already handled" only when it
  actually persisted a measurement, so a hook instance with a cold cache no
  longer suppresses the fallback and makes a compaction leave no trace at all.
- **Fixed: compaction notes could vanish from the log.** `final summaries` lived
  in per-process memory while the log file is shared, so the next snapshot
  rewrite from another instance wiped a `COMPACTION`/`COMPACTED` note that had
  just been appended. The writer now merges the section already on disk
  (block-level, de-duplicated, bounded) under its own lock, and the live snapshot
  prints a hook-measured `state.json` entry — categories, residual `other` and
  its `ctx`/`input` counters, tagged `snapshot=<updatedAt>` — instead of this
  instance's fallback-shaped view. Repeated compactions of one session are also
  no longer collapsed into a single note when the host omits the event id.
- **Reserve share (claim in 1.7.0 was wrong; corrected in 1.7.1).** This
  release switched the denominator to a 10 % share; no host in the verified
  range 2.1.4 through 2.2.2 used it. `calculateCeiling()` in those tags keeps
  `RESERVE_SHARE = 0.15`, so 1.7.0 overstated the ceiling (and the `compact at`
  line) by ~5 % of the window (~26 k tokens at 512 k) on them and therefore
  under-reported every `%`. The 1.6.0 note that the ceiling was unchanged in
  2.2.0 was right (the formula and the `2 * RESERVE_MIN` gate did stay); the
  share line here was the wrong part.
- Dev: `lib/format.js` (pure `fmt`/`num`) extracted so the GUI bundle has no
  `node:*` import; gate (a) now expands `dist/`, gate (e)/(f) scan `gui/` and the
  GUI build config, new gate (g) validates the built CJS bundle (app-provided
  modules kept external, no React/OpenTUI/bare-`opencode` import, no Node
  built-in, no ESM or dynamic import left), new unit checks T30 (schema vs row
  builder), T31 (RPC registration + handler), T32 (fallback vs hook priority in
  the report), T33 (fallback vs hook priority in the shared state file, stale
  mark), T34 (summary merge across instances), T35 (hook-family authority for
  the compaction hook, the V1 transform hooks and legacy untagged entries, plus
  the live-log substitution) and T25c/T25d (a cold-cache or lock-refused
  compaction hook must not arm the trailing-event guard), 85 checks total; CI
  builds the GUI and typechecks it before the gate. The isolated e2e (plugin
  load + state write) passes on both the 2.2.0 CLI and the 2.2.1 Desktop CLI;
  the dev dependency stays pinned to `@opencode/plugin@2.2.0` for CI
  reproducibility.

## 1.6.0 — 2026-10-27

Host alignment release: opencode 2.2.0 moved TUI plugins to OpenTUI 0.7.

- **OpenTUI 0.7.0.** `@opencode/plugin` 2.2.0 declares `@opentui/core` and
  `@opentui/solid` **0.7.0** as peers, and the host release notes state that a
  plugin left on OpenTUI 0.6 no longer installs against it (upstream wording;
  this repo's gates only ever run against the current host). The pinned direct
  dependency is now `@opentui/solid@0.7.0` (dev pins `@opentui/core@0.7.0` and
  `@opencode/plugin@2.2.0`). None of the 0.7 breaking changes apply to this
  plugin: it renders intrinsic OpenTUI elements and registers slots, and defines
  no custom renderables, native integrations or `nativeSceneWorkBudget` options.
- **Host support.** The server-only V2 path is unchanged and still targets
  opencode 2.0.16+. The TUI module now ships compiled against OpenTUI 0.7, so
  the sidebar and the `/cx` panel require **opencode ≥ 2.2.0** and cannot load on
  an older host. Older-host installation was not re-verified for this release.
- **Compaction ceiling unchanged (this note was right; 1.7.0 briefly wrong).**
  `calculateCeiling()` in 2.2.0 is identical
  to 2.1.x, so the `0.15 / 16k / 32k` reserve formula and every `%` denominator
  are unaffected. (2.2.0 changed how a *compaction request* is sized - measured
  prompt instead of characters - not the trigger. 1.7.0 later claimed the share
  had dropped to 10 %; see 1.7.1 - no host in the verified range
  2.1.4-2.2.2 uses it.)
- Dev: `drift-watch` is green again (host 2.2.0, OpenTUI 0.7.0); `tsc`,
  `prepublish` and the isolated e2e pass against the 2.2.0 CLI.

## 1.5.4 — 2026-10-27

Fix-and-hygiene release after a full-project review. No new commands.

- **Subagent roll-up no longer collapses on a child's idle.** `session.idle`
  wiped the child's parent attribution and accumulated totals, so the very next
  live line reported `subagents 0 session(s)` right after any subagent
  finished, even though its parent was still running. V2 now keeps a finished
  child's entries until the parent itself goes idle or is deleted
  (`clearChildSubagentTracking`, breadth-first, so sub-subagents are collected
  too); `/context-breakdown` and `/cx` were never affected (they read
  `state.json`). T29 covers the lifetime.
- **TUI panel no longer re-measures every message once per second.** The
  measured-contributors memo was keyed on the 1000 ms snapshot tick and the host
  rebuilds the message array on every poll, so the full walk (per-character
  token estimates plus `JSON.stringify` of tool args) ran on the render thread
  every second. It is now keyed on a cheap signature (list length, last message
  id, last message size including tool results and status), so a static session
  costs almost nothing while streaming text and completing tool calls still
  refresh.
- **A summary-only log write keeps the live snapshot.** `pushFinalSummary` used
  to rewrite `context-breakdown.log` with an empty live section, so every idle /
  compaction / command payload blanked it until the next measured write. The
  module now remembers the last rendered snapshot and re-renders it.
- Doc fixes: the log is rewritten atomically rather than "appended" with
  `appendFileSync`, and both its sections are process-local (survive rewrites,
  not a restart); the `state.json` field list now includes `toolOutByTool`,
  `reclaim`, `cacheRead`/`cacheWrite` and `compactedAt`/`compactStale`; "tested
  against opencode" now says 2.1.4 (was a stale v2.0.28); the gate table now
  states the actual scan scope.
- Packaging: `docs/` is published, so the README screenshot resolves on the npm
  page. Gate (a) expands `docs/` the same way it expands `lib/` and rejects any
  non-image file there.
- Tests: new `OPENCODE_CONTEXT_INDICATOR_LOG_FILE` override (test isolation -
  idle/compacted handlers no longer rewrite the user's real
  `context-breakdown.log`), T29 added (child / grand-child lifetime). 75 unit
  checks.

## 1.5.3 — 2026-10-26

- **Compaction ceiling aligned with opencode 2.1.4.** `lib/limits.js`
  now mirrors `calculateCeiling()` exactly: the reserve is
  `max(floor(window * 0.15), window >= 2 * 16_000 ? 16_000 : 0)` (the plugin's
  older builds used 10 %; no host in the verified range uses it - the share
  stayed 0.15 there),
  and an override buffer is honored **only while it is smaller than the
  window** — a buffer configured for a larger model is ignored instead of
  leaving zero room. The `compact at` line and the `%` denominator now match the
  host's actual auto-compaction trigger.
- **Top context consumers.** `/context-breakdown` adds a
  `### Top context consumers (main)` section listing the 5 heaviest single items
  still in the assembled request (one tool result, one message, the system
  prompt, one tool-call's args) with their share of `input`. Tool targets are
  shown live; the `state.json` copy (`top`) is path-free, like the waste
  detector.
- **`/context-diff`.** New slash command: the previous distinct measurement vs
  the current one (ctx total + per-category deltas, unchanged rows omitted).
  `state.json` persists a `previous` snapshot; an unchanged / mirror write
  inherits it, so the diff always spans two different observations. Main
  session only, cache + `state.json` only (no RPC), delivered under the
  `<context-diff>` tag with `resume:true` like the other commands.
- Dev: `@opencode/plugin` devDependency pinned to `2.1.4`; `@opentui/solid`
  and `@opentui/core` aligned with the 2.1.4 host (`0.6.8`). The 2.1.4 type
  changes are internal (`DeepMutable` re-exported from effect; an unused
  `permission.descending` brand); the `./tui` surface we import is unchanged.
  `@opentui/solid` 0.6.8 is byte-identical to 0.6.6 in `dist/` and
  `scripts/`; only its `@opentui/core` dependency moved to 0.6.8.
- Tests: T26 (2.1.4 reserve table + buffer-over-window guard), T27/T27a/T27b
  (top consumers: estimate → path-free persistence → rendered section),
  T28/T28a/T28b/T28c/T28d/T28e (`previous` inheritance → diff rendering →
  honest empty state → unmeasured-write guard (known + unknown model) →
  null-safe delta); existing
  T2/T4/T4b/T7/T9/T10/T12/T16* updated for the 0.15 reserve. 74 unit checks.

## 1.5.2 — 2026-10-21

Maintenance release: no runtime behavior change. It aligns the dev toolchain
with opencode 2.1.2 and stops the CI drift gate from going red on patch
releases.

- Dev: `@opencode/plugin` devDependency pinned to `2.1.2`; `@opentui/solid`
  and `@opentui/core` aligned with the 2.1.2 host (`0.6.6`).
- Tests: the e2e gate now terminates reliably on Windows. `process.exit()`
  could deadlock inside Node's native exit after the node-pty/conpty teardown:
  the run printed its verdict and then hung forever (which would also hang
  `prepublishOnly`). It now sets `exitCode`, closes the conpty sockets on a
  natural child exit, and keeps an unref'd watchdog as a safety net.
- Dev: `test/drift-watch.mjs` is now advisory on patch drift (warning, exit 0),
  so the daily CI no longer goes red on every opencode patch. Breaking drift
  still fails: a major bump, a minor bump of `@opencode/plugin`, a minor bump
  for 0.x `@opentui/*`, or a structural host change (no `workspaces.catalog`
  / no `@opentui` entries). `--strict` / `DRIFT_STRICT=1` fails on ANY drift
  and is the release check; exit codes are set via `process.exitCode` so piped
  CI logs are never truncated. README/CI unit-check counters updated to
  T1-T25c / 62.

## 1.5.1 — 2026-10-19

- **Compaction now handled by the real `compaction` hook.** opencode dispatches
  a `compaction` hook at the start of a compaction request with the same
  pre-compaction payload as the `context` hook. The plugin registers it and
  persists the *true* pre-compaction breakdown at that moment — previously the
  trailing `session.compacted` event re-persisted whatever the last model
  request had left behind. The event is kept as a fallback (hosts/paths where
  the hook does not fire), and a no-op compaction ("Nothing to compact yet")
  writes no stale entry. Same `(stale — compacted)` UX, more accurate numbers.
- Dev: pinned the `@opencode/plugin` devDependency to `2.0.32`.
- Tests: T25 / T25a / T25b / T25c (compaction-hook snapshot, no-op guard,
  event fallback, cold-cache clobber guard) — 62 unit checks total.

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
