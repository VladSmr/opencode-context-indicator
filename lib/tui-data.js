// lib/tui-data.js
//
// Data layer for the TUI entry (tui.ts): the state.json bridge (readSnapshot /
// isEmptyEntry / collectFamily), the shared formatting helpers (fmt / num / fit
// / updatedAt) and the family walk. Plain JS with JSDoc — same shape as
// lib/contributors.js — so tui.ts stays a thin setup shell and the node tooling
// (resolve gate, unit tests) can import it without a transform.
//
// These helpers must stay free of solid-js / @opentui imports: the TUI host
// bridges those modules only for the plugin bundle, and keeping this file pure
// means it also loads anywhere node does.
//
// state.json shape (written by writeStateFile() in index.js, untrusted input):
//   { [sessionID]: { sessionID, parentID, role, agent, model, providerID,
//     ctx, input, usable, reserve, limit, reasoning, categories{...},
//     toolOutByTool{name->tokens}, compactedAt, compactStale, updatedAt } }
// The authoritative TS mirror of the entry shape is the `StateEntry` interface
// in lib/tui-data.d.ts — keep the two structurally compatible.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeSessionKey, sumCategories } from "./estimate.js";
import { fmt, num } from "./format.js";

// Re-exported so the panel keeps importing it from this module; the
// implementation is the shared one (lib/estimate.js) — no second copy to drift.
export { toolOutEntries } from "./estimate.js";

// Same for the number helpers: lib/format.js is pure (no node builtins), so the
// Desktop GUI bundle can inline it, while the panel keeps importing them here.
export { fmt, num };

export const STATE_FILE =
  process.env.OPENCODE_CONTEXT_INDICATOR_STATE_FILE ||
  join(tmpdir(), "opencode-context-indicator-state.json");

export const POLL_MS = 1000;

// Whole state.json snapshot ({ sessionID: entry }) or {} on any error. The
// sidebar resolves one entry from it and the breakdown panel walks the
// parentID family over it. Never throws — a missing / empty / corrupt
// file simply yields {}.
export function readSnapshot() {
  try {
    const raw = readFileSync(STATE_FILE, "utf8")
    const all = JSON.parse(raw)
    if (!all || typeof all !== "object" || Array.isArray(all)) return {}
    // Rebuild into a fresh plain object: drops prototype-poisoning keys
    // (__proto__ / constructor / prototype) and non-object entries in one pass.
    const clean = {}
    for (const [k, v] of Object.entries(all)) {
      if (isSafeSessionKey(k) && v && typeof v === "object") clean[k] = v
    }
    return clean
  } catch {
    return {}
  }
}

// True when an entry carries no measured tokens at all (a registered session
// that never served a step). Mirrors isEmptyStateEntry() in lib/commands.js:
// `categories` is always persisted, so the emptiness test SUMS its fields —
// a missing categories object is not the only trigger. `system` / `toolSchemas`
// may legitimately be null, hence the num() coercion.
function isEmptyEntry(e) {
  return (
    sumCategories(e?.categories) === 0 &&
    num(e?.ctx) === 0 &&
    num(e?.input) === 0
  )
}

// The panel row set: the root entry (panel.sessionID) plus every entry whose
// parentID chain reaches it, breadth-first. A small local walk over the snapshot
// — the server's collectDescendantSessionIDs lives in lib/commands.js and is NOT
// imported here (the TUI entry stays independent of the server code by design). A
// phantom node (no tokens, see isEmptyEntry) is not emitted, but traversal still
// descends through it so real grandchildren behind it are found. `seen` guards
// against cycles (parentID loops) and double-listing.
export function collectFamily(snapshot, rootID) {
  const out = []
  // hasOwnProperty guard: a host-supplied rootID of "__proto__"/"constructor"
  // must never resolve through the prototype chain into a phantom row.
  const root = Object.prototype.hasOwnProperty.call(snapshot, rootID)
    ? snapshot[rootID]
    : undefined
  if (root && typeof root === "object") out.push(root)
  const seen = new Set([rootID])
  const queue = [rootID]
  // Index the snapshot by parentID once (O(n)) instead of an O(n) scan per node.
  const byParent = new Map()
  for (const [id, e] of Object.entries(snapshot)) {
    const pid = e?.parentID
    if (!pid || typeof pid !== "string") continue
    const kids = byParent.get(pid)
    if (kids) kids.push(id)
    else byParent.set(pid, [id])
  }
  while (queue.length > 0) {
    const cur = queue.shift()
    const kids = byParent.get(cur)
    if (!kids) continue
    for (const id of kids) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      const e = snapshot[id]
      if (e && !isEmptyEntry(e)) out.push(e)
      queue.push(id) // descend through phantom parents too
    }
  }
  return out
}

// Code-point-safe column fit: truncate on code points (never splitting a
// surrogate pair at a column boundary), mark a truncated cell with a trailing
// "~" so clipping is VISIBLE (a silently clipped cell reads as two columns
// colliding), then pad to the column width.
export function fit(s, w) {
  const cps = Array.from(s)
  if (cps.length > w) return `${cps.slice(0, Math.max(0, w - 1)).join("")}~`
  return s.padEnd(w)
}

export function updatedAt(iso) {
  if (!iso) return "?"
  try {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? "?" : d.toLocaleTimeString()
  } catch {
    return "?"
  }
}
