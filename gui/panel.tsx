// gui/panel.tsx
//
// The Desktop side-panel tab: the same numbers as /context-breakdown and the
// TUI panel, laid out for a narrow region. This file is bundled by Vite
// (vite.gui.config.mjs), NOT by the OpenTUI transform - it renders DOM in the
// desktop app's window, so there is no @opentui pragma and no OpenTUI import.
//
// Data comes from the server part over the RPC contract in lib/rpc.js: a window
// has no filesystem access, so reading state.json here is not possible. The
// panel polls instead of subscribing to events: the contract stays one method,
// the call is cheap once the per-session caches are warm, and a poll recovers by
// itself after the desktop app's background server restarts (ctx.client is read
// on every call for exactly that reason).

import { For, Show, createEffect, createSignal, onCleanup } from "solid-js"
import { usePlugin, type MountedSession } from "@opencode/plugin/gui"
import { DesktopContextRpc } from "../lib/rpc.js"
import type { DesktopFamilyResult, DesktopRow } from "../lib/rpc.js"
import { fmt } from "../lib/format.js"

const POLL_MS = 1500

// Order matters: the biggest movers (system prompt and tool schemas are fixed
// cost, the conversation grows) read top-down like the TUI panel.
const CATEGORIES = [
  ["system", "System"],
  ["toolSchemas", "Tool schemas"],
  ["user", "User"],
  ["assistant", "Assistant"],
  ["reasoning", "Reasoning"],
  ["toolArgs", "Tool args"],
  ["toolOut", "Tool output"],
  ["other", "Other"],
] as const

function timeOnly(iso: string): string {
  if (!iso) return "?"
  try {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? "?" : d.toLocaleTimeString()
  } catch {
    return "?"
  }
}

function percent(part: number, total: number): string {
  if (!total || total <= 0) return ""
  return `${((part / total) * 100).toFixed(0)}%`
}

// Grid-like rows without a table element: a table would fight the host's row
// heights in a narrow region, and every value is a single short cell.
const styles = {
  panel: {
    display: "flex",
    "flex-direction": "column",
    gap: "10px",
    padding: "12px",
    "font-size": "12px",
    "line-height": "1.45",
  },
  hint: {
    opacity: "0.65",
    "font-size": "12px",
  },
  header: {
    display: "flex",
    "align-items": "baseline",
    "justify-content": "space-between",
    gap: "8px",
  },
  model: {
    "font-weight": "600",
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
  },
  total: {
    "font-variant-numeric": "tabular-nums",
    "white-space": "nowrap",
  },
  section: {
    display: "flex",
    "flex-direction": "column",
    gap: "6px",
  },
  row: {
    display: "grid",
    "grid-template-columns": "1fr auto 64px auto",
    "align-items": "center",
    gap: "6px",
  },
  label: {
    opacity: "0.8",
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
  },
  value: {
    "font-variant-numeric": "tabular-nums",
  },
  track: {
    height: "4px",
    "border-radius": "2px",
    background: "currentColor",
    opacity: "0.15",
    overflow: "hidden",
  },
  fill: {
    height: "4px",
    "border-radius": "2px",
    background: "currentColor",
    opacity: "0.9",
  },
  share: {
    opacity: "0.65",
    "text-align": "right",
    "font-variant-numeric": "tabular-nums",
  },
  meta: {
    display: "flex",
    gap: "8px",
    opacity: "0.6",
    "font-size": "11px",
  },
  sub: {
    display: "flex",
    "justify-content": "space-between",
    gap: "8px",
    "font-size": "11px",
  },
  subName: {
    overflow: "hidden",
    "text-overflow": "ellipsis",
    "white-space": "nowrap",
    opacity: "0.85",
  },
  title: {
    "font-weight": "600",
    opacity: "0.85",
  },
} as const

