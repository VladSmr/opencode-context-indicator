// lib/tui-data.js
//
// Data layer for the TUI entry (tui.tsx): the state.json bridge (readSnapshot /
// isEmptyEntry / collectFamily), the shared formatting helpers (fmt / num / fit
// / updatedAt) and the npm-install detection. Plain JS with JSDoc — same shape
// as lib/contributors.js — so tui.tsx stays a thin JSX/setup shell and the node
// tooling (resolve gate, future unit tests) can import it without a transform.
//
// These helpers must stay free of solid-js / @opentui imports: the TUI host
// bridges those modules only for the JSX entry, and keeping this file pure
// means it also loads anywhere node does.
//
// state.json shape (written by writeStateFile() in index.js, untrusted input):
//   { [sessionID]: { sessionID, parentID, role, agent, model, providerID,
//     ctx, input, usable, reserve, limit, reasoning, categories{...}, updatedAt } }
// The authoritative TS mirror of the entry shape is the `StateEntry` interface
// in lib/tui-data.d.ts — keep the two structurally compatible.

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const STATE_FILE =
  process.env.OPENCODE_CONTEXT_INDICATOR_STATE_FILE ||
  join(tmpdir(), "opencode-context-indicator-state.json");

export const POLL_MS = 1000;

// True when this package was loaded from an npm install, i.e. its own file
// path contains a `node_modules` segment (OpenCode's TUI loader skips the host
// Solid transform for such paths → slots mount once but never live-update; see
// the Graceful mode note in tui.tsx). Normalised to forward slashes for
// Windows paths. ANY file of the package yields the same answer, so checking
// from lib/ is equivalent to checking from the tui.tsx entry.
export function isNodeModulesInstall() {
  try {
    const selfPath = fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase()
    return selfPath.includes("/node_modules/")
  } catch {
    return false
  }
}

// Reserved object keys must never be treated as session ids: state.json is
// untrusted input (structural mirror of isSafeSessionKey() in lib/estimate.js,
// including the string/length requirement).
function isSafeKey(k) {
  return (
    typeof k === "string" &&
    k.length > 0 &&
    k !== "__proto__" &&
    k !== "constructor" &&
    k !== "prototype"
  )
}

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
      if (isSafeKey(k) && v && typeof v === "object") clean[k] = v
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
  const c = e?.categories
  const sum =
    num(c?.user) +
    num(c?.assistant) +
    num(c?.reasoning) +
    num(c?.toolArgs) +
    num(c?.system) +
    num(c?.toolSchemas) +
    num(c?.other)
  return sum === 0 && num(e?.ctx) === 0 && num(e?.input) === 0
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

export function fmt(n) {
  if (!Number.isFinite(n)) return "0"
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))
}

export function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
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
