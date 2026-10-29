// lib/format.js
//
// Number formatting shared by every surface: the TUI sidebar and breakdown
// panel (re-exported from lib/tui-data.js, so existing imports keep working)
// and the Desktop GUI panel.
//
// Pure JS with no imports at all: the Desktop GUI bundle inlines this file, and
// a `node:*` import here would break the browser-side bundle.

// Compact token count: 12846 -> "12.8k", 940 -> "940".
export function fmt(n) {
  if (!Number.isFinite(n)) return "0"
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))
}

// Coerce any untrusted value (state.json is user-writable) to a finite number.
export function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}
