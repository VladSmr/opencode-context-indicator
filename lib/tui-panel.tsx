/** @jsxImportSource @opentui/solid */
// lib/tui-panel.tsx — the `session.panel` component (BreakdownPanel), moved
// verbatim from tui.tsx when the TUI entry was split: the host's Solid
// transform applies to EVERY plugin file outside node_modules
// (solid-plugin.js sourceFilter in @opentui/solid), so JSX in imported files
// is compiled the same way as in the entry.

import { usePlugin } from "@opencode/plugin/tui"
import { createMemo, Show } from "solid-js"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import type { StateEntry } from "./tui-data.js"
import { collectFamily, fit, fmt, num, updatedAt } from "./tui-data.js"
import { token } from "./tui-theme.js"
import {
  buildRedactedPayload,
  contributorLine,
  exportFileName,
  measureContributors,
  panelDenom,
  panelRole,
  safeText,
} from "./contributors.js"

// Mirrors the Contributor shape produced by measureContributors()
// (lib/contributors.js).
type Contributor = {
  kind: string
  ref: string
  chars: number
  tokensEstimate: number
  tool: string
  preview: string
}

// Host-owned session.panel input ({ name, sessionID, width, presentation,
// focused, focus(), close(), toggleFullscreen() }). Typed structurally instead
// of imported so this file stays independent of the host type package; the host
// resolves the panel API at runtime.
type PanelInput = {
  readonly name: string
  readonly sessionID: string
  readonly width: number
  readonly presentation: "panel" | "fullscreen"
  readonly focused: boolean
  readonly focus: () => void
  readonly close: () => void
  readonly toggleFullscreen: () => void
}

// The TUI message data API is optional across host versions. Log a single hint
// (never once per poll) when it is unavailable and hide the whole section.
let warnedMessagesUnavailable = false

// Panel column layout (monospace), derived from the host-provided panel width
// so cells never collide on narrow terminals. Gaps between columns keep a
// truncated cell visually separated from its neighbour.
const GUTTER = 2
const CTX_WIDTH = 12

function panelLayout(panelWidth: number): {
  roleW: number
  modelW: number
  ctxW: number
  updW: number
  gutter: string
} {
  const w = num(panelWidth) > 0 ? num(panelWidth) : 60
  const ctxW = CTX_WIDTH
  const updW = Math.max(5, Math.min(8, w - ctxW - 3 * GUTTER - 24))
  const roleW = Math.max(12, Math.min(20, Math.floor(w * 0.3)))
  const modelW = Math.max(10, w - roleW - ctxW - updW - 3 * GUTTER)
  return { roleW, modelW, ctxW, updW, gutter: " ".repeat(GUTTER) }
}

