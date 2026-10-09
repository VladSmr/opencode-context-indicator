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
const COST_WIDTH = 8

function panelLayout(panelWidth: number): {
  roleW: number
  modelW: number
  ctxW: number
  costW: number
  updW: number
  gutter: string
} {
  const w = num(panelWidth) > 0 ? num(panelWidth) : 60
  const ctxW = CTX_WIDTH
  const costW = COST_WIDTH
  const updW = Math.max(5, Math.min(8, w - ctxW - 4 * GUTTER - 24))
  const roleW = Math.max(12, Math.min(20, Math.floor(w * 0.28)))
  const modelW = Math.max(8, w - roleW - ctxW - costW - updW - 4 * GUTTER)
  return { roleW, modelW, ctxW, costW, updW, gutter: " ".repeat(GUTTER) }
}

// Dollar formatting for the cost column: compact, always `$`-prefixed, `-`
// when the host data layer has no cost for the session.
function money(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "-"
  const a = Math.abs(n)
  if (a >= 1000) return `$${(n / 1000).toFixed(1)}k`
  if (a >= 100) return `$${n.toFixed(1)}`
  return `$${n.toFixed(2)}`
}

// The topmost ancestor of the panel's session: `/cx` opened from a subagent
// session view must show the WHOLE family (rooted at the main session), not
// just the child subtree. Walks parentID upward over the snapshot; `seen`
// guards against parentID loops.
function resolveRoot(
  snapshot: Record<string, StateEntry>,
  sessionID: string,
): string {
  let current = sessionID
  const seen = new Set<string>([current])
  for (;;) {
    const entry = Object.prototype.hasOwnProperty.call(snapshot, current)
      ? snapshot[current]
      : undefined
    const parent = entry?.parentID
    if (
      !parent ||
      typeof parent !== "string" ||
      !Object.prototype.hasOwnProperty.call(snapshot, parent) ||
      seen.has(parent)
    ) {
      break
    }
    seen.add(parent)
    current = parent
  }
  return current
}