export function ContextPanel(props: { session: MountedSession }) {
  const ctx = usePlugin()
  const [rows, setRows] = createSignal<readonly DesktopRow[]>([])
  const [error, setError] = createSignal("")
  const [loaded, setLoaded] = createSignal(false)

  createEffect(() => {
    const sessionID = props.session.id
    // One request at a time: the poll period (1.5 s) is shorter than the
    // server's collect budget, so overlapping calls could resolve out of order.
    let pending = false
    let disposed = false
    setLoaded(false)
    // Never show another session's numbers while this one loads.
    setRows([])
    setError("")

    const load = async () => {
      if (disposed || pending) return
      pending = true
      try {
        const result = (await ctx.client
          .rpc(DesktopContextRpc)
          .family({ sessionID })) as DesktopFamilyResult | undefined
        if (disposed) return
        setRows(Array.isArray(result?.rows) ? result.rows : [])
        setError("")
      } catch (err) {
        // A missing server part, an older plugin build or a restarting server
        // all land here: keep the last rows, show the reason above them.
        if (disposed) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        pending = false
        if (!disposed) setLoaded(true)
      }
    }

    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    onCleanup(() => {
      disposed = true
      clearInterval(timer)
    })
  })

  const root = () => rows()[0]
  const children = () => rows().slice(1)

  const barWidth = (tokens: number) => {
    const total = root()?.ctx || 0
    if (total <= 0 || tokens <= 0) return "0%"
    return `${Math.min(100, Math.max(2, Math.round((tokens / total) * 100)))}%`
  }

  return (
    <div style={styles.panel}>
      <Show when={loaded()} fallback={<div style={styles.hint}>Loading context...</div>}>
        <Show when={error()}>
          <div style={styles.hint}>
            Server part unavailable: {error()} (retrying)
          </div>
        </Show>
        <Show
          when={root()}
          fallback={
            // Nothing measured yet - but only say so when the server part is
            // actually answering; otherwise the hint above explains why.
            <Show when={!error()}>
              <div style={styles.hint}>
                No measurement yet. Send a prompt in this session and the numbers
                appear here.
              </div>
            </Show>
          }
        >
          {(row) => (
            <>
              <div style={styles.header}>
                <span style={styles.model} title={row().modelID}>
                  {row().modelID || "unknown model"}
                </span>
                <span style={styles.total}>
                  {fmt(row().ctx)}
                  {row().usable > 0
                    ? ` / ${fmt(row().usable)} (${percent(row().ctx, row().usable)})`
                    : ""}
                </span>
              </div>

              <div style={styles.section}>
                <For each={CATEGORIES}>
                  {(category) => (
                    <div style={styles.row}>
                      <span style={styles.label}>{category[1]}</span>
                      <span style={styles.value}>{fmt(row()[category[0]])}</span>
                      <span style={styles.track}>
                        <span
                          style={{
                            ...styles.fill,
                            display: "block",
                            width: barWidth(row()[category[0]]),
                          }}
                        />
                      </span>
                      <span style={styles.share}>
                        {percent(row()[category[0]], row().ctx)}
                      </span>
                    </div>
                  )}
                </For>
              </div>

              <div style={styles.meta}>
                <span>{timeOnly(row().updatedAt)}</span>
                <span>{row().source || "none"}</span>
                <Show when={row().stale}>
                  <span>stale after compaction</span>
                </Show>
                <Show when={row().reserve > 0}>
                  <span>reserve {fmt(row().reserve)}</span>
                </Show>
              </div>

              <Show when={children().length > 0}>
                <div style={styles.title}>
                  Subagents ({children().length})
                </div>
                <div style={styles.section}>
                  <For each={children()}>
                    {(child) => (
                      <div style={styles.sub}>
                        <span style={styles.subName} title={child.modelID}>
                          {child.agent || "sub"}
                        </span>
                        <span style={styles.value}>
                          {fmt(child.ctx)}
                          {child.usable > 0
                            ? ` (${percent(child.ctx, child.usable)})`
                            : ""}
                        </span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </>
          )}
        </Show>
      </Show>
    </div>
  )
}
