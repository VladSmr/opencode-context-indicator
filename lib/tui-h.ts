// lib/tui-h.ts
//
// The two tree builders every TUI surface in this package uses instead of JSX.
//
// WHY NO JSX (do not "simplify" this back):
//   OpenCode installs npm plugins inside a `node_modules` tree
//   (~/.cache/opencode/npm/<name>@<version>/<ts>/node_modules/<name>). For such
//   paths the host deliberately skips its Solid/Babel JSX transform (sourceFilter
//   in @opentui/solid/scripts/solid-plugin.js excludes node_modules, upstream
//   anomalyco/opencode#33884). A JSX-compiled file in that position also needs
//   `@opentui/solid` to be installed next to it just to resolve its emitted
//   jsx-runtime import. Files WITHOUT JSX syntax are unaffected: their literal
//   `@opentui/solid/jsx-runtime` import IS rewritten by the host to the
//   in-process OpenTUI module (`nodeModulesRuntimeSpecifiers: true` in
//   DEFAULT_RUNTIME_PLUGIN_REWRITE_OPTIONS of @opentui/core), so the tree stays
//   reactive and the package needs no runtime dependency at all.
//
// Therefore: no JSX syntax anywhere in this package's TUI files, and no
// `@jsxImportSource` pragma. Build the tree with jsx() and mark every DYNAMIC
// prop as a getter — that is exactly what the Solid compiler emits for
// `prop={expr}` in JSX, so the runtime semantics are identical:
//
//   <text fg={base()}>{line}</text>
//     ->  h("text", { get fg() { return base() }, get children() { return line } })
//
// A plain (non-getter) value is read ONCE, like a literal attribute in JSX.
// Children follow the same rule: an array of elements is fine (it is diffed by
// the runtime), a function child is a reactive accessor.
//
// RELATIVE IMPORTS OF .ts FILES MUST CARRY THE EXTENSION (`./tui-h.ts`, not
// `./tui-h`): the host decides which files get the runtime-specifier rewrite by
// walking the import graph with `import.meta.resolve(specifier, importer)`,
// which does not probe extensions. An extensionless import is simply not
// followed, so that file keeps the literal `@opentui/solid/jsx-runtime` import
// and the npm install dies with `Cannot find package '@opentui/solid'`.
// test/prepublish.mjs gate (b) enforces this.
//
// This module is the only place that imports the jsx runtime, so the allowlist
// in test/prepublish.mjs stays short.
//
// NEVER pass a `key` prop to h()/c(). The jsx runtime's normalizeProps() sees
// `key`, strips it with `{ ...rest }`, and the spread turns every getter into a
// plain value read ONCE — the whole subtree freezes with no error. (No list in
// this package is keyed; if you ever need one, do not add `key` here.)

import { jsx } from "@opentui/solid/jsx-runtime"
import type { JSX } from "@opentui/solid/jsx-runtime"

/** An intrinsic OpenTUI element: `h("text", { fg, children })`. */
export function h<K extends string>(
  tag: K,
  props: K extends keyof JSX.IntrinsicElements ? JSX.IntrinsicElements[K] : never,
): JSX.Element {
  return jsx(tag, props as unknown as Record<string, unknown>)
}

/**
 * A component: `c(Show, { get when() {...}, get fallback() {...} })`.
 *
 * The component's own prop type is intentionally not enforced here: host
 * components (Show, and any OpenTUI component) are generic and their unions do
 * not survive inference through a wrapper, while the shapes used in this
 * package are small and covered by the e2e liveness check.
 */
export function c<C extends (props: any) => unknown, P extends object>(
  component: C,
  props: P,
): JSX.Element {
  return jsx(
    component as unknown as (props: Record<string, unknown>) => unknown,
    props as unknown as Record<string, unknown>,
  )
}