// Full session panel: header + one row per session in the family (root plus
// subagent descendants). It reads the same state.json bridge as the sidebar via
// the shared 1 s tick, so both surfaces refresh on ONE poll. The family is
// rooted at the panel session's TOPMOST ancestor, so opening the panel from a
// subagent view shows the whole family. `cx` opens the panel (registered from
// the "app" slot in tui.tsx; also reachable from the command palette, since
// subagent views have no prompt input).
export function BreakdownPanel(props: {
  panel: PanelInput
  snapshot: () => Record<string, StateEntry>
  refresh: () => void
}) {
  const context = usePlugin()
  const base = () => token(context?.theme?.text?.base, "white")
  const muted = () => token(context?.theme?.text?.muted, base())

  // The host session data layer, re-read per call: individual accessors
  // (family/get/status/cost) are optional across host versions and every use
  // site guards them separately.
  const dataApiSession = () => context?.data?.session

  // Set while the picker dialog is on screen: the panel-local `s` key must not
  // re-trigger the picker (a printable key typed into the dialog search would
  // otherwise stack dialogs — the guard is belt-and-braces for hosts where the
  // panel keeps focus while a dialog is open).
  let pickerOpen = false

  // Per-session cost from the host data layer (read under the shared poll tick,
  // so it refreshes reactively). For a ROOT session the host AGGREGATES the
  // whole family; for a child it is that session's own cost — exactly the
  // per-subagent spend visibility the community asked for (upstream #45417).
  // Guarded: older hosts may not expose the accessor.
  const costOf = (sessionID: string | undefined): number | null => {
    if (!sessionID) return null
    try {
      const cost = context?.data?.session?.cost?.(sessionID)
      return typeof cost === "number" && Number.isFinite(cost) ? cost : null
    } catch {
      return null
    }
  }

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
        {
          id: "context-indicator.breakdown.pick",
          title: "Pick a family session",
          bind: "s",
          enabled: () => props.panel.focused && !pickerOpen,
          run: () => {
            if (props.panel.focused && !pickerOpen) openPicker()
          },
        },
      ],
    }))
  }

  // One snapshot read per poll tick (props.snapshot tracks the shared tick), so
  // the memo recomputes together with the sidebar instead of polling separately.
  // The family is rooted at the topmost ancestor (resolveRoot): from a subagent
  // view the whole family is shown, not just the child subtree.
  const data = createMemo(() => {
    const snap = props.snapshot()
    const rootID = resolveRoot(snap, props.panel.sessionID)
    return {
      root: snap[rootID],
      rows: collectFamily(snap, rootID),
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

  // Navigate to a family session: root sessions focus their tab (tab-aware,
  // opens one when needed); child sessions navigate the route directly (tabs
  // are root-session scoped). Falls back with a toast when the host exposes
  // neither mechanism.
  function navigateTo(sessionID: string): void {
    try {
      const ui = context?.ui
      // Child detection is three-sourced: the host session info, OUR snapshot
      // (state.json parentID), and the host root() accessor — get() alone can
      // miss a session that has not been synced into the client store yet, and
      // tabs.focus() on a child ID would target the wrong (root) tab.
      let isChild = false
      try {
        const info = context?.data?.session?.get?.(sessionID)
        isChild = !!(
          info &&
          typeof info === "object" &&
          (info as Record<string, unknown>).parentID
        )
      } catch {
        /* other sources below */
      }
      if (!isChild) {
        const snapParent = props.snapshot()[sessionID]?.parentID
        if (typeof snapParent === "string" && snapParent.length > 0) isChild = true
      }
      if (!isChild && typeof context?.data?.session?.root === "function") {
        try {
          if (context.data.session.root(sessionID) !== sessionID) isChild = true
        } catch {
          /* treat as root */
        }
      }
      if (!isChild && ui?.tabs && typeof ui.tabs.focus === "function") {
        if (ui.tabs.focus(sessionID)) return
      }
      if (ui?.router && typeof ui.router.navigate === "function") {
        ui.router.navigate({ type: "session", sessionID })
        return
      }
      try {
        context?.ui?.toast?.show({
          message: "session navigation not supported by this host",
          variant: "warning",
        })
      } catch {
        /* toast is best-effort */
      }
    } catch (err) {
      console.error("[context-indicator] session navigation failed:", err)
    }
  }

  // Family-session picker (key `s`): a select dialog over the host data layer's
  // family rooted at the TOPMOST ancestor (matches the table; authoritative —
  // includes registered sessions that never served a step; falls back to our
  // state.json walk), searchable by title/model, each option carrying its own
  // cost and a running marker. Enter navigates.
  function openPicker(): void {
    if (pickerOpen) return
    const dialog = context?.ui?.dialog
    if (!dialog || typeof dialog.select !== "function") {
      try {
        context?.ui?.toast?.show({
          message: "session picker requires opencode 2.0.23+",
          variant: "warning",
        })
      } catch {
        /* toast is best-effort */
      }
      return
    }

    const rootID = resolveRoot(props.snapshot(), props.panel.sessionID)
    let ids: string[] = []
    try {
      const family = dataApiSession()?.family?.(rootID)
      if (Array.isArray(family)) ids = family.filter((id) => typeof id === "string")
    } catch {
      ids = []
    }
    if (ids.length === 0) {
      // Host family unavailable: fall back to our state.json family walk.
      ids = collectFamily(props.snapshot(), rootID)
        .map((e) => e.sessionID)
        .filter((id): id is string => typeof id === "string" && id.length > 0)
    }

    const labels = new Map<string, string>()
    const options = ids.map((id) => {
      let title = "(untitled)"
      let model = ""
      let running = false
      try {
        const info = dataApiSession()?.get?.(id)
        if (info && typeof info === "object") {
          const raw = info as Record<string, unknown>
          title = safeText(raw.title) || title
          const m = raw.model as { modelID?: unknown } | string | undefined
          model =
            typeof m === "string"
              ? safeText(m)
              : m && typeof m.modelID === "string"
                ? safeText(m.modelID)
                : ""
          running = dataApiSession()?.status?.(id) === "running"
        }
      } catch {
        /* defensive: host data layers may lack get/status */
      }
      if (!model) {
        const fromSnapshot = props.snapshot()[id]?.model
        if (typeof fromSnapshot === "string" && fromSnapshot !== "unknown") model = safeText(fromSnapshot)
      }
      const parts = [model, title, money(costOf(id))]
      if (running) parts.push("running")
      const label = parts.filter((p) => p.length > 0).join(" · ")
      labels.set(id, label)
      return { title: label, value: id }
    })

    if (options.length <= 1) {
      try {
        context?.ui?.toast?.show({
          message: "no other family sessions",
          variant: "info",
        })
      } catch {
        /* toast is best-effort */
      }
      return
    }

    pickerOpen = true
    try {
      void dialog
        .select({
          title: "Family sessions",
          options,
          search: (query, opts) => {
            const q = query.trim().toLowerCase()
            if (!q) return opts
            return opts.filter((o) => (labels.get(o.value) ?? o.title).toLowerCase().includes(q))
          },
        })
        .then((picked) => {
          pickerOpen = false
          if (typeof picked === "string" && picked.length > 0) navigateTo(picked)
        })
        .catch(() => {
          pickerOpen = false
          /* dialog settle races are host-managed; nothing to recover */
        })
    } catch (err) {
      pickerOpen = false
      console.error("[context-indicator] session picker failed:", err)
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
    costW: number
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
      fit("cost", L.costW) +
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
      fit(money(costOf(e.sessionID)), L.costW) +
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
