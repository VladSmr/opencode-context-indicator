# Internals and host notes

Background for the behaviours summarized in the [README](../README.md). This
file is shipped in the package as documentation; it is not required reading for
using the plugin.

## `/context-diff` delivery (`resume`)

`ctx.session.synthetic({ sessionID, text, description, resume })` durably
*admits* the message to the session **inbox**; the `resume` flag only gates
whether the session is woken (opencode `Session.synthetic`:
`if (resume !== false) wake(session)`):

| `resume` | Effect |
| --- | --- |
| `false` | durable inbox notice; **no** LLM request; session context unchanged. A synthetic message is rendered as a compact **Notice chip** whose label is `description ?? text` (the client row-builder maps `synthetic` to Notice) - so the chip shows the description, **not** the table. |
| `true` | the same inbox item **plus** a wake -> a real agent turn runs. The model sees the payload as input and its answer is a **normal assistant message**, rendered in full. |

The command uses `resume:true` with the payload wrapped in an explicit
`<context-diff>` tag, data first and one trailing "reply with only the content
above" line. A real agent turn runs and the model renders the tagged content as
a normal assistant message - the only way the content is visible in the Desktop
(the chip only shows `description`).

**Historical E2E note (Desktop 2.0.19, local model `llama3.2:latest`, `build`
agent).** `resume:true` behaved as designed: the synthetic item was drained into
`/message` and a turn ran; the assistant message contained the payload verbatim
(the trailing `_..._` note line was dropped by the model). Because `resume:true`
runs a **real agent turn with tools**, the model may additionally emit tool
calls - in the E2E it attempted one stray `edit` (harmless: the path did not
exist). Treat `/context-diff` as *"ask the agent to show the numbers"*, not as a
pure UI action.

**Failure path.** If `ctx.session.synthetic` throws, the command logs an
actionable error and the payload is preserved in `context-breakdown.log` (the
final-summaries section) while the plugin instance lives - there is no other
delivery channel in this runtime (no `noReply`/`prompt` option exists).

**Instruction echo.** Delivery is an agent turn: the model renders the payload,
and with the previous instruction wording it occasionally echoed the
instruction line itself. The instruction now delimits the payload with an
explicit `<context-diff>` tag, data first, and one short "reply with only the
content above" line last - an unambiguous payload boundary instead of a leading
"reproduce exactly" phrasing. The tail is a single clause on purpose (the
earlier four-clause version gave the model more text to paraphrase back), and a
unit check keeps it tag-free, single-line and at most 60 characters. Residual
risk: a model may still add light commentary or include the tag itself. Removing
the echo entirely would need a no-turn render channel, which this host does not
have: a `resume:false` notice renders only the `description` chip, not the
table.

## Family collection

The family collection shared by the Desktop panel RPC and the unit harness
discovers subagents by walking the **parentID chain persisted in `state.json`**
(breadth-first from the current session, every level - subagents of subagents
included). `state.json` is the only source: each entry is keyed by its own
`sessionID` and carries the `parentID` recorded when it was written, so the
chain is root-consistent and entries of *other* sessions are unreachable. A
`seen` set guards against cycles and double-listing. Subagents that already
finished stay listed while their `state.json` entry exists.

**Phantom sessions are hidden.** A session registered via `session.created`
but with no served step (no tokens in any category, `ctx = 0`, `input = 0`) -
e.g. an E2E/test registration or an agent ping without a turn - is skipped.
Traversal still descends through such a node so real grandchildren behind it are
found. The footer's `N subagent session(s)` counts only non-phantom rows.

**Budget and provenance.** Collection is parallel (root + all descendants) under
a single wall-clock deadline of 3.5 s, with each per-session live lookup capped
at 3 s - so a collection takes roughly the per-session cap (not the sum), rather
than N x 3 s for N subagents. Per session the data is resolved as: live
breakdown cache -> `state.json` snapshot -> a bounded `session.context()`
fallback. A session left with no category data (no cache/snapshot and the
fallback failed or ran out of budget) is tagged `no-data`; `ctx` / `model` /
`updatedAt` still come from `state.json` / the live lookup, while its category
cells stay `n/a`.

**Transient model-registry miss.** If the serving instance's `ctx.model.list()`
returns no usable limits (freshly loaded instance, provider not yet registered,
malformed payload), the window is recovered from the `state.json` snapshot
instead of degrading the `ctx` column to `?`; limits are also seeded from the
snapshot at startup, and the retry backs off (30 s -> 5 min, capped). A known
`usable`/`limit`/`agent` is never overwritten with `null` when another instance
rewrites the snapshot.

**Deleted sessions are dropped immediately.** A `session.deleted` event removes
the session's `state.json` entry - and every entry under it in the `parentID`
chain - instead of waiting for the 7-day tombstone prune, so the row leaves the
`/cx` picker and the Desktop panel at once. The removed IDs are remembered for
the lifetime of the instance (the host never reuses an ID), so a late idle/step
write, or a child that was still running when its parent was deleted, cannot
recreate the row - without that barrier it came back as a phantom ROOT session.
A state lock that is busy at delete time queues the removal for the next write
instead of losing it. The 7-day tombstone remains as the backstop for sessions
that vanish without an event.

## Compaction ceiling

The denominator is the **opencode 2.x compaction ceiling**:

```
window  = limit.input && limit.context ? min(limit.input, limit.context)
                                       : limit.input || limit.context
reserve = max(floor(window * 0.15), window >= 2 * 16_000 ? 16_000 : 0)
ceiling = window - reserve
```

