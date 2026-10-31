// resolve-bridge.cjs — gate (c) of test/prepublish.mjs.
//
// Checks the import graph of the TUI surface (tui.ts + lib/*.ts) against the
// SAME rules gate (b) uses (test/lib/import-scan.cjs):
//
//  1. every BARE specifier is a module opencode's TUI loader provides
//     in-process (@opencode/plugin/tui, @opentui/solid*, solid-js, solid-js/*);
//     anything else is unresolvable inside the host bundle;
//  2. none of those host-bridged modules is a PRODUCTION dependency: shipping
//     one installs a second copy next to the host's instance, and a duplicated
//     Solid/OpenTUI desynchronises reactivity (frozen sidebar, #33884 family of
//     bugs). They are devDependencies only (types + local typecheck/esbuild);
//  3. every RELATIVE specifier carries a file extension (the host's rewrite walk
//     uses import.meta.resolve, which does not probe extensions) and points at
//     a file we actually ship.
//
// The scan is driven by the sources themselves: a new import added to a TUI
// file cannot escape this gate.
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");
const { pathToFileURL } = require("url");
const {
  isBuiltin,
  isRelative,
  isHostBridged,
  hasFileExtension,
  importSpecifiersOf,
  tuiSourcesOf,
} = require("./lib/import-scan.cjs");

const repoRoot = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const prodDeps = new Set(Object.keys(pkg.dependencies || {}));

// Bare specifier -> owning package name ("@a/b/c" -> "@a/b", "a/b" -> "a").
const packageNameOf = (spec) => {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
};

const tuiSources = tuiSourcesOf(fs, path, repoRoot);

// No "" candidate: an extensionless relative import is a hard failure (rule 3),
// so only real file names may satisfy the existence check.
const CANDIDATE_EXTENSIONS = [".ts", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"];
const resolveLocal = (spec, fromRel) => {
  const base = path.resolve(path.dirname(path.join(repoRoot, fromRel)), spec);
  if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
  for (const ext of CANDIDATE_EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
};

let failed = 0;
const fail = (msg) => {
  console.error("FAILED " + msg);
  failed++;
};

// Dev-tree resolution is what typecheck/esbuild need; the runtime copy comes
// from the host, so a missing devDependency is a tooling break, not a ship
// blocker — reported but not fatal.
const devRequire = createRequire(
  pathToFileURL(path.join(repoRoot, "node_modules", "@opencode", "plugin", "dist", "tui", "index.js")).href,
);

let bareChecked = 0;
let localChecked = 0;
for (const rel of tuiSources) {
  const source = fs.readFileSync(path.join(repoRoot, rel), "utf8");
  for (const spec of importSpecifiersOf(source)) {
    if (isBuiltin(spec)) continue;

    if (isRelative(spec)) {
      if (!hasFileExtension(spec)) {
        fail(
          `${rel}: relative import "${spec}" has no file extension — the host ` +
            `rewrite walk does not resolve extensionless imports, so that file ` +
            `keeps a literal jsx-runtime import and the npm install fails with ` +
            `Cannot find package '@opentui/solid'. Write "${spec}.ts" (or .js).`,
        );
        continue;
      }
      const resolved = resolveLocal(spec, rel);
      if (!resolved) {
        fail(`${rel}: relative import "${spec}" does not resolve to a shipped file`);
        continue;
      }
      localChecked++;
      console.log("OK " + rel + " -> " + path.relative(repoRoot, resolved).replace(/\\/g, "/"));
      continue;
    }

    if (!isHostBridged(spec)) {
      fail(
        `${rel}: import "${spec}" is not bridged by the opencode TUI loader ` +
          `(allowed: node:*, bun:*, relative, @opencode/plugin/tui, ` +
          `@opentui/solid*, solid-js[/store])`,
      );
      continue;
    }

    const owner = packageNameOf(spec);
    if (prodDeps.has(owner)) {
      fail(
        `${rel}: "${spec}" comes from the host, but "${owner}" is a PRODUCTION ` +
          `dependency — a second instance breaks reactivity. Move it to devDependencies.`,
      );
      continue;
    }

    bareChecked++;
    let devResolved = null;
    try {
      devResolved = devRequire.resolve(spec);
    } catch {
      /* dev-tree resolution is advisory (see note above) */
    }
    console.log(
      `OK ${rel} -> ${spec} (host-bridged${devResolved ? ", dev copy present" : ""})`,
    );
  }
}

if (bareChecked === 0) {
  fail("no host-bridged import found in the TUI surface — the scan found nothing to verify");
}
if (failed > 0) process.exit(1);
console.log(
  `resolve chain OK: ${bareChecked} host-bridged import(s), ${localChecked} local import(s)`,
);
