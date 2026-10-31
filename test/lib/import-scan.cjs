// test/lib/import-scan.cjs — shared import-graph rules for gates (b) and (c).
//
// Both gates must agree on ONE definition of "an import the opencode TUI loader
// can provide", otherwise a new import can pass one gate and break the other.
// This module is the single source of truth:
//
//   BUILTIN     node:*, bun:*            — provided by the runtime, never resolved
//                                          from disk.
//   HOST_BRIDGED @opencode/plugin/tui,   — the host hands its OWN in-process
//                @opentui/solid/*,          instance to the plugin. Shipping one
//                solid-js, solid-js/*       as a production dependency installs a
//                                           SECOND instance (frozen surfaces).
//   RELATIVE    ./x.js, ../x.ts          — a file this package ships. The host
//                                          walks the graph with
//                                          import.meta.resolve(specifier, importer),
//                                          which never probes extensions, so a
//                                          relative import MUST carry one.
//
// Anything else (bare `opencode`, `react`, an npm package) is unresolvable
// inside the host bundle and must fail the gates.

const BUILTIN_PREFIXES = ["node:", "bun:"];

const HOST_BRIDGED_EXACT = new Set([
  "@opencode/plugin/tui",
  "@opentui/solid",
  "@opentui/solid/jsx-runtime",
  "@opentui/solid/jsx-dev-runtime",
  "@opentui/solid/components",
  "solid-js",
]);

const isBuiltin = (spec) => BUILTIN_PREFIXES.some((p) => spec.startsWith(p));

const isRelative = (spec) => spec.startsWith("./") || spec.startsWith("../");

const isHostBridged = (spec) =>
  HOST_BRIDGED_EXACT.has(spec) ||
  (spec.startsWith("solid-js/") && !spec.includes(".."));

// A relative specifier needs a real file extension: the host's rewrite walk
// uses import.meta.resolve and would silently skip `./tui-h`, leaving that file
// with a literal `@opentui/solid/jsx-runtime` import and breaking npm installs.
const hasFileExtension = (spec) => /\.[cm]?[jt]s$/.test(spec);

// Literal module specifiers in source text. The host's rewrite scanner only
// sees literals, so both gates scan the source, not transpiled output.
const importSpecifiersOf = (code) => {
  const specifiers = new Set();
  const patterns = [
    /(?:^|[^\w$.])import\s+(?:[^"'();]*?\sfrom\s+)?["']([^"']+)["']/g,
    /(?:^|[^\w$.])export\s+(?:\*[^"'();]*?|\{[^}]*?\})\s*from\s*["']([^"']+)["']/g,
    /(?:^|[^\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of code.matchAll(re)) specifiers.add(m[1]);
  }
  return [...specifiers];
};

// The TUI surface: the `./tui` entry plus every hand-written .ts in lib/.
const tuiSourcesOf = (fs, path, repoRoot) => [
  "tui.ts",
  ...fs
    .readdirSync(path.join(repoRoot, "lib"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort()
    .map((f) => "lib/" + f),
];

module.exports = {
  isBuiltin,
  isRelative,
  isHostBridged,
  hasFileExtension,
  importSpecifiersOf,
  tuiSourcesOf,
  HOST_BRIDGED_EXACT,
  BUILTIN_PREFIXES,
};
