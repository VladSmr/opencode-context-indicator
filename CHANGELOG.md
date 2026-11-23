# Changelog

Notable user-facing changes per release. Dates are commit days (UTC).
The package also ships a dual V1/V2 plugin — see the README for the surface
matrix; everything below concerns the V2 path unless stated otherwise.

## 1.9.7 - 2026-11-23

- **Works with opencode 2.4.1 / OpenTUI 0.9.4.** Verified against the released
  2.4.1 host: nothing on the surface this plugin observes changed, so every
  displayed number keeps its meaning. The OpenTUI devDependencies follow the
  host catalog (0.9.4); the sidebar is rendered by the host's OpenTUI runtime,
  and the package ships no OpenTUI copy of its own.

## 1.9.6 - 2026-11-18

- **Works with opencode 2.3.2.** Verified against the released 2.3.2 host:
  nothing on the surface this plugin observes changed, so every displayed number
  keeps its meaning. OpenTUI stays pinned at 0.8.4 - npm now publishes 0.9.2,
  but the 2.3.2 host still resolves 0.8.4, and following npm would put the
  plugin on a different OpenTUI generation than the runtime that renders it.
- **A compaction started by a process that only compacts now leaves a trace.**
  The `compaction` hook used to mark the entry stale only from its per-instance
  counters, which are filled when a step finishes. A process that only compacts -
  `oc run "/compact"` in its own process, and since opencode 2.3.1 the background
  compaction that is now on by default - has none, so it wrote nothing; if it
  then exited before the trailing `session.compacted` event, the compaction left
  no trace at all (the row kept looking fresh, and the log had no note; observed
  on 2.3.2). The hook now borrows that session's last measured numbers from the
  shared state file instead. It never zeroes an entry and never invents one: a
  no-op compaction on a session that has never measured anything still writes
  nothing.
- Percentages are unchanged: the compaction ceiling is the same in 2.3.2
  (`reserve=max(15%, 16000)`, `window=min(input, context)`, `outputMax=256000`).

## 1.9.5 - 2026-11-16

- **In-memory caches are LRU by last write, not FIFO.** The capped per-instance
  maps (live breakdown, tool schemas, the per-session tool-schema TTL cache, the
  subagent roll-up and every `lastKnown*` value) now move a re-written key to the
  tail, so `pruneMap()` drops the coldest entry instead of the one that happened
  to be inserted first. Previously a session reporting on every step could be
  evicted ahead of one that had gone idle - most visibly as a missing breakdown
  or panel row for a long-running child once 256 sessions were in flight. The
  parent attribution, captured once at `session.created`, is refreshed on every
  step, so a long-lived root is no longer the first key dropped (that used to
  turn its children into phantom root rows). The cap is RAM-only; `state.json`
  retention is unchanged (still whole-family).

## 1.9.4 - 2026-11-14

- **Works with opencode 2.3.0 / OpenTUI 0.8.4.** The host change was additive on
  the surface this plugin observes, so no runtime change was needed and every
  displayed number keeps its meaning.
- **The compaction ceiling is unchanged in 2.3.0.** The released core still uses
  `reserve=max(15%, 16000)` and `window=min(input, context)`, so every displayed
  percentage keeps its meaning.
- **Background subagents by default (host change, no plugin change needed).**
  opencode 2.3.0 returns a subagent's session ID immediately and lets the child
  report back whenever it goes idle, so a family can keep growing after the
  parent's turn ends. The panel already discovers descendants from the persisted
  `parentID` chain and caps the list at the 20 heaviest rows, so those sessions
  appear as they serve requests and the family total keeps summing every row.

## 1.9.3 - 2026-11-12

- **The family list is capped; the family total is not.** `/cx` and the Desktop
  tab now render the **20 heaviest subagent sessions** and collapse the rest into
  a single tail row, `+125 more - 8.9M (88%)`, that carries the hidden rows'
  summed `ctx` and their share of the family. The root stays the first row and
  never counts against the cap, and the `family total` line still sums **every**
  row - the cap shortens the list, not the arithmetic. One measured family had
  145 subagent sessions and filled several screens.
