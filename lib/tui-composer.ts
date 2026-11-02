// lib/tui-composer.ts - the `prompt.footer.status` slot component.
//
// One always-visible usage capsule inside the TUI composer (`38% ctx`), the
// terminal counterpart of the Desktop composer pill (gui/index.tsx). Without it
// the percentage only exists inside the sidebar (hidden when collapsed) or the
// full-screen `/cx` panel.
//
// Same rules as every other TUI surface here: NO JSX, no pragma, every dynamic
// prop a getter (see lib/tui-h.ts). The host ships the slot since opencode 2.2.x
// (`prompt.footer.status` accepts `{ sessionID, mode, showDetails }`); an older
// host simply lacks the path and registerSlot() logs once in tui.ts.
//
// The component renders nothing on its own when there is no measurement: a
// missing window must not push an empty box into the composer.

import { usePlugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"
import type { StateEntry } from "./tui-data.js"
import { composerStatus } from "./tui-data.js"
import { fmt } from "./format.js"
import { token } from "./tui-theme.js"
import { c, h } from "./tui-h.ts"

export function ComposerStatus(props: {
  entry: () => StateEntry | null
  /** "normal" | "shell"; the host passes this on every render. */
  mode: () => string
  /** The host's own compact/detailed toggle (`showDetails`). */
  showDetails: () => boolean
}) {
  const context = usePlugin()
  const base = () => token(context?.theme?.text?.base, "white")
  const warn = () => token(context?.theme?.text?.feedback?.warning?.base, "yellow")
  const danger = () => token(context?.theme?.text?.feedback?.error?.base, "red")

  // A shell prompt is not a model turn: the number would describe the previous
  // exchange and sit next to a `$` prompt, so it is hidden there.
  const status = () => (props.mode() === "shell" ? null : composerStatus(props.entry()))

  const fg = () => {
    const tone = status()?.tone
    return tone === "danger" ? danger() : tone === "warning" ? warn() : base()
  }

  const label = () => {
    const s = status()
    if (!s) return ""
    if (!props.showDetails()) return s.label
    const e = props.entry()
    const ctx = typeof e?.ctx === "number" ? e.ctx : 0
    const usable = typeof e?.usable === "number" ? e.usable : 0
    return `${s.label} ${fmt(ctx)}/${fmt(usable)}`
  }

  return c(Show, {
    get when() {
      return status()
    },
    get children() {
      return h("text", {
        get fg() {
          return fg()
        },
        get children() {
          return label()
        },
      })
    },
  })
}
