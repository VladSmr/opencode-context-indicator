// lib/tui-theme.js
//
// Theme-token helpers shared by the TUI components (sidebar + breakdown
// panel). Free of JSX and of solid-js imports so the file loads through any
// loader path.
//
// `Fg` mirrors OpenTUI's ColorInput (the type `fg` on <text> accepts); the
// JSDoc import below is type-only and erased at runtime.

/** @typedef {import("@opentui/core").ColorInput} Fg */

// Theme tokens are OpenTUI RGBA values (see ResolvedTheme.text.base/.muted);
// pass them straight to the renderer. Fall back to a named color when a token
// is absent so an unexpected theme shape can never blank the sidebar.
export function token(v, fallback) {
  return v && typeof v === "object" ? v : fallback
}
