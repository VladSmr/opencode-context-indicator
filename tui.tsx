/**
 * tui.tsx — optional OpenCode TUI sidebar for `opencode-context-indicator`.
 *
 * Exposed as the `./tui` package entry ("beside the main plugin for automatic
 * loading"). OpenCode loads it only in the terminal TUI; it is NOT loaded in
 * the Desktop app (Desktop exposes no TUI slot API). It renders the
 * per-category context breakdown produced by the server plugin (index.js) into
 * the session sidebar via `append: "sidebar.content"`.
 *
 * Data bridge: the server plugin rewrites
 *   %TEMP%/opencode-context-indicator-state.json
 * (see writeStateFile() in index.js) on every breakdown update. This module
 * ONLY reads that file and re-polls it once per second; a missing or corrupt
 * file renders "no data yet". The main plugin never imports this file, so the
 * absence of the OpenTUI peers cannot break the server/V1 path.
 *
 * Peer requirements (declared optional in package.json): @opentui/core,
 * @opentui/solid, solid-js.
 */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const STATE_FILE = join(tmpdir(), "opencode-context-indicator-state.json")
const POLL_MS = 1000
const LABEL_WIDTH = 12

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
  model?: string
  providerID?: string
  ctx?: number
  input?: number
  usable?: number | null
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
type Fg = string | object
function token(v: unknown, fallback: string): Fg {
  return v && typeof v === "object" ? (v as Fg) : fallback
}

// Read the snapshot entry for one session. Never throws: a missing, empty or
// corrupt state file simply yields null ("no data yet").
function readEntry(sessionID: string | undefined): StateEntry | null {
  if (!sessionID) return null
  try {
    const raw = readFileSync(STATE_FILE, "utf8")
    const all = JSON.parse(raw) as Record<string, StateEntry>
    if (!all || typeof all !== "object" || Array.isArray(all)) return null
    const entry = all[sessionID]
    return entry && typeof entry === "object" ? entry : null
  } catch {
    return null
  }
}

function updatedAt(iso: string | undefined): string {
  if (!iso) return "?"
  try {
    return new Date(iso).toLocaleTimeString()
  } catch {
    return "?"
  }
}

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

export default Plugin.define({
  id: "context-indicator.tui",
  setup(context) {
    // Re-read the bridge file once per second and re-render reactively.
    const [tick, setTick] = createSignal(0)
    let currentSession: string | undefined
    const entry = (): StateEntry | null => {
      tick() // track the ticker so reads re-run every poll
      return readEntry(currentSession)
    }
    const timer = setInterval(() => setTick((n) => n + 1), POLL_MS)

    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        currentSession = sessionID
        return <Sidebar entry={entry} />
      },
    })

    return () => {
      clearInterval(timer)
      try {
        unregister?.()
      } catch {
        /* ignore */
      }
    }
  },
})
