// tui.ts — optional OpenCode TUI surfaces for `opencode-context-indicator`.
//
// NO JSX AND NO `@jsxImportSource` PRAGMA IN THIS PACKAGE. Read the long
// explanation at the top of lib/tui-h.ts before touching any TUI file:
// OpenCode installs npm plugins inside a `node_modules` tree, where the host
// SKIPS the Solid/Babel JSX transform (upstream anomalyco/opencode#33884).
// Building the tree with jsx() and getter props keeps the surfaces in sync with
// the 1 s poll from BOTH install layouts (npm and file://), and lets the
// package declare no runtime dependencies at all.
//
// This file is the ENTRY + setup wiring only. The components and the data layer
// live in lib/:
//   - lib/tui-sidebar.ts   the `sidebar.content` slot component
//   - lib/tui-panel.ts     the `session.panel` component (BreakdownPanel)
//   - lib/tui-h.ts         the jsx()/component() builders (only jsx-runtime user)
//   - lib/tui-data.js      state.json bridge, family walk, formatting helpers
//                          (+ lib/tui-data.d.ts for the shared types)
//   - lib/tui-theme.js     theme-token helper
//   - lib/contributors.js  measured-contributor computation + redacted export
//
// Exposed as the `./tui` package entry ("beside the main plugin for automatic
// loading"). OpenCode loads it only in the terminal TUI; it is NOT loaded in
// the Desktop app (Desktop exposes no TUI slot API). It renders the
// per-category context breakdown produced by the server plugin (index.js) into
// the session sidebar via `append: "sidebar.content"` and into a full session
// panel (`append: "session.panel"`) opened by the `cx` slash command / keymap
// layer registered from an `append: "app"` slot.
//
// Data bridge: the server plugin rewrites
//   %TEMP%/opencode-context-indicator-state.json
// (see writeStateFile() in index.js) on every breakdown update. This module
// ONLY reads that file and re-polls it once per second; a missing or corrupt
// file renders "no data yet". The main plugin never imports the TUI entry, so
// the absence of the OpenTUI peers cannot break the server/V1 path.
//
// Runtime requirements: @opentui/core, @opentui/solid and solid-js are resolved
// by OpenCode at runtime — it rewrites these specifiers to in-process modules
// (`nodeModulesRuntimeSpecifiers: true` in @opentui/core's
// DEFAULT_RUNTIME_PLUGIN_REWRITE_OPTIONS) for any file under node_modules, so
// @opentui/solid is a DEV dependency here (types + local tooling only), never a
// production one. Shipping it dragged in a duplicate @opentui/core and the whole
// Babel toolchain for nothing.

import { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import type { StateEntry } from "./lib/tui-data.js"
import { POLL_MS, readSnapshot } from "./lib/tui-data.js"
import { c as comp, h } from "./lib/tui-h.ts"
import { Sidebar } from "./lib/tui-sidebar.ts"
import { BreakdownPanel } from "./lib/tui-panel.ts"

// Session-panel contribution name. Session-panel names are shared selection
// values (not registered claims), so it MUST be plugin-prefixed to avoid
// colliding with another plugin's panel.
const PANEL_NAME = "context-indicator.breakdown"

export default Plugin.define({
  id: "context-indicator.tui",
  setup(context) {
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

    // E2E liveness probe (test/e2e-tui.mjs Check C only; inert in production).
    //
    // Check A proves the ./tui entry LOADED; this probe proves the tree stays
    // REACTIVE when the package is loaded from a `node_modules` path — the exact
    // shape of an npm install, where the host skips its Solid JSX transform
    // (#33884). The node is built by the same h()/getter builders as the real
    // sidebar and is driven by the same 1 s poll tick; its `ref` is sampled into
    // a file because pty screen text is not a reliable liveness oracle
    // (differential redraws).
    const livenessFile = process.env.OPENCODE_CONTEXT_INDICATOR_TUI_LIVENESS
    let probeNode: unknown = null
    const setProbeNode = (el: unknown) => {
      probeNode = el
    }
    // `ref` + getter-driven props: the text content and the foreground colour
    // both come from the poll tick, so a frozen (untransformed) tree leaves the
    // sampled values constant. `plainText` is the renderable's own rendered text
    // — a throwaway pty probe showed it tracks updates reliably while screen
    // scraping does not (hence Check C reads this file, not the pty screen).
    const livenessProbe = livenessFile
      ? () =>
          h("box", {
            flexDirection: "column",
            get children() {
              return [
                h("text", {
                  ref: setProbeNode,
                  get fg() {
                    return tick() % 2 ? "#ff0000" : "#0000ff"
                  },
                  get children() {
                    return `probe ${tick()}`
                  },
                }),
              ]
            },
          })
      : null
    const noteLive = livenessFile
      ? (line: string) => {
          try {
            appendFileSync(livenessFile, line + "\n")
          } catch {
            /* probe is best-effort test instrumentation */
          }
        }
      : null
    let probeTimer: ReturnType<typeof setInterval> | undefined
    if (livenessFile) {
      try {
        mkdirSync(dirname(livenessFile), { recursive: true })
        writeFileSync(livenessFile, "")
      } catch {
        /* probe is best-effort test instrumentation */
      }
      probeTimer = setInterval(() => {
        let text = "?"
        let fg = "?"
        try {
          const node = probeNode as Record<string, unknown> | null
          text = String(node?.plainText ?? node?.text ?? "?")
          fg = String(node?.fg ?? node?.foregroundColor ?? "?")
        } catch {
          /* node not mounted yet */
        }
        try {
          appendFileSync(livenessFile, `tick=${tick()} fg=${fg} text=${text}\n`)
        } catch {
          /* probe is best-effort test instrumentation */
        }
      }, 250)
    }

    // Registering a surface must never throw out of setup(): the peer floor is
    // @opencode/plugin >=2.0.16, and a host without the slot API would otherwise
    // take the whole TUI entry down — losing every other surface with it. A
    // missing surface is logged once and the rest keeps working.
    const registerSlot = (
      name: string,
      register: () => (() => void) | undefined,
    ): (() => void) => {
      try {
        const unregister = register()
        return () => {
          try {
            unregister?.()
          } catch {
            /* ignore */
          }
        }
      } catch (error) {
        console.error(
          `[context-indicator] TUI slot "${name}" unavailable: ${String(error)}`,
        )
        return () => {}
      }
    }

    const unregisterSidebar = registerSlot("sidebar.content", () =>
      context.ui.slot({
        append: "sidebar.content",
        render: ({ sessionID }) => {
          currentSession = sessionID
          noteLive?.("slot-render sidebar.content")
          const sidebar = comp(Sidebar, { entry })
          if (!livenessProbe) return sidebar
          // The probe must live in a real container: a bare array returned from a
          // slot render is not mounted by every host version.
          return h("box", {
            flexDirection: "column",
            get children() {
              return [sidebar, livenessProbe()]
            },
          })
        },
      }),
    )

    // The probe is ALSO mounted in the `app` slot, which the host renders even
    // when no session/sidebar is on screen (a standalone instance with no prompt
    // has no sidebar.content contribution to mount). Whichever slot mounts
    // first fills the sample file; both share the same poll tick.
    const unregisterProbe = livenessProbe
      ? registerSlot("app", () =>
          context.ui.slot({
            append: "app",
            render: () => {
              noteLive?.("slot-render app")
              return livenessProbe()
            },
          }),
        )
      : undefined

    // A `session.panel` contribution is independently selectable: it renders
    // only while its name is the selected one, and the root session comes from
    // panel.sessionID.
    const unregisterPanel = registerSlot("session.panel", () =>
      context.ui.slot({
        append: "session.panel",
        render: (panel) =>
          comp(Show, {
            get when() {
              return panel.name === PANEL_NAME
            },
            get children() {
              return comp(BreakdownPanel, { panel, snapshot, refresh })
            },
          }),
      }),
    )

    // The `app` slot renders nothing itself; it exists to register the global
    // keymap layer (slash command `cx` -> open the panel). The layer is owned by
    // this slot and disposed when the slot unregisters.
    const unregisterCommands = registerSlot("app (keymap)", () =>
      context.ui.slot({
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
                  // Palette-visible AND directly bound: subagent session views
                  // force the composer into its "subagents" tab, which pushes
                  // keymap mode "composer" — the base-mode palette binding
                  // (ctrl+p) is inert there and there is no prompt to type /cx.
                  // A bind on this mode:"global" layer fires in every mode
                  // (leader matches <leader>b "toggle sidebar"; f4 as a direct
                  // single-chord fallback).
                  palette: true,
                  bind: "<leader>c,f4",
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
      }),
    )

    // One-time live-surface marker. The e2e Check A asserts this line from the
    // isolated instance's private log: it proves the ./tui entry not only
    // loaded but REGISTERED its surfaces — a host-transform failure of this
    // file would otherwise die silently between "loading plugin" and here.
    console.log(
      "[context-indicator] live TUI surfaces registered (sidebar + session.panel + keymap)",
    )

    // E2E instrumentation (only when test/e2e-tui.mjs sets the marker env):
    // same proof as the console line above, but via a FILE — the TUI captures
    // console output, so the log channel cannot carry it. Production runs
    // never set the env and never write the stamp.
    if (process.env.OPENCODE_CONTEXT_INDICATOR_TUI_MARKER) {
      try {
        mkdirSync(join(tmpdir(), "opencode-context-indicator"), { recursive: true })
        writeFileSync(
          join(tmpdir(), "opencode-context-indicator", "tui-live.stamp"),
          new Date().toISOString(),
          "utf8",
        )
      } catch {
        /* marker is best-effort test instrumentation */
      }
    }

    return () => {
      clearInterval(timer)
      if (probeTimer) clearInterval(probeTimer)
      for (const unregister of [
        unregisterSidebar,
        unregisterProbe,
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
