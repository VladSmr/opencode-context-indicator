/** @jsxImportSource @opentui/solid */
/**
 * tui.tsx — optional OpenCode TUI sidebar for `opencode-context-indicator`.
 *
 * The import-source pragma on the first line above is REQUIRED: without it the
 * opencode TUI loader (Bun) transforms JSX against the React runtime and emits
 * `import ... from "react/jsx-runtime"`, which the TUI runtime does not provide,
 * so loading the plugin from the npm cache throws `Cannot find package 'react'`
 * (react only ever resolved from a developer's local node_modules). The pragma
 * must stay the very first line, before any import, and no other pragma-like
 * token may appear in this file. See the OpenTUI Solid integration guide.
 *
 * Exposed as the `./tui` package entry ("beside the main plugin for automatic
 * loading"). OpenCode loads it only in the terminal TUI; it is NOT loaded in
 * the Desktop app (Desktop exposes no TUI slot API). It renders the
 * per-category context breakdown produced by the server plugin (index.js) into
 * the session sidebar via `append: "sidebar.content"` and into a full session
 * panel (`append: "session.panel"`) opened by the `cx` slash command / keymap
 * layer registered from an `append: "app"` slot.
 *
 * Data bridge: the server plugin rewrites
 *   %TEMP%/opencode-context-indicator-state.json
 * (see writeStateFile() in index.js) on every breakdown update. This module
 * ONLY reads that file and re-polls it once per second; a missing or corrupt
 * file renders "no data yet". The main plugin never imports this file, so the
 * absence of the OpenTUI peers cannot break the server/V1 path.
 *
 * Runtime requirements: @opentui/core and solid-js are optional peers resolved
 * by OpenCode at runtime. @opentui/solid is a pinned direct dependency (exact
 * 0.5.16): OpenCode's TUI loader does not expose a host instance of it, so for
 * npm-installed plugins the JSX pragma would otherwise fail to resolve
 * `@opentui/solid/jsx-runtime` (upstream opencode issue #33884).
 *
 * Graceful mode: when this file is loaded from an npm install (its own path is
 * inside a `node_modules` directory), OpenCode skips the host Solid transform
 * for `node_modules` paths, so a mounted slot renders once and then never
 * live-updates (anomalyco/opencode#33884). Rather than freeze a permanent
 * "no data yet" panel, the entry detects that case, logs a single hint and
 * registers no slot (neither the sidebar nor the session panel). Install via
 * `file://` from a path outside any `node_modules` for the live surfaces (see
 * README → "Live sidebar").
 */
import {Plugin, usePlugin} from "@opencode/plugin/tui"
import {createMemo, createSignal, Show} from "solid-js"
import type {ColorInput} from "@opentui/core"
import {mkdirSync, readFileSync, writeFileSync} from "node:fs"
import {tmpdir} from "node:os"
import {basename, join} from "node:path"
import {fileURLToPath} from "node:url"
type Contributor = {
  kind: string
  ref: string
  chars: number
  tokensEstimate: number
  tool: string
  preview: string
}
import {
  safeText,
  measureContributors,
  contributorLine,
  exportFileName,
  buildRedactedPayload,
  panelDenom,
  panelRole,
} from "./lib/contributors.js"

const STATE_FILE =
  process.env.OPENCODE_CONTEXT_INDICATOR_STATE_FILE ||
  join(tmpdir(), "opencode-context-indicator-state.json")
const POLL_MS = 1000
const LABEL_WIDTH = 12

// Session-panel contribution name. Session-panel names are shared selection
// values (not registered claims), so it MUST be plugin-prefixed to avoid
// colliding with another plugin's panel.
const PANEL_NAME = "context-indicator.breakdown"