// Full session panel: header + one row per session in the family (root plus
// subagent descendants). It reads the same state.json bridge as the sidebar via
// the shared 1 s tick, so both surfaces refresh on ONE poll. `panel.sessionID`
// selects the root; `cx` opens the panel (registered from the "app" slot in
// tui.tsx).
export function BreakdownPanel(props: {
  panel: PanelInput
  snapshot: () => Record<string, StateEntry>
  refresh: () => void
}) {
  const context = usePlugin()
  const base = () => token(context?.theme?.text?.base, "white")
  const muted = () => token(context?.theme?.text?.muted, base())

  // Panel-local keys. The layer is owned by this component and disposed with it.
  // mode "global" + an explicit focused check is the portable fallback when no
  // target renderable is available: the keys act only while the panel owns input.
  // The capability guard keeps an older host (no keymap API) from throwing.
  const keymap = context?.keymap
  if (keymap && typeof keymap.layer === "function") {
    keymap.layer(() => ({
      mode: "global",
      priority: -1,
      commands: [
        {
          id: "context-indicator.breakdown.close",
          title: "Close the context breakdown panel",
          bind: "escape",
          enabled: () => props.panel.focused,
          run: () => {
            if (props.panel.focused) props.panel.close()
          },
        },
        {
          id: "context-indicator.breakdown.refresh",
          title: "Refresh the context breakdown panel",
          bind: "r",
          enabled: () => props.panel.focused,
          run: () => {
            if (props.panel.focused) props.refresh()
          },
        },
        {
          id: "context-indicator.breakdown.export",
          title: "Export a redacted breakdown snapshot",
          bind: "e",
          enabled: () => props.panel.focused,
          run: () => {
            if (props.panel.focused) exportRedacted()
          },
        },
      ],
    }))
  }

  // One snapshot read per poll tick (props.snapshot tracks the shared tick), so
  // the memo recomputes together with the sidebar instead of polling separately.
  const data = createMemo(() => {
    const snap = props.snapshot()
    return {
      root: snap[props.panel.sessionID],
      rows: collectFamily(snap, props.panel.sessionID),
    }
  })

  // Live message list from the TUI data layer (in-process, no LLM call). The
  // shared `props.snapshot()` tick is read FIRST so this re-reads every poll.
  // `available: false` means the API is absent/errored -> the WHOLE measured
  // section is hidden (and a one-time hint was logged).
  const messages = createMemo<{ available: boolean; list: unknown[] }>(() => {
    props.snapshot()
    try {
      const api = context?.data?.session?.message
      if (!api || typeof api.list !== "function") {
        if (!warnedMessagesUnavailable) {
          warnedMessagesUnavailable = true
          console.error(
            "[context-indicator] TUI message data API unavailable; " +
              "measured contributors section hidden",
          )
        }
        return { available: false, list: [] }
      }
      const v = api.list(props.panel.sessionID)
      return { available: true, list: Array.isArray(v) ? v : [] }
    } catch {
      if (!warnedMessagesUnavailable) {
        warnedMessagesUnavailable = true
        console.error(
          "[context-indicator] TUI message read failed; " +
            "measured contributors section hidden",
        )
      }
      return { available: false, list: [] }
    }
  })

  const contributors = createMemo<Contributor[]>(() => {
    const m = messages()
    if (!m.available) return []
    try {
      return measureContributors(m.list)
    } catch {
      return []
    }
  })

  // Redacted export (key `e`). No message text, no full session id, no tool
  // output content ever leaves this function. Never throws: a failure logs and
  // shows an error toast instead.
  function exportRedacted(): void {
    let exportedName: string | null = null
    try {
      const now = new Date()
      const name = exportFileName(props.panel.sessionID, now)
      const payload = buildRedactedPayload({
        sessionID: props.panel.sessionID,
        root: data().root,
        rows: data().rows,
        contributors: contributors(),
        now,
        panelDenom,
        panelRole,
        num,
      })
      const dir = join(tmpdir(), "opencode-context-indicator", "exports")
      const file = join(dir, name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, JSON.stringify(payload, null, 2), "utf8")
      exportedName = basename(file)
    } catch (err) {
      console.error("[context-indicator] redacted export failed:", err)
      try {
        context?.ui?.toast?.show({
          message: "redacted export failed",
          variant: "error",
        })
      } catch {
        /* toast is best-effort */
      }
      return
    }
    // Outside the write try: a toast failure must not report the export as
    // failed when the file is already on disk.
    try {
      context?.ui?.toast?.show({
        message: `exported ${exportedName}`,
        variant: "success",
      })
    } catch {
      /* toast is best-effort */
    }
  }

  const header = (): string => {
    const r = data().root
    if (!r) return "Context breakdown"
    const model = safeText(r.model && r.model !== "unknown" ? r.model : "model?")
    const ctx = fmt(num(r.ctx))
    const d = panelDenom(r)
    return d > 0
      ? `Context breakdown \u2014 ${model} ${ctx}/${fmt(d)} (${Math.round(
          (num(r.ctx) / d) * 100,
        )}%)`
      : `Context breakdown \u2014 ${model} ${ctx}`
  }

  const layout = (): {
    roleW: number
    modelW: number
    ctxW: number
    updW: number
    gutter: string
  } => panelLayout(props.panel.width)

  const columns = (): string => {
    const L = layout()
    return (
      fit("role", L.roleW) +
      L.gutter +
      fit("model", L.modelW) +
      L.gutter +
      fit("ctx", L.ctxW) +
      L.gutter +
      "updated"
    )
  }

  const row = (e: StateEntry, isMain: boolean): string => {
    const model = safeText(e.model && e.model !== "unknown" ? e.model : "model?")
    const d = panelDenom(e)
    const ctx =
      d > 0
        ? `${fmt(num(e.ctx))} (${Math.round((num(e.ctx) / d) * 100)}%)`
        : fmt(num(e.ctx))
    const L = layout()
    return (
      fit(panelRole(e, isMain), L.roleW) +
      L.gutter +
      fit(model, L.modelW) +
      L.gutter +
      fit(ctx, L.ctxW) +
      L.gutter +
      updatedAt(e.updatedAt)
    )
  }

  return (
    <box flexDirection="column">
      <text fg={base()}>{header()}</text>
      <Show
        when={data().root}
        fallback={<text fg={muted()}>{"  no data yet"}</text>}
      >
        <text fg={muted()}>{columns()}</text>
        {data().rows.map((e, i) => (
          <text fg={muted()}>{row(e, i === 0)}</text>
        ))}
        <Show
          when={
            (data().root?.usable ?? 0) > 0
          }
        >
          <text fg={muted()}>
            {"  compact at " +
              fmt(num(data().root?.usable)) +
              (num(data().root?.reserve) > 0
                ? " (" + fmt(num(data().root?.reserve)) + " reserve)"
                : "")}
          </text>
        </Show>
        <Show when={messages().available}>
          <text fg={base()}>{"largest contributors (measured)"}</text>
          <Show
            when={contributors().length > 0}
            fallback={<text fg={muted()}>{"  no messages yet"}</text>}
          >
            {contributors()
              .slice(0, 5)
              .map((c, i) => (
                <text fg={muted()}>{contributorLine(c, i + 1)}</text>
              ))}
          </Show>
          <text fg={muted()}>
            {
              "measured != server categories (tool outputs counted here; server categories exclude them)"
            }
          </text>
        </Show>
      </Show>
    </box>
  )
}
