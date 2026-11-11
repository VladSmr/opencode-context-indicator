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
