// resolve-bridge.cjs — CommonJS bridge for createRequire.
// Verifies that the packages tui.tsx statically imports can be resolved.
// @opencode/plugin/tui has a known CJS createRequire edge case with package
// exports (it works in ESM and in the real opencode runtime); we verify it
// via the esbuild transpilation check instead.
const path = require("path");
const { createRequire } = require("module");
const { pathToFileURL } = require("url");

// Use a file INSIDE the package that resolves via its own exports field.
const pluginTUIFile = pathToFileURL(path.join(
  __dirname, "..", "node_modules", "@opencode", "plugin", "dist", "tui", "index.js",
)).href;
const require2 = createRequire(pluginTUIFile);

const checks = [
  ["@opentui/solid/jsx-runtime", true],
  ["solid-js", true],
  // @opentui/core is an optional peer — safe to fail (sidebar unavailable, main
  // plugin still works).  Verified via esbuild transpile, not here.
  ["@opentui/core", true],  // optional peer — resolves with our devDeps
];

// Local relative imports from tui.tsx resolve through the ordinary node
// mechanism (the host only bridges host modules), so verify them with a
// require rooted AT tui.tsx — the same base directory the TUI loader uses.
// (createRequire from @opencode/plugin/tui cannot resolve repo-relative paths,
// which is why these need their own resolver.)
const localChecks = [
  ["./lib/contributors.js", true],
  ["./lib/tui-data.js", true],
  ["./lib/tui-theme.js", true],
  // Extensionless TSX imports: node's CJS resolver cannot resolve them (no
  // .tsx extension search), but the TUI host (Bun) resolves TS/TSX extensions
  // for relative imports — so verify the file exists next to tui.tsx instead.
  ["./lib/tui-sidebar", true, [".tsx"]],
  ["./lib/tui-panel", true, [".tsx"]],
];
const tuiRequire = createRequire(
  pathToFileURL(path.join(__dirname, "..", "tui.tsx")).href,
);

let failed = 0;
for (const [pkg, mustResolve] of checks) {
  try {
    const r = require2.resolve(pkg);
    if (mustResolve) console.log("OK " + pkg + " -> " + r);
    else console.log("UNEXPECTED_OK " + pkg + " -> " + r);
  } catch (e) {
    if (mustResolve) {
      console.error("FAILED " + pkg + ": " + e.code);
      failed++;
    } else {
      console.log("EXPECTED_FAIL " + pkg + ": " + e.code);
    }
  }
}
const fs = require("fs");
for (const [spec, mustResolve, extensions] of localChecks) {
  let resolved = null;
  try {
    resolved = tuiRequire.resolve(spec);
  } catch (e) {
    // Fall through to the explicit-extension existence check below.
  }
  if (!resolved && Array.isArray(extensions)) {
    for (const ext of extensions) {
      const candidate = path.join(__dirname, "..", spec.replace(/^\.\//, "") + ext);
      if (fs.existsSync(candidate)) {
        resolved = candidate;
        break;
      }
    }
  }
  if (resolved) {
    if (mustResolve) console.log("OK " + spec + " -> " + resolved);
    else console.log("UNEXPECTED_OK " + spec + " -> " + resolved);
  } else if (mustResolve) {
    console.error("FAILED " + spec + " (no resolver match, no candidate file)");
    failed++;
  } else {
    console.log("EXPECTED_FAIL " + spec);
  }
}
if (failed > 0) process.exit(1);