This mirrors `calculateCeiling()` in
`packages/core/src/session/compaction.ts`, whose `RESERVE_SHARE` is 0.15 in every
released host from 2.1.4 through 2.2.7 (the merged PR #51271 description
mentions 10%, but the shipped code kept 15%; the reply cap from that PR,
`OUTPUT_TOKEN_MAX = 256_000`, sizes the output and does not move the trigger.
The unreleased `v2` branch has a different share and drops the
`min(input, context)` cap; the plugin follows the release, not the branch).
`node test/drift-watch.mjs` parses the released tag's `compaction.ts` and
`model-request.ts` and fails when this formula changes, so the plugin cannot
silently drift between manual audits.

A `compaction.buffer` configured in opencode itself (a token count or, since
2.2.5, a percentage such as `"20%"`) **is** honoured: the plugin API exposes no
config object, so the plugin reads the user's own `opencode.jsonc` /
`opencode.json` from `~/.config/opencode` (or `$XDG_CONFIG_HOME`) and from the
project directory, project winning over global. A percentage is converted
exactly like core (`Math.round(window * pct / 100)`); a buffer that is **not
smaller than the window** is ignored, exactly like core, so it can never leave
zero room. `OPENCODE_CONTEXT_INDICATOR_COMPACT_BUFFER` still overrides the
reserve for testing or custom setups (non-negative integer <= 1e9; invalid
values are silently ignored).

The lookup is per plugin instance (`ctx.location.directory`), so a process
hosting several locations never applies one project's buffer to another. One
caveat: the event stream is mirrored to every instance, so if two projects run
in one server process with **different** buffers, the last writer of a session's
state entry wins and that entry may briefly carry the other project's reserve.
Run separate servers when the buffers differ, or rely on the next request from
the owning instance to correct it.

## Why npm installs stay live

OpenCode skips its Solid/JSX transform for any file inside a `node_modules`
directory (upstream `anomalyco/opencode#33884`), so a JSX-built slot mounted from
an npm install rendered once and then froze on "no data yet". Since **1.8.0** the
package ships **no JSX syntax**. The single file that uses the runtime
`jsx()` helper is `lib/tui-h.ts`; because it has no JSX syntax, the host leaves
its literal `@opentui/solid/jsx-runtime` import alone and rewrites it to its own
in-process module. The package declares **no runtime dependencies**, so nothing
is installed next to it and there is no second Solid/OpenTUI instance to fight
with.

`test/prepublish.mjs` gate (b) rejects any `.tsx`/`.jsx` in the TUI surface, any
`@jsx*` pragma and any import outside the host-bridgeable allowlist; gate (c)
walks the real import graph and fails if a host-bridged module is a production
dependency. `test/e2e-tui.mjs` Check C packs the tarball, extracts it into a
throwaway `node_modules/opencode-context-indicator`, boots an isolated
`--standalone` TUI from there and asserts that a getter-driven probe node
actually re-renders.

## Desktop RPC contract

A Desktop window has no filesystem access, so the server part registers an
**RPC contract** (`lib/rpc.js`, id `context-indicator`, method `family`) that
answers with the root session plus every descendant; the GUI calls it through
`ctx.client.rpc()` and the contract is published as the `./rpc` export.

The panel **polls** every 1.5 s (the pill every 5 s) instead of subscribing to
events: the contract stays one method, a poll costs no provider call (the server
answers from `state.json` plus its in-memory caches once the session has been
measured; a session this instance never observed live costs at most one
`session.get()` per instance, not per poll), and polling recovers by itself when
the desktop app's background server restarts.

## `state.json` fields

Every entry carries: `sessionID`, `parentID`, `role`, `agent`, `model`,
`providerID`, `ctx`, `input`, `usable` (compaction ceiling), `reserve` (tokens
reserved for compaction), `limit` (context window), `reasoning`,
`categories{user,assistant,reasoning,toolArgs,toolOut,system,toolSchemas,other}`,
`source` (provenance: `context-hook` / `compaction-hook` (V2) / `transform` /
`system-transform` (V1) / `client-context` / `snapshot` - any hook-family source
wins, a fallback never overwrites it), `toolOutByTool` (per-tool repeated-output
estimate), `reclaim` (duplicate tool output, bounded), `cacheRead`/`cacheWrite`
(provider-reported prompt-cache tokens), `compactedAt`/`compactStale`, `previous`
(previous distinct measurement for `/context-diff`) and `updatedAt`.

## Shared `state.json`

The file is bounded by family, not by row. It keeps at most **1024 entries** and
**2 MB** (a soft size cap; measured rows are ~1.1 KB each), and evicts **whole
families** - the freshest first, never splitting one - because the `parentID`
chain is the only link the readers have: a missing intermediate row hides its
whole subtree from the BFS, and a missing root removes the family from `/cx` and
the Desktop panel entirely. A single family larger than a cap is kept whole
anyway (a split family is worse than a large file) and the next write logs
`state: evicted N families (...)` with the roots, row counts and reason, so a
loss is visible instead of silent.

The 7-day tombstone prune is family-aware on the same principle: a family is
expired only when its **newest** row is stale, so a resumed child cannot outlive
its deleted parent as an orphan root; a node that only points into a `parentID`
cycle belongs to that cycle's family; and the row the current write just
measured is pinned, so the write can never evict its own measurement. Byte
accounting counts the key and separator of every row, and the writer measures
the file it is about to write. The per-instance in-memory maps keep their own
smaller FIFO cap (256) - that one is RAM only and never touches the file.
