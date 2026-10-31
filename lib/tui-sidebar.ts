// lib/tui-sidebar.ts — the `sidebar.content` slot component.
//
// No JSX and no `@jsxImportSource` pragma anywhere in this file: see the long
// explanation at the top of lib/tui-h.ts. Every dynamic prop is a getter, which
// is exactly what the Solid compiler would have emitted for `prop={expr}`.
//
// This file lives in lib/ rather than in the tui.ts entry because the sidebar
// is the surface that renders the per-category breakdown; the entry stays a
// thin setup shell.

import { usePlugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import type { StateEntry } from "./tui-data.js"
import { fmt, num, updatedAt } from "./tui-data.js"
import { token } from "./tui-theme.js"
import { c, h } from "./tui-h.ts"

// Sidebar category-label column width (monospace), used by the `line()` helper.
const LABEL_WIDTH = 12

export function Sidebar(props: { entry: () => StateEntry | null }) {
  const context = usePlugin()
  const base = () => token(context?.theme?.text?.base, "white")
  const muted = () => token(context?.theme?.text?.muted, base())

  const e = () => props.entry()

  const denom = (): number | null => {
    const x = e()
    const d = x?.usable ?? x?.limit
    return typeof d === "number" && d > 0 ? d : null
  }
  const pct = (v: number): string => {
    const d = denom()
    return d ? `${Math.round((v / d) * 100)}%` : ""
  }
  const line = (label: string, v: unknown): string => {
    const n = num(v)
    const l = (label + " ".repeat(LABEL_WIDTH)).slice(0, LABEL_WIDTH)
    const p = pct(n)
    return `${l}${fmt(n).padStart(7)}${p ? `  ${p.padStart(4)}` : ""}`
  }
  const header = (): string => {
    const x = e()
    if (!x) return ""
    const d = denom()
    return `${x.model ?? "?"} · ${fmt(num(x.ctx))}${
      d ? ` / ${fmt(d)}` : ""
    }${d ? ` (${pct(num(x.ctx))})` : ""}`
  }

  // One muted category row. The accessor is called INSIDE the getter: the row
  // element is created once and then updates in place on every poll, exactly
  // like `<text fg={muted()}>{line(...)}</text>` in JSX.
  const row = (label: string, value: () => unknown) =>
    h("text", {
      get fg() {
        return muted()
      },
      get children() {
        return line(label, value())
      },
    })

  // `system` and `tool schemas` are absent from state files written by older
  // plugin versions (null) and render as "n/a" instead of a zero row.
  const optionalRow = (label: string, value: () => number | null | undefined) =>
    h("text", {
      get fg() {
        return muted()
      },
      get children() {
        const v = value()
        return v == null
          ? `${label.padEnd(LABEL_WIDTH)}     n/a`
          : line(label, v)
      },
    })

  return h("box", {
    flexDirection: "column",
    get children() {
      return [
        h("text", {
          get fg() {
            return base()
          },
          get children() {
            return "Context"
          },
        }),
        c(Show, {
          get when() {
            return e()
          },
          get fallback() {
            return h("text", {
              get fg() {
                return muted()
              },
              get children() {
                return "  no data yet"
              },
            })
          },
          get children() {
            return [
              h("text", {
                get fg() {
                  return base()
                },
                get children() {
                  return header()
                },
              }),
              row("user", () => e()?.categories?.user),
              row("assistant", () => e()?.categories?.assistant),
              row("reasoning", () => e()?.categories?.reasoning),
              row("tool args", () => e()?.categories?.toolArgs),
              row("tool out", () => e()?.categories?.toolOut),
              optionalRow("system", () => e()?.categories?.system),
              optionalRow("tool schemas", () => e()?.categories?.toolSchemas),
              row("other", () => e()?.categories?.other),
              c(Show, {
                get when() {
                  return e()?.compactStale === true
                },
                get children() {
                  return h("text", {
                    get fg() {
                      return muted()
                    },
                    get children() {
                      return "  stale — compacted"
                    },
                  })
                },
              }),
              h("text", {
                get fg() {
                  return muted()
                },
                get children() {
                  return `updated ${updatedAt(e()?.updatedAt)}`
                },
              }),
            ]
          },
        }),
      ]
    },
  })
}
