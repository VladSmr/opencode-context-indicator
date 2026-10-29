// vite.gui.config.mjs
//
// Builds the Desktop GUI part into the single CommonJS bundle the app loads
// (`./gui-experimental`). The `gui()` preset from @opencode/plugin/gui/vite
// does the work: Solid JSX, one file with every dynamic import inlined, and
// solid-js / the GUI SDK / the client / Electron and Node built-ins kept
// external. It also FAILS the build when the graph pulls in a module the app
// does not provide (another copy of Effect or Solid, any other @opencode/*
// entry), which is exactly the invariant we want to keep.
//
// Not used by the TUI part: tui.tsx is compiled by the host loader.

import { defineConfig } from "vite"
import { gui } from "@opencode/plugin/gui/vite"

export default defineConfig({
  plugins: [gui({ entry: "gui/index.tsx", outFile: "dist/gui-experimental.cjs" })],
})
