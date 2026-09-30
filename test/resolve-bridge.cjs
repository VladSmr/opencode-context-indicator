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
if (failed > 0) process.exit(1);