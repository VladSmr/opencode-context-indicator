/** @jsxImportSource @opentui/solid */
// lib/tui-sidebar.tsx — the `sidebar.content` slot component. Moved verbatim
// from tui.tsx when the TUI entry was split: the host's Solid transform
// applies to EVERY plugin file outside node_modules (solid-plugin.js
// sourceFilter in @opentui/solid), so JSX in imported files is compiled the
// same way as in the entry.

import { usePlugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import type { StateEntry } from "./tui-data.js"
import { fmt, num, updatedAt } from "./tui-data.js"
import { token } from "./tui-theme.js"

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

  return (
    <box flexDirection="column">
      <text fg={base()}>{"Context"}</text>
      <Show when={e()} fallback={<text fg={muted()}>{"  no data yet"}</text>}>
        <text fg={base()}>{header()}</text>
        <text fg={muted()}>{line("user", e()?.categories?.user)}</text>
        <text fg={muted()}>{line("assistant", e()?.categories?.assistant)}</text>
        <text fg={muted()}>{line("reasoning", e()?.categories?.reasoning)}</text>
        <text fg={muted()}>{line("tool args", e()?.categories?.toolArgs)}</text>
        <text fg={muted()}>
          {e()?.categories?.system == null
            ? `${"system".padEnd(LABEL_WIDTH)}     n/a`
            : line("system", e()?.categories?.system)}
        </text>
        <text fg={muted()}>
          {e()?.categories?.toolSchemas == null
            ? `${"tool schemas".padEnd(LABEL_WIDTH)}     n/a`
            : line("tool schemas", e()?.categories?.toolSchemas)}
        </text>
        <text fg={muted()}>{line("other", e()?.categories?.other)}</text>
        <text fg={muted()}>{`updated ${updatedAt(e()?.updatedAt)}`}</text>
      </Show>
    </box>
  )
}