// True when this module was loaded from an npm install, i.e. its own file path
// contains a `node_modules` segment (OpenCode's TUI loader skips the host Solid
// transform for such paths → slots mount once but never live-update; see the
// Graceful mode note above). Normalised to forward slashes for Windows paths.
function isNodeModulesInstall(): boolean {
  try {
    const selfPath = fileURLToPath(import.meta.url).replace(/\\/g, "/").toLowerCase()
    return selfPath.includes("/node_modules/")
  } catch {
    return false
  }
}

type Categories = {
  user?: number
  assistant?: number
  reasoning?: number
  toolArgs?: number
  system?: number | null
  toolSchemas?: number | null
  other?: number
}

type StateEntry = {
  sessionID?: string
  parentID?: string | null
  role?: string
  agent?: string | null
  model?: string
  providerID?: string
  ctx?: number
  input?: number
  usable?: number | null
  reserve?: number | null
  limit?: number | null
  reasoning?: number
  categories?: Categories
  updatedAt?: string
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0"
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n))
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

// Theme tokens are OpenTUI RGBA values (see ResolvedTheme.text.base/.muted);
// pass them straight to the renderer. Fall back to a named color when a token
// is absent so an unexpected theme shape can never blank the sidebar.
// `fg` on <text> is typed as OpenTUI's ColorInput (= string | RGBA); using the
// same alias keeps the JSX assignment type-correct instead of a loose `object`.
type Fg = ColorInput
function token(v: unknown, fallback: Fg): Fg {
  return v && typeof v === "object" ? (v as Fg) : fallback
}

// Reserved object keys must never be treated as session ids: state.json is
// untrusted input (mirrors isSafeSessionKey() in lib/estimate.js).
function isSafeKey(k: string): boolean {
  return k !== "__proto__" && k !== "constructor" && k !== "prototype"
}