- **Retention of the shared `state.json` works on families.** The old bound was
  a blind `sort(updatedAt).slice(256)`: it cut single rows, and because the
  `parentID` chain is the only link the readers have, a missing intermediate row
  hid its whole subtree (a measured 146-row family had already lost 7 rows; the
  biggest family was itself cut). The file now keeps up to **1024 entries and
  2 MB**, evicting **whole families** freshest-first: a family is never split, an
  older family never displaces a fresher one, and a single family larger than a
  cap is kept whole and flagged (soft cap). Every write that drops something logs
  `state: evicted N families (...)` with roots, row counts and reason, so the
  loss is visible. The 7-day tombstone prune is family-aware too: a family is
  expired only when its **newest** row is stale, so a resumed child can no longer
  outlive its deleted parent as an orphan "root". Byte accounting counts the key
  and separator of every row, and the writer measures the file it is about to
  write; the row the current write just measured is pinned, so it can never be
  evicted by its own write. The per-instance in-memory maps keep their own
  256-entry cap - that one is RAM only.
- **The V1 subagent rollup walks the whole descendant tree.** `aggregateSubagents`
  (used by the V1 free-text log and the toast attribution) only followed direct
  children, so grandchildren - now the normal shape of a deep family - were
  invisible and the sequential fetch was slow. It is now a two-phase breadth-first
  walk: discovery with a visited set (cycle-safe) bounded to **3 levels** and
  **64 sessions** (counted at discovery, so a deep fan-out cannot exceed the cap),
  then message fetches in waves of **4**. A failing child is isolated (logged,
  walk continues), and a failed `children` call marks the rollup as partial
  (`truncated.error`). The log line gains `depths=` and `truncated=` when
  non-trivial; the toast text is unchanged.

## 1.9.2 — 2026-11-11

- **The family total now sits above the list.** One measured family had 145
  subagent sessions, and a total printed after the last row was several screens
  away - effectively absent. The Desktop tab prints `Family total` before
  `Subagents (N)`, and the TUI `/cx` panel prints its `family total` line above
  the columns header.
- **Sums above a million print as `10.3M`,** not `10328.7k`. `fmt()` gained the
  millions step with a `999_950` boundary, so `999_999` never renders as
  `1000.0k`; this also keeps the TUI line inside the 60-column panel. The V1
  free-text log uses the same formatting.
- **Desktop panel cosmetics.** Category rows measured at zero are hidden (a real
  panel showed `Other 0 0%` under eight fixed rows); the full eight-row layout
  stays when nothing is measured yet. The model header keeps the bare model id
  and moves `provider/model` into its tooltip, and a subagent running a different
  model than the root shows that model next to its agent name.
