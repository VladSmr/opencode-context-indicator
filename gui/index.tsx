// gui/index.tsx
//
// The Desktop GUI part (`./gui-experimental`). It runs inside OpenCode Desktop:
// `setup` runs once per app window and contributes the side-panel tab, the
// palette / slash command, the `+` menu entry and the composer pill.
//
// This is an EXPERIMENTAL host API (`@opencode/plugin/gui`, opencode 2.2.0+):
// the export name says so, and the API may change between host releases. The
// file is bundled by Vite into one CommonJS file (vite.gui.config.mjs) because
// the app loads a single prebuilt bundle and provides solid-js, the GUI SDK and
// the client itself.
//
// Nothing here reads the plugin's files or memory: the window has no filesystem
// access, so every number comes from the server part through the RPC contract
// in lib/rpc.js.

import {
  Command,
  ComposerPill,
  MenuItem,
  Panel,
  Plugin,
  type Command as CommandItem,
  type MenuItem as MenuItemEntry,
  type Panel as PanelEntry,
  type PanelTab,
  type SessionRef,
} from "@opencode/plugin/gui"
import { createSignal, onCleanup } from "solid-js"
import { DesktopContextRpc } from "../lib/rpc.js"
import type { DesktopFamilyResult } from "../lib/rpc.js"
import { ContextPanel } from "./panel"

const PANEL_ID = "context"
const ICON = "window-analytics"
const TITLE = "Context"
// The pill shows one number and polls slower than the panel: it is visible in
// every session, while the panel is only mounted when its tab is open. The two
// loops are independent on purpose (see POLL_MS in ./panel).
const PILL_POLL_MS = 5000
const PILL_WARN_PERCENT = 65
const PILL_DANGER_PERCENT = 85

// Cached identity: the host re-renders a tab's label when the object changes.
const TAB: PanelTab = { id: PANEL_ID, title: TITLE }

export default Plugin.define({
  setup(ctx) {
    const key = `${ctx.id}:${PANEL_ID}`

    const open = (session?: SessionRef) => {
      const ref = session ?? ctx.sessions.current()
      if (!ref) return
      ctx.layout.open(key, ref, { tab: "select" })
    }

    ctx.add(
      Panel,
      (): PanelEntry => ({
        id: PANEL_ID,
        region: "side",
        // The table needs the wider session minimum the side region offers.
        wide: true,
        // The host renders the strip from what `list` returns. Listing the tab
        // unconditionally would make Close ineffective (the next render adds it
        // back), so the tab is listed only while the host still stores its key -
        // `layout.open` is what puts it there.
        list: (input) => (input.open.includes(PANEL_ID) ? [TAB] : []),
        render: (props) => <ContextPanel session={props.session} />,
        // Narrow windows get a first-class view instead of an unreadable strip.
        mobile: { title: TITLE, order: 1, kind: "tab", icon: ICON },
      }),
    )

    // The `+` menu of the side region: how the tab is discovered without
    // knowing the command.
    ctx.add(
      MenuItem,
      (): MenuItemEntry => ({
        id: PANEL_ID,
        menu: "session.panel",
        title: TITLE,
        icon: ICON,
        description: "Context-window usage",
        run: () => open(),
      }),
    )

    ctx.add(
      Command,
      (): CommandItem => ({
        id: "open",
        title: "Open context panel",
        description: "Context-window usage for this session",
        keywords: "context tokens window panel",
        section: "session",
        // Same shorthand as the TUI panel command.
        slash: { name: "cx" },
        run: () => open(),
      }),
    )

    // Always-on usage capsule above the composer: the Desktop counterpart of the
    // TUI sidebar, for the case where the side region is closed.
    const [pill, setPill] = createSignal<
      { sessionID: string; label: string; tone?: "warning" | "danger" } | undefined
    >(undefined)

    const refreshPill = async () => {
      const session = ctx.sessions.current()
      if (!session) {
        setPill(undefined)
        return
      }
      try {
        const result = (await ctx.client
          .rpc(DesktopContextRpc)
          .family({ sessionID: session.id })) as DesktopFamilyResult | undefined
        const root = result?.rows?.[0]
        if (!root || root.usable <= 0) {
          setPill(undefined)
          return
        }
        const share = (root.ctx / root.usable) * 100
        setPill({
          sessionID: session.id,
          label: `${share.toFixed(0)}% ctx`,
          tone:
            share >= PILL_DANGER_PERCENT
              ? "danger"
              : share >= PILL_WARN_PERCENT
                ? "warning"
                : undefined,
        })
      } catch {
        // No server part / restarting server: no pill rather than a stale number.
        setPill(undefined)
      }
    }

    void refreshPill()
    const timer = setInterval(() => void refreshPill(), PILL_POLL_MS)
    onCleanup(() => clearInterval(timer))

    ctx.add(ComposerPill, () => ({
      id: "usage",
      show: ({ session }) => {
        const current = pill()
        if (!current || current.sessionID !== session.id) return undefined
        return {
          label: current.label,
          icon: ICON,
          tone: current.tone,
          title: "Context window usage",
          run: () => open(session),
        }
      },
    }))
  },
})