// Whole state.json snapshot ({ sessionID: entry }) or {} on any error. The
// sidebar resolves one entry from it and the breakdown panel walks the
// parentID family over it. Never throws — a missing / empty / corrupt
// file simply yields {}.
function readSnapshot(): Record<string, StateEntry> {
  try {
    const raw = readFileSync(STATE_FILE, "utf8")
    const all = JSON.parse(raw) as Record<string, StateEntry>
    if (!all || typeof all !== "object" || Array.isArray(all)) return {}
    // Rebuild into a fresh plain object: drops prototype-poisoning keys
    // (__proto__ / constructor / prototype) and non-object entries in one pass.
    const clean: Record<string, StateEntry> = {}
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
function isEmptyEntry(e: StateEntry | undefined): boolean {
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
// imported here (tui.tsx stays independent of the server code by design). A
// phantom node (no tokens, see isEmptyEntry) is not emitted, but traversal still
// descends through it so real grandchildren behind it are found. `seen` guards
// against cycles (parentID loops) and double-listing.
function collectFamily(
  snapshot: Record<string, StateEntry>,
  rootID: string,
): StateEntry[] {
  const out: StateEntry[] = []
  const root = snapshot[rootID]
  if (root && typeof root === "object") out.push(root)
  const seen = new Set<string>([rootID])
  const queue: string[] = [rootID]
  // Index the snapshot by parentID once (O(n)) instead of an O(n) scan per node.
  const byParent = new Map<string, string[]>()
  for (const [id, e] of Object.entries(snapshot)) {
    const pid = e?.parentID
    if (!pid || typeof pid !== "string") continue
    const kids = byParent.get(pid)
    if (kids) kids.push(id)
    else byParent.set(pid, [id])
  }
  while (queue.length > 0) {
    const cur = queue.shift() as string
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

function updatedAt(iso: string | undefined): string {
  if (!iso) return "?"
  try {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? "?" : d.toLocaleTimeString()
  } catch {
    return "?"
  }
}

// Code-point-safe column fit: truncate on code points (never splitting a
// surrogate pair at a column boundary), mark a truncated cell with a trailing
// "~" so clipping is VISIBLE (a silently clipped cell reads as two columns
// colliding), then pad to the column width.
function fit(s: string, w: number): string {
  const cps = Array.from(s)
  if (cps.length > w) return `${cps.slice(0, Math.max(0, w - 1)).join("")}~`
  return s.padEnd(w)
}

// ---------------------------------------------------------------------------
// Measured contributors (TUI-only). The TUI data layer already holds the
// session's live message list in-process, so the panel can char-count each
// message part WITHOUT an LLM call and WITHOUT shipping message text anywhere.
// Only the char count, the message ordinal and a kind string leave
// measureContributors(); message text is read, measured and discarded. Tool
// RESULT outputs are counted here — the server's state.json categories never
// see them — which is what makes the residual `other` explicable.
// ---------------------------------------------------------------------------

// The TUI message data API is optional across host versions. Log a single hint
// (never once per poll) when it is unavailable and hide the whole section.
let warnedMessagesUnavailable = false

function Sidebar(props: { entry: () => StateEntry | null }) {
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
// selects the root; `cx` opens the panel (registered from the "app" slot below).
function BreakdownPanel(props: {
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

export default Plugin.define({
  id: "context-indicator.tui",
  setup(context) {
    // npm installs (path under node_modules) cannot get live slot updates on
    // this OpenCode version. Stay inert and log a single hint instead of
    // registering slots that would freeze on "no data yet".
    if (isNodeModulesInstall()) {
      console.log(
        "[context-indicator] TUI sidebar and breakdown panel disabled: " +
          "npm-installed plugins cannot get live updates on this OpenCode " +
          "version (anomalyco/opencode#33884). Install via file:// (see README " +
          '→ "Live sidebar") for the live sidebar and panel. The /context slash ' +
          "commands still work everywhere.",
      )
      return
    }

    // Re-read the bridge file once per second and re-render reactively. ONE
    // ticker drives BOTH surfaces, and the snapshot is cached per tick: every
    // consumer (sidebar, panel data, messages) shares a single readFileSync.
    const [tick, setTick] = createSignal(0)
    let currentSession: string | undefined
    let snapCache: Record<string, StateEntry> | null = null
    let snapAt = -1
    const snapshot = (): Record<string, StateEntry> => {
      const t = tick() // track the ticker so reads re-run every poll
      if (snapCache === null || snapAt !== t) {
        snapCache = readSnapshot()
        snapAt = t
      }
      return snapCache
    }
    const entry = (): StateEntry | null =>
      snapshot()[currentSession ?? ""] ?? null
    const refresh = () => setTick((n) => n + 1)
    const timer = setInterval(() => setTick((n) => n + 1), POLL_MS)

    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        currentSession = sessionID
        return <Sidebar entry={entry} />
      },
    })

    // A `session.panel` contribution is independently selectable: it renders
    // only while its name is the selected one, and the root session comes from
    // panel.sessionID.
    const unregisterPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL_NAME}>
          <BreakdownPanel panel={panel} snapshot={snapshot} refresh={refresh} />
        </Show>
      ),
    })

    // The `app` slot renders nothing itself; it exists to register the global
    // keymap layer (slash command `cx` -> open the panel). The layer is owned by
    // this slot and disposed when the slot unregisters.
    const unregisterCommands = context.ui.slot({
      append: "app",
      render: () => {
        const keymap = context?.keymap
        if (keymap && typeof keymap.layer === "function") {
          keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: "context-indicator.breakdown",
                title: "Context breakdown panel",
                slash: { name: "cx" },
                run: () => {
                  const panelApi = context?.ui?.panel
                  if (panelApi && typeof panelApi.open === "function") {
                    panelApi.open(PANEL_NAME)
                  }
                },
              },
            ],
          }))
        }
        return null
      },
    })

    return () => {
      clearInterval(timer)
      for (const unregister of [
        unregisterSidebar,
        unregisterPanel,
        unregisterCommands,
      ]) {
        try {
          unregister?.()
        } catch {
          /* ignore */
        }
      }
    }
  },
})