- **The `/context-diff` instruction is one short clause** ("Reply with only the
  content above."), replacing the four-clause tail that gave the model more text
  to paraphrase back. A visible table still needs a model turn - a
  `resume:false` notice shows only the `description` chip - so the echo risk is
  reduced, not removed.

## 1.9.1 — 2026-11-10

- **Family total row.** The TUI `/cx` panel and the Desktop context tab now print
  the sum of every session's own `ctx` in the family plus the session count
  (`family total 651.6k across 7 sessions`). Each session has its own window, so
  this is a total of tokens used, not one window's occupancy; the per-session
  percentages stay relative to each session's own `usable`. The sum comes from
  one shared helper, so the two surfaces cannot drift.

## 1.9.0 — 2026-11-07

- **`/context` and `/context-breakdown` are removed; `/context-diff` stays.**
  Both removed commands spent a real agent turn (they delivered through
  `resume:true`) merely to make the model echo numbers the plugin already had.
  The categories are rendered by the TUI sidebar (terminal) and by the Desktop
  context tab; the family/cost view and the measured contributors are in the TUI
  `/cx` panel — all from the same `state.json` snapshot, **without** an LLM call.
  `/context-diff` still answers "what changed since the last measurement". The
  dead renderers behind the removed commands (`renderSessionRow`,
  `renderBreakdownTable`, `renderTopSection`, `renderCacheLine`,
  `renderReclaimSection`, `renderToolOutLine`, `shortSummary*`, `sourceTag`,
  `topLabel`, `CONTEXT_BREAKDOWN_RESUME`) are gone; the family collection they
  shared with the Desktop RPC (`collectFamilyReports`) is kept.
- **The "top context consumers" feature is removed entirely.** It belonged to
  `/context-breakdown` alone and had no renderer left: the candidate tracking in
  the context-hook estimator, the `top` field in the persisted snapshot and its
  sanitiser are gone, which also trims work from every measured request. The
  per-tool split, prompt cache and reclaim totals remain visible in the `/cx`
  panel.
- Anything that scripted the removed commands should read
  `opencode-context-indicator-state.json` instead. If a workflow needs the
  commands themselves, pin the previous line (`npm install
  opencode-context-indicator@1.8`); they are documented in the README under
  "Removed in 1.9.0" as deprecated. Delivery of `/context-diff` is unchanged:
  one agent turn, `<context-diff>`-tagged payload.
- **Works with opencode 2.2.7 / OpenTUI 0.8.1.** The host changes were additive
  on the surface this plugin observes, so no runtime change was needed.
- **The compaction ceiling is verified against the released core.** No runtime
  change: the plugin already computes `window = min(input, context)` and
  `reserve = max(floor(window * 0.15), window >= 2 * 16_000 ? 16_000 : 0)`,
  exactly `calculateCeiling()` in opencode 2.2.5 through 2.2.7.
  Merged PR #51271 describes a 10% reserve in its body, but only its reply cap
  shipped (`OUTPUT_TOKEN_MAX = 256_000` in `session/model-request.ts`); the
  trigger stayed at 15%, and the unreleased `v2` branch (10%, and no
  `min(input, context)` cap) is deliberately not mirrored - following a branch
  head would make every displayed percentage wrong.

## 1.8.4 — 2026-11-06

- Maintenance release: tooling, contributor documentation and packaging only.
  No user-facing change.

## 1.8.3 — 2026-11-03

- **A deleted session disappears immediately.** `session.deleted` now removes the
  session's `state.json` entry - and every entry under it in the `parentID` chain -
  instead of leaving it to the 7-day tombstone. The row used to stay in
  `/context-breakdown`, the Desktop tab and the `/cx` picker for up to a week, and
  a phantom row has no step event left for the phantom filter to catch. Removed
  IDs are remembered for the lifetime of the instance (the host never reuses an
  ID), so a late write cannot recreate the row: without that barrier a child that
  was still running when its parent was deleted came back as a phantom ROOT,
  because deleting the parent had already wiped its attribution cache. The same
  barrier covers a child that has no persisted entry yet. A state lock that is
  busy at delete time queues the removal for the next write instead of dropping
  it. The write path follows the same lock/atomic-rename contract as the state
  writer; a missing entry is a no-op and an unsafe key is rejected.
- **The Desktop subagent list is heaviest-first.** A family can hold a dozen
  children and the RPC order is the `parentID` walk, which buried the session
  actually eating the window; the list is now sorted by `ctx` (the polled array is
  copied first, never reordered in place).

## 1.8.2 — 2026-11-03

- **Model-rendered commands no longer echo the instruction.** `/context`,
  `/context-diff` and `/context-breakdown` now deliver the payload FIRST and a
  single short "reply with only the content above" line LAST. Models used to
  quote the leading "Output the content ... exactly, verbatim" sentence into the
  assistant message; with the data first there is nothing to quote before it, and
  the trailing line is the last thing the model reads. The tags stay.
- **The clock no longer follows the host locale.** The `updated` column, the
  sidebar and the Desktop panel print a deterministic local `HH:MM:SS` built from
  the Date getters instead of `toLocaleTimeString()` (AM/PM, dotted separators
  and dropped seconds used to break the column alignment). The column is
  width-bounded, the stale marker (`*`) is appended after fitting so it can never
  be truncated away, the layout keeps one spare column, and the by-tool line and
  the measured contributors carry their unit.
- **The `/cx` panel labels its units and buckets.** Contributors read
  `assistant 21:04 message - 50 tokens (est)` (the previous `asst.text` bucket
  had no label), the by-tool line prints `webfetch 242.1k tokens`, and a stale
  row is marked with ` *` plus one legend line instead of a long suffix.
- **A model switch no longer lags behind.** Breakdown cache entries are tagged
  with the model they were measured for. A cached or persisted split from the
  previous model is dropped instead of being written (or reported) under the new
  one, and the persisted categories are inherited only while model and provider
  stay the same - an empty persisted provider counts as "not known yet", not as a
  switch. The model-dependent aggregates (per-tool output, reclaim, top
  consumers) are gated the same way.
- **Tombstone window shortened to 7 days** (was 30): a `state.json` entry is
  pruned on the next write once it has been untouched for a week, so deleted
  sessions stop lingering until the LRU cap.

## 1.8.1 — 2026-10-31

- **The configured `compaction.buffer` is honoured.** opencode 2.2.5 accepts a
  token count or a percentage (`"compaction": { "buffer": "20%" }`) and applies
  it as the reserve below the window; the plugin API exposes no config object, so
  the plugin now reads the user's own `opencode.jsonc` / `opencode.json` from
  `~/.config/opencode` (or `$XDG_CONFIG_HOME`) and from the project directory,
  project winning over global. The JSONC reader is a small in-file scanner (no
  runtime dependency): comments and trailing commas are tolerated, string values
  containing `//` or `/*` survive. A percentage is converted exactly like core
  (`Math.round(window * pct / 100)`); an out-of-range or unparsable value is
  ignored, and so is a buffer that is not smaller than the window - the 15%
  default stays in that case. `OPENCODE_CONTEXT_INDICATOR_COMPACT_BUFFER` and an
  explicit argument still win over the config. The lookup is scoped to the
  calling instance's project directory: one server process that hosts several
  locations never applies one project's buffer to another. The "compact at"
  line, the percentages and the sidebar header all follow the configured buffer.
- **A usage capsule inside the TUI composer** (`prompt.footer.status`). The
  percentage is now visible while typing, without opening the sidebar or the
  full-screen `/cx` panel: `38% ctx`, neutral below 65 %, amber from 65 %, red
  from 85 % of the usable window - the same thresholds as the Desktop pill.
  With the host's `showDetails` toggle on it also prints `ctx/usable`; it is
  hidden in shell mode. A host without the slot renders no capsule and keeps
  every other surface.

## 1.8.0 — 2026-10-31

- **The TUI sidebar and the `/cx` panel are live for npm installs too**
  (workaround for upstream anomalyco/opencode#33884). OpenCode skips its
  Solid/Babel JSX transform for any file inside a `node_modules` directory, so a
  JSX-built slot mounted from an npm install rendered once and then froze on
  "no data yet"; 1.7.x avoided that by disabling the surfaces entirely. The TUI
  tree is now built with `jsx()` plus getter props, which needs no transform at
  all: the host rewrites the literal
  `@opentui/solid/jsx-runtime` import to its own in-process module, so the
  surfaces stay reactive from any install path. The npm-path auto-disable and its
  console hint are gone; `file://` installs behave exactly as before.
  - Relative imports of `.ts` files now carry their extension: the host
    decides which files get the runtime rewrite by walking the import graph,
    which never probes extensions. An extensionless import silently kept the
    literal `@opentui/solid` specifier and failed to resolve.
- **No runtime dependencies at all.** `@opentui/solid` moved from
  `dependencies` to `devDependencies` (still pinned to an exact version). A fresh
  install drops from ~28 MB / ~800 files to a 147 KB tarball (27 files, ~419 KB
  unpacked), and the duplicate `@opentui/core` / Babel toolchain (`@babel/core`,
  `babel-plugin-module-resolver`, `babel-preset-solid`, `s-js`, `entities`) no
  longer lands in the opencode cache next to the host's own copy.
- **Baseline: opencode 2.2.5 / OpenTUI 0.8.** The TUI surfaces target OpenTUI
  0.8 (opencode 2.2.3 made OpenTUI 0.8 mandatory for TUI plugins; 2.2.5 is the
  latest release at the time of writing and still ships 0.8.0). `jsx()`/getter
  semantics are unchanged in 0.8 - `spreadExpression` still reads every prop
  inside a `createRenderEffect` - so the JSX-free tree behaves exactly as
  before, and the whole surface was re-verified on a real 2.2.5 host. A host
  that still ships OpenTUI 0.7 (opencode 2.2.0-2.2.2) may not load the TUI
  surfaces.
- **Denominator follows opencode 2.2.5.** The context window used for every
  percentage is now `input && context ? min(input, context) : input || context`,
  mirroring core's `inputWindow()` after #60660: a provider that reports an
  input limit above the context window cannot use it in full, because the
  context also holds the reply. Before this release an input limit above the
  context window was used as-is, which overstated the window (and printed a
  compact-at point the host never reaches). opencode 2.2.5 also accepts a
  percentage `compaction.buffer`; that setting is not visible to plugins, so a
  percentage buffer still shows the default reserve.
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
  local hook entry that knows `ctx` but not `input`.
- **Fixed: the compaction reserve is 15 % again (1.7.0 regression).** 1.7.0
  switched the denominator to a 10 % share on the strength of an unreleased
  branch head. Every RELEASED host from 2.1.4 through 2.2.2 (2.1.4, 2.2.0,
  2.2.1, 2.2.2) still has `RESERVE_SHARE = 0.15` in
  `packages/core/src/session/compaction.ts` (verified tag by tag), so on those
  hosts 1.7.0 overstated the ceiling and the `compact at` line by ~5 % of the
  window (~26 k tokens at 512 k) and therefore under-reported every `%`. The
  plugin now mirrors `max(floor(window * 0.15), window >= 32_000 ? 16_000 : 0)`
  again; the formula, the 16 k floor and the `2 * RESERVE_MIN` gate are
  unchanged. The documented numbers are back on the 15 % share.

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
  one collection path: the descendant walk, the shared wall-clock budget and the
  per-session collection exist once. The RPC uses a 2 s budget (a poll runs
  far more often than a command).
- **Experimental warning.** The host GUI API (`@opencode/plugin/gui`) is marked
  experimental upstream and may change between releases; if it does, the GUI
  part stops loading while the server part, the slash commands and the TUI
  surfaces keep working. The Desktop part cannot be exercised headlessly; it is
  verified manually in a real window.
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

## 1.6.0 — 2026-10-27

Host alignment release: opencode 2.2.0 moved TUI plugins to OpenTUI 0.7.

- **OpenTUI 0.7.0.** `@opencode/plugin` 2.2.0 declares `@opentui/core` and
  `@opentui/solid` **0.7.0** as peers, and the host release notes state that a
  plugin left on OpenTUI 0.6 no longer installs against it (upstream wording).
  The pinned direct dependency is now `@opentui/solid@0.7.0` (dev pins
  `@opentui/core@0.7.0` and `@opencode/plugin@2.2.0`). None of the 0.7 breaking
  changes apply to this plugin: it renders intrinsic OpenTUI elements and
  registers slots, and defines no custom renderables, native integrations or
  `nativeSceneWorkBudget` options.
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

## 1.5.4 — 2026-10-27

Fix-and-hygiene release after a full-project review. No new commands.

- **Subagent roll-up no longer collapses on a child's idle.** `session.idle`
  wiped the child's parent attribution and accumulated totals, so the very next
  live line reported `subagents 0 session(s)` right after any subagent
  finished, even though its parent was still running. V2 now keeps a finished
  child's entries until the parent itself goes idle or is deleted
  (`clearChildSubagentTracking`, breadth-first, so sub-subagents are collected
  too); `/context-breakdown` and `/cx` were never affected (they read
  `state.json`).
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
  against opencode" now says 2.1.4 (was a stale v2.0.28).
- Packaging: `docs/` is published, so the README screenshot resolves on the npm
  page.

## 1.5.3 — 2026-10-26

- **Compaction ceiling aligned with opencode 2.1.4.** The plugin now mirrors
  `calculateCeiling()` exactly: the reserve is
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

## 1.5.2 — 2026-10-21

Maintenance release: no runtime behavior change. It aligns with opencode 2.1.2.

## 1.5.1 — 2026-10-19

- **Compaction now handled by the real `compaction` hook.** opencode dispatches
  a `compaction` hook at the start of a compaction request with the same
  pre-compaction payload as the `context` hook. The plugin registers it and
  persists the *true* pre-compaction breakdown at that moment — previously the
  trailing `session.compacted` event re-persisted whatever the last model
  request had left behind. The event is kept as a fallback (hosts/paths where
  the hook does not fire), and a no-op compaction ("Nothing to compact yet")
  writes no stale entry. Same `(stale — compacted)` UX, more accurate numbers.

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
- Tested against opencode **2.0.28** (OpenTUI catalog `0.5.17`).

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
- OpenTUI pinned `0.5.17`; tested against opencode **2.0.26**.

## 1.2.2 — 2026-10-08

- Maintenance release: internal restructuring and test-hardening only. No
  user-facing change.

## 1.2.1 — 2026-10-08

- The panel / percentage denominator now equals **opencode's compaction
  ceiling** (v2.0.23+ `calculateCeiling`: window = `limit.input ||
  limit.context`; reserve = max(10% of the window, 16k when the window is at
  least 32k)) — percentages read as "% to compaction", not "% of the raw
  window" (upstream #51271).
- `state.json`: new `reserve` field; the panel and `/context` show
  `compact at X (N reserve)`.
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
- Internal split into modules (no behavior change).

## 1.1.5 — 2026-10-02

- Security hardening: sanitized table metadata, validated `state.json`
  (prototype-poisoning keys dropped), ownership-safe state lock, tmp hygiene.

## 1.1.4 — 2026-10-02

- Fixed a stray `opencode/process` import in the TUI entry (bare `opencode/*`
  specifiers are not bridged at runtime).

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
