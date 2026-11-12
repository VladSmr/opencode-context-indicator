// lib/format.js
//
// Number formatting shared by every surface: the TUI sidebar and breakdown
// panel (re-exported from lib/tui-data.js, so existing imports keep working)
// and the Desktop GUI panel.
//
// Pure JS with no imports at all: the Desktop GUI bundle inlines this file, and
// a `node:*` import here would break the browser-side bundle.

// Compact token count: 12846 -> "12.8k", 940 -> "940", 10300000 -> "10.3M".
// The millions step matters for family totals: one measured family added up to
// 10.3M tokens across 146 sessions, and "10328.7k" is both unreadable and too
// wide for the TUI panel. The 999_950 boundary keeps 999999 from printing as
// "1000.0k".
export function fmt(n) {
  if (!Number.isFinite(n)) return "0"
  const abs = Math.abs(n)
  if (abs >= 999_950) return `${(n / 1e6).toFixed(1)}M`
  return abs >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))
}

// Coerce any untrusted value (state.json is user-writable) to a finite number.
export function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

// Sum of each session's own context usage across a family. Every session has its
// OWN window, so this is a total of tokens used, not one window's occupancy;
// non-finite and negative values are ignored (rows can come from state.json).
export function sumCtx(rows) {
  let total = 0
  for (const r of Array.isArray(rows) ? rows : []) {
    const n = num(r && typeof r === "object" ? r.ctx : null)
    if (n > 0) total += n
  }
  return total
}

// How many CHILD rows the TUI /cx panel and the Desktop tab render before the
// "+N more" tail. One measured family had 145 subagent sessions: the total row
// is pinned above the list, but the list itself was several screens long.
export const MAX_FAMILY_ROWS = 20

// Split a family walk (root first, children in walk order) into the rows both
// surfaces render and the tail. Children are sorted heaviest-first so the
// sessions that actually eat a window are the ones kept; the root never counts
// against the cap. `hiddenCtx` keeps the tail honest: the total row still sums
// EVERY row (sumCtx), and the tail says what the hidden rows add up to.
export function splitFamily(rows, limit = MAX_FAMILY_ROWS) {
  const list = Array.isArray(rows) ? rows : []
  const cap =
    Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : MAX_FAMILY_ROWS
  const root = list.length > 0 ? list[0] : null
  const children = list.slice(1).sort((a, b) => num(b?.ctx) - num(a?.ctx))
  const shown = children.slice(0, cap)
  const hidden = children.slice(shown.length)
  return { root, shown, hidden, hiddenCtx: sumCtx(hidden) }
}

// One-line summary of the rows a surface does NOT render. `hidden` is the array
// splitFamily() returned, `total` is the whole family sum (sumCtx(rows)). The
// text is what the TUI prints; the desktop tail uses the parts (it lays count
// and amount out in two columns). `percent` is null when the total is not a
// usable denominator, and the text then omits the share instead of printing
// "(NaN%)" or "(0%)" for an empty family.
export function familyTail(hidden, total) {
  const rows = Array.isArray(hidden) ? hidden : []
  const hiddenCtx = sumCtx(rows)
  const pct = Number.isFinite(total) && total > 0 ? Math.round((hiddenCtx / total) * 100) : null
  const text = `+${rows.length} more - ${fmt(hiddenCtx)}${pct === null ? "" : ` (${pct}%)`}`
  return { count: rows.length, hiddenCtx, percent: pct, text }
}
