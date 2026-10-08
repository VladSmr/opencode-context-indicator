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
 * This file is the ENTRY + setup wiring only. The components and the data layer
 * live in lib/ (all of them are transformed by the host exactly like this file,
 * because the Solid transform's sourceFilter covers every plugin file outside
 * node_modules — see @opentui/solid/scripts/solid-plugin.js):
 *   - lib/tui-sidebar.tsx  the `sidebar.content` slot component
 *   - lib/tui-panel.tsx    the `session.panel` component (BreakdownPanel)
 *   - lib/tui-data.js      state.json bridge, family walk, formatting helpers
 *                          (+ lib/tui-data.d.ts for the shared types)
 *   - lib/tui-theme.js     theme-token helper
 *   - lib/contributors.js  measured-contributor computation + redacted export
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
 * file renders "no data yet". The main plugin never imports the TUI entry, so
 * the absence of the OpenTUI peers cannot break the server/V1 path.
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
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, Show } from "solid-js"
import { mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { StateEntry } from "./lib/tui-data.js"
import { isNodeModulesInstall, POLL_MS, readSnapshot } from "./lib/tui-data.js"
import { Sidebar } from "./lib/tui-sidebar"
import { BreakdownPanel } from "./lib/tui-panel"

// Session-panel contribution name. Session-panel names are shared selection
// values (not registered claims), so it MUST be plugin-prefixed to avoid
// colliding with another plugin's panel.
const PANEL_NAME = "context-indicator.breakdown"

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
