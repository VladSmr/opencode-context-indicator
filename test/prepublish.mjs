/**
 * prepublish.mjs — fast gate (<30 s) run automatically by `npm publish`.
 *
 * Checks performed:
 *   (a) tarball composition (base files + lib/ + docs/ + dist/, no dev artifacts)
 *   (b) TUI sources are JSX-free (no .tsx, no pragma) and import only modules
 *       the opencode TUI loader bridges (keeps npm installs live, #33884)
 *   (c) resolve chain - host-bridged modules resolve, local imports exist, and
 *       none of them is a production dependency (no duplicate instance)
 *   (d) unit-harness T1-T44 for the limit/agent/state/command/Desktop-RPC fixes
 *   (e) corporate-identifier scan (lib/, gui/, test/ and the published surface)
 *   (f) non-English scan - no non-ASCII letters (any language other than
 *       English) anywhere in the published surface or the test tree
 *   (g) Desktop GUI bundle: one CJS file, app-provided modules kept external
 *   (h) Desktop GUI runtime smoke: the built bundle loads with stubbed host
 *       modules and setup() registers panel/menu/command/pill
 *
 * Skip with:  npm publish --ignore-scripts
 *             (useful for testing the pack output without running checks)
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync, mkdirSync, rmSync, statSync } from "node:fs";
import { transformSync } from "esbuild";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

// repoRoot = parent of the test/ directory (where package.json lives)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const importScan = createRequire(import.meta.url)("./lib/import-scan.cjs");

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const fatal = (msg) => { console.error(`\n[prepublish FAILED] ${msg}`); process.exit(1); };
const pass  = (msg) => console.log(`  ✓ ${msg}`);

// ---------------------------------------------------------------------------
// (a) tarball composition — verified by package.json "files" field, which
// is npm's authoritative source.  No platform-specific command capture needed.
// ---------------------------------------------------------------------------
console.log("\n(a) Tarball composition...");
const pkgMeta = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
const declaredFiles = pkgMeta.files || [];
// Expand any directory-wildcard entries to their expected member(s).
// e.g. "lib/" -> every regular file under lib/; "docs/" -> every member under
// that prefix (the README screenshot). The base published set is
// LICENSE, README.md, index.js, package.json, tui.ts, CHANGELOG.md (6 files);
// the lib/ and
// docs/ member counts are computed from the directories so module splits and
// added screenshots are reflected automatically instead of needing a hardcoded
// number.
// Base files in `files[]` outside lib/ (index.js, package.json, tui.ts,
// README.md, CHANGELOG.md, LICENSE).
const BASE_MEMBER_COUNT = 6;
const fileMembers = new Set(["LICENSE","README.md","index.js","package.json","tui.ts"]);
let libMemberCount = 0;
let docsMemberCount = 0;
let distMemberCount = 0;
// Never part of the package: OS metadata a file manager leaves in the build
// output directory.
const DIST_METADATA = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
declaredFiles.forEach((f) => {
  if (f === "lib/") {
    const libAbs = join(repoRoot, "lib");
    if (!existsSync(libAbs)) {
      fatal(`package.json declares "lib/" but ${libAbs} is missing`);
    }
    for (const ent of readdirSync(libAbs, { withFileTypes: true })) {
      if (ent.isFile()) {
        fileMembers.add(`lib/${ent.name}`);
        libMemberCount++;
      }
    }
  } else if (f === "docs/") {
    const docsAbs = join(repoRoot, "docs");
    if (!existsSync(docsAbs)) {
      fatal(`package.json declares "docs/" but ${docsAbs} is missing`);
    }
    for (const ent of readdirSync(docsAbs, { withFileTypes: true })) {
      // Directories and symlinks are rejected, not skipped: `npm pack` would
      // still copy their contents while the depth-1 member count stayed valid,
      // so a nested draft/log/env file would ride along unnoticed.
      if (!ent.isFile()) {
        fatal(`unexpected non-file entry in docs/: ${ent.name}`);
      }
      // Allowlist, not an open wildcard: docs/ ships byte-for-byte to npm, so
      // a stray draft/log/env file must fail the gate instead of riding along.
      if (!/\.(png|jpe?g|gif|webp|svg)$/i.test(ent.name)) {
        fatal(`unexpected non-image file in docs/: ${ent.name}`);
      }
      fileMembers.add(`docs/${ent.name}`);
      docsMemberCount++;
    }
  } else if (f === "dist/") {
    // The Desktop GUI bundle: a built artifact, so the directory is expanded by
    // an explicit allowlist. A missing bundle (fresh checkout without
    // `npm run build:gui`) and any stray file both fail loudly - a published
    // package without ./gui-experimental would make the export point at nothing.
    const distAbs = join(repoRoot, "dist");
    if (!existsSync(distAbs)) {
      fatal(`package.json declares "dist/" but ${distAbs} is missing - run: npm run build:gui`);
    }
    for (const ent of readdirSync(distAbs, { withFileTypes: true })) {
      if (!ent.isFile()) fatal(`unexpected non-file entry in dist/: ${ent.name}`);
      // OS metadata can land in a generated directory without anyone noticing
      // (Finder's .DS_Store, Explorer's Thumbs.db/desktop.ini). It is not ours
      // to ship, and npm would happily pack it, so it is ignored rather than
      // failing a release on a stray file the build did not create.
      if (DIST_METADATA.has(ent.name)) continue;
      if (ent.name !== "gui-experimental.cjs") {
        fatal(`unexpected file in dist/: ${ent.name} (only the GUI bundle belongs there)`);
      }
      fileMembers.add(`dist/${ent.name}`);
      distMemberCount++;
    }
    if (distMemberCount === 0) {
      fatal(`dist/ has no gui-experimental.cjs - run: npm run build:gui`);
    }
  } else if (!f.endsWith("/")) {
    fileMembers.add(f);
  }
  // Other directory wildcards are not used in this repo.
});
const expectedMembers = BASE_MEMBER_COUNT + libMemberCount + docsMemberCount + distMemberCount;
if (fileMembers.size !== expectedMembers) {
  fatal(`expected ${expectedMembers} tarball members, got ${fileMembers.size}: ${[...fileMembers].join(", ")}`);
}
const bad = [...fileMembers].filter(
  (f) => f.includes("node_modules") || f.includes("test/") ||
         f.includes("tsconfig") || f.includes(".git"),
);
if (bad.length) fatal(`package.json files includes dev/test artifacts: ${bad.join(", ")}`);

// Every published export must point at a file that is actually packed. An
// export target outside `files[]` stays in the tarball only by luck (or not at
// all) and then resolves to nothing for consumers, without any npm warning.
const exportTargets = Object.values(pkgMeta.exports || {})
  .flatMap((value) =>
    typeof value === "string" ? [value] : Object.values(value || {}),
  )
  .filter((value) => typeof value === "string")
  .map((value) => value.replace(/^\.\//, ""));
const missingExports = exportTargets.filter((t) => !fileMembers.has(t));
if (missingExports.length) {
  fatal(`package.json exports target unpacked files: ${missingExports.join(", ")}`);
}
pass(`tarball: ${[...fileMembers].join(", ")} (${fileMembers.size} members, no dev artifacts)`);

// ---------------------------------------------------------------------------
// (b) TUI sources — no JSX, no pragma, host-bridgeable imports
//
// OpenCode installs npm plugins inside a `node_modules` tree, where the host
// SKIPS the Solid/Babel JSX transform (sourceFilter in
// @opentui/solid/scripts/solid-plugin.js; upstream anomalyco/opencode#33884).
// A JSX file in that position is compiled by Bun's plain transform instead and
// then needs `@opentui/solid` installed next to it just to resolve the emitted
// jsx-runtime import; the mounted slot renders once and freezes. The fix is
// structural: the package ships NO JSX at all and builds every tree with
// jsx() + getter props (lib/tui-h.ts), so the host's runtime-module rewrite of
// the literal `@opentui/solid/jsx-runtime` import keeps the surfaces live for
// npm installs too. These checks keep that invariant enforceable:
//   - no .tsx/.jsx file anywhere in the TUI surface (package root + lib/),
//   - every TUI source parses with esbuild loader "ts" (JSX syntax fails),
//   - no `@jsx*` pragma anywhere (only a JSX file would need one),
//   - imports stay inside the host-bridgeable allowlist,
//   - no react/jsx-runtime in the output.
//
// Uses the esbuild PROGRAMMATIC API (transformSync), never `node <cli-bin>`.
// The API resolves the native binary from `@esbuild/<platform>` and spawns it
// as an executable with correct platform semantics (ELF/exe), identically on
// Windows and Linux. The old code ran `node node_modules/esbuild/bin/esbuild`,
// which works on Windows (JS shim) but fails on Linux where that path is the
// native ELF binary — node then parses it as JS and throws
// `SyntaxError: Invalid or unexpected token`.
// ---------------------------------------------------------------------------
console.log("\n(b) TUI sources: no JSX, no pragma, host-bridgeable imports...");

// The import rules are shared with gate (c) (test/lib/import-scan.cjs) so the
// two gates cannot drift apart on what "an import the host can provide" means.
const {
  isBuiltin,
  isRelative,
  isHostBridged,
  hasFileExtension,
  importSpecifiersOf,
} = importScan;
const isAllowedImport = (spec) =>
  isBuiltin(spec) || isRelative(spec) || isHostBridged(spec);

const jsxSources = [];
for (const dir of ["", "lib"]) {
  const abs = dir ? join(repoRoot, dir) : repoRoot;
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    if (!ent.isFile()) continue;
    if (/\.(?:tsx|jsx)$/.test(ent.name)) {
      jsxSources.push(dir ? `${dir}/${ent.name}` : ent.name);
    }
  }
}
if (jsxSources.length) {
  fatal(
    `JSX source file(s) in the TUI surface: ${jsxSources.join(", ")}. ` +
      `OpenCode skips the Solid transform under node_modules (#33884), so a JSX ` +
      `file freezes the npm-installed sidebar. Build the tree with ` +
      `jsx()/getter props from lib/tui-h.ts instead.`,
  );
}

const tuiSources = [
  "tui.ts",
  ...readdirSync(join(repoRoot, "lib"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
    .sort()
    .map((f) => join("lib", f)),
];
let checked = 0;
let jsxRuntimeImports = 0;
for (const rel of tuiSources) {
  const source = readFileSync(join(repoRoot, rel), "utf8");

  // A `@jsx*` pragma only makes sense in a JSX file; here it is a regression
  // marker (and would drag @opentui/solid back into production dependencies).
  // The leading `*` covers the classic multi-line docblock form
  // (`/*` on one line, ` * @jsxImportSource ...` on the next), which Bun still
  // sees as a pragma in the first comment of the file.
  const lines = source.split("\n");
  const pragmaAt = lines.findIndex((line) =>
    /^\s*(?:\*|\/\*+|\/\/)+\s*@jsx/.test(line),
  );
  if (pragmaAt >= 0) {
    fatal(
      `${rel}:${pragmaAt + 1}: JSX pragma found — the TUI surface must stay ` +
        `JSX-free (see lib/tui-h.ts)`,
    );
  }

  let transpiled;
  try {
    // loader "ts" (NOT "tsx"): JSX syntax is a hard error here, which is
    // exactly the invariant that keeps npm installs live.
    transpiled = transformSync(source, { loader: "ts", format: "esm" }).code;
  } catch (e) {
    fatal(
      `${rel}: not valid JSX-free TypeScript: ` +
        `${((e && e.message) || String(e)).slice(0, 300)}`,
    );
  }
  if (transpiled.includes("react/jsx-runtime")) {
    fatal(`${rel}: transpiled output contains react/jsx-runtime`);
  }

  for (const spec of importSpecifiersOf(source)) {
    if (!isAllowedImport(spec)) {
      fatal(
        `${rel}: import "${spec}" is not bridged by the opencode TUI loader. ` +
          `Allowed: node:*, bun:*, relative paths, @opencode/plugin/tui, ` +
          `@opentui/solid*, solid-js[/store].`,
      );
    }
    // The host walks the import graph with import.meta.resolve(specifier,
    // importer), which never probes extensions: an extensionless relative
    // import is not followed, so that file is left WITHOUT the runtime-module
    // rewrite loader and the npm install fails with
    // `Cannot find package '@opentui/solid'` (found exactly this way in
    // test/e2e-tui.mjs Check C).
    if (isRelative(spec) && !hasFileExtension(spec)) {
      fatal(
        `${rel}: relative import "${spec}" has no file extension — the host ` +
          `rewrite walk does not resolve extensionless imports, so that file ` +
          `would keep a literal jsx-runtime import and break npm installs. ` +
          `Write "${spec}.ts" (or .js).`,
      );
    }
    if (spec === "@opentui/solid/jsx-runtime") jsxRuntimeImports++;
  }
  checked++;
}
if (jsxRuntimeImports === 0) {
  fatal(
    `no static "@opentui/solid/jsx-runtime" import in any TUI source — ` +
      `lib/tui-h.ts must import it literally so the host can rewrite it`,
  );
}
pass(
  `${checked} JSX-free TUI source(s) parsed with loader "ts"; ` +
    `imports bridged, ${jsxRuntimeImports} literal jsx-runtime import(s), react absent`,
);

// ---------------------------------------------------------------------------
// (c) resolve chain — what the TUI sources import, and where it comes from
//
// The TUI surface must get @opentui/solid/jsx-runtime, solid-js and
// @opencode/plugin/tui from the HOST (one shared instance each) and every
// other import from node builtins or a file we ship. resolve-bridge.cjs walks
// the actual sources, so a new import cannot silently escape the gate.
// ---------------------------------------------------------------------------
console.log("\n(c) resolve chain — host-bridged modules + local imports...");
{
  // FIX Critical: execSync has NO { args } option — use spawnSync.
  // resolve-bridge.cjs is self-contained (uses CJS __dirname internally).
  const bridgeScript = join(repoRoot, "test", "resolve-bridge.cjs");
  const r = spawnSync(process.execPath, [bridgeScript], {
    cwd: repoRoot, encoding: "utf8",
  });
  // r.status === 0 means all required packages resolved.
  // r.stderr may contain FAILED lines even when status === 0.
  const out = (r.stdout || "") + (r.stderr || "");
  const failedLines = out.split("\n").filter((l) => l.startsWith("FAILED "));
  if (r.status !== 0 || failedLines.length > 0) {
    if (failedLines.length > 0) {
      failedLines.forEach((l) => console.error("  ", l));
      fatal(`resolve chain failed:\n  ${failedLines.join("\n  ")}`);
    }
    fatal(`resolve-bridge.cjs failed (exit ${r.status}): ${out.slice(0, 200)}`);
  }
  console.log(`  ✓ every TUI import resolves (host-bridged or shipped file)`);
  console.log(`  ✓ no host-bridged module in production dependencies`);
}

// ---------------------------------------------------------------------------
// (d) unit harness T1–T12 + T13+ (contributors.js extraction)
// ---------------------------------------------------------------------------
console.log("\n(d) Unit harness T1–T12 + T13+...");

// FIX Major 3 (env-gate): use an ISOLATED state file — never touch the live
// <tmpdir>/opencode-context-indicator-state.json.  Both index.js and tui.ts
// honour OPENCODE_CONTEXT_INDICATOR_STATE_FILE.  We write the seed BEFORE
// import so hydrateModelLimitsFromState() finds it at parse time.
// No backup/restore of the live file is needed.
const HARNESS_STATE = join(tmpdir(), "oci-prepublish-state.json");

// Seed data — must yield >= 4 valid model-limit entries for T1.
// NOTE: seed usable/limit may be OLD persisted values (some written with a
// different reserve share). hydrateModelLimitsFromState() only reads `limit` and
// re-derives the ceiling with the CURRENT formula, so a seed is accepted when
// its `usable <= limit` (otherwise the entry is dropped, see ses_T11); the
// derived usable is then window - reserve with reserve = max(15% of window, 16k
// when window >= 32k).
const seedState = {
  ses_MAIN: {
    sessionID:"ses_MAIN",parentID:null,role:"main",agent:"orchestrator",
    model:"model-alpha",providerID:"test-provider",ctx:279312,input:279000,
    usable:445645,limit:524288,reasoning:0,
    // persisted value only: a cold write inherits it; a live lookup re-derives
    // window=524288, reserve=max(78643,16000)=78643, usable=445645
    categories:{user:1000,assistant:1000,reasoning:0,toolArgs:0,system:1000,toolSchemas:1000,other:1000},
    updatedAt:"2026-09-29T18:51:54.013Z",
  },
  ses_OLDAGENT: {
    sessionID:"ses_OLDAGENT",parentID:"ses_MAIN",role:"sub",agent:"code_critic",
    model:"model-beta",providerID:"test-provider",ctx:60950,input:60000,
    usable:891290,limit:1048576,reasoning:0,
    // derived ceiling: window=1048576, reserve=157286, usable=891290
    categories:{user:100,assistant:100,reasoning:0,toolArgs:0,system:null,toolSchemas:null,other:100},
    updatedAt:"2026-09-29T17:25:10.535Z",
  },
  ses_T7: {
    sessionID:"ses_T7",parentID:null,role:"main",agent:null,
    model:"model-gamma",providerID:"test-provider",ctx:50000,input:50000,
    usable:170000,limit:200000,reasoning:0,
    // derived ceiling: window=200000, reserve=max(30000,16000)=30000, usable=170000
    categories:{user:100,assistant:100,reasoning:0,toolArgs:0,system:100,toolSchemas:100,other:100},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T8: {
    sessionID:"ses_T8",parentID:null,role:"main",agent:null,
    model:"model-theta",providerID:"provA",ctx:10,input:10,
    usable:189,limit:222,reasoning:0,
    // derived ceiling: window=222, reserve=floor(222*0.15)=33, usable=189
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T9_OLD: {
    sessionID:"ses_T9_OLD",parentID:null,role:"main",agent:null,
    model:"model-delta",providerID:"test-provider",ctx:1,input:1,
    usable:170000,limit:200000,reasoning:0,
    // derived ceiling: window=200000, reserve=30000, usable=170000 (seed stays)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T10:00:00.000Z",
  },
  ses_T9_NEW: {
    sessionID:"ses_T9_NEW",parentID:null,role:"main",agent:null,
    model:"model-delta",providerID:"test-provider",ctx:1,input:1,
    usable:891290,limit:1048576,reasoning:0,
    // derived ceiling: window=1048576, reserve=157286, usable=891290 (freshest wins)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T10_A: {
    sessionID:"ses_T10_A",parentID:null,role:"main",agent:null,
    model:"model-epsilon",providerID:"test-provider",ctx:1,input:1,
    usable:170000,limit:200000,reasoning:0,
    // derived ceiling: window=200000, reserve=30000, usable=170000 (seed stays)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T10:00:00.000Z",
  },
  ses_T10_B: {
    sessionID:"ses_T10_B",parentID:null,role:"main",agent:null,
    model:"model-epsilon",providerID:"test-provider",ctx:1,input:1,
    usable:170000,limit:200000,reasoning:0,
    // derived ceiling: window=200000, reserve=30000, usable=170000 (freshest)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T11: {
    sessionID:"ses_T11",parentID:null,role:"main",agent:null,
    model:"model-zeta",providerID:"test-provider",ctx:1,input:1,
    usable:300000,limit:200000,reasoning:0,
    // derived ceiling: window=200000, usable=170000; seed 300000 > limit -> filtered
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T12: {
    sessionID:"ses_T12",parentID:null,role:"main",agent:null,
    model:"model-eta",providerID:"test-provider",ctx:1,input:1,
    usable:425000,limit:500000,reasoning:0,
    // derived ceiling: window=500000, reserve=75000, usable=425000 (seed <= limit)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  // Extra sessions: 5 valid models (alpha,beta,gamma,theta,delta) ≥ T1's >=4
  ses_EXT_A: {
    sessionID:"ses_EXT_A",parentID:null,role:"main",agent:"code_critic",
    model:"Claude-3.5-Sonnet",providerID:"anthropic",ctx:200000,input:199000,
    usable:170000,limit:200000,reasoning:0,
    // derived ceiling: window=200000, reserve=30000, usable=170000
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T12:00:00.000Z",
  },
  ses_EXT_B: {
    sessionID:"ses_EXT_B",parentID:null,role:"main",agent:null,
    model:"gemini-2.5-Pro",providerID:"google",ctx:1048576,input:1048000,
    usable:891290,limit:1048576,reasoning:0,
    // derived ceiling: window=1048576, reserve=157286, usable=891290
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T15:30:00.000Z",
  },
  // T17 (tombstone prune): dates computed at seed time so the test is immune
  // to suite aging. Unique model names — these entries must never win the
  // freshest-wins limit seeding for a model another test asserts on.
  ses_T17_OLD: {
    sessionID:"ses_T17_OLD",parentID:null,role:"main",agent:null,
    model:"model-tombstone-old",providerID:"test-provider",ctx:1,input:1,
    usable:170000,limit:200000,reasoning:0,
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:new Date(Date.now() - 40 * 86400e3).toISOString(),
  },
  ses_T17_FRESH: {
    sessionID:"ses_T17_FRESH",parentID:null,role:"main",agent:null,
    model:"model-tombstone-fresh",providerID:"test-provider",ctx:1,input:1,
    usable:170000,limit:200000,reasoning:0,
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:new Date(Date.now() - 1 * 86400e3).toISOString(),
  },
};

// Age-immunity refresh: the state.js tombstone prune (PRUNE_AFTER_MS = 7
// days) would eventually eat the hardcoded 2026-09-29 seed dates and break
// the suite. Re-stamp every seeded entry (except the T17 pair, which manages
// its own dates) to ~2 days ago, preserving the original relative ordering
// - T9_OLD/T9_NEW and T10_A/T10_B freshest-wins semantics stay intact.
{
  const exempt = new Set(["ses_T17_OLD", "ses_T17_FRESH"]);
  const stampable = Object.entries(seedState)
    .filter(([k, v]) => !exempt.has(k) && Number.isFinite(Date.parse(v.updatedAt)))
    .sort((a, b) => Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt));
  const base = Date.now() - 2 * 86400e3;
  stampable.forEach(([k, v], i) => {
    seedState[k].updatedAt = new Date(base + i * 60000).toISOString();
  });
}

writeFileSync(HARNESS_STATE, JSON.stringify(seedState), "utf8");
process.env.OPENCODE_CONTEXT_INDICATOR_STATE_FILE = HARNESS_STATE;
// Same isolation for the human-readable log: idle/compacted handlers rewrite
// it, so point them at a throwaway file instead of the user's real one.
process.env.OPENCODE_CONTEXT_INDICATOR_LOG_FILE = join(tmpdir(), "oci-prepublish-log.log");
// And the cross-instance dedup markers: claimOnce writes tiny marker files with
// a 24h TTL, so without this the harness would leave them in the user's dir.
process.env.OPENCODE_CONTEXT_INDICATOR_DEDUP_DIR = join(tmpdir(), "oci-prepublish-dedup");
// The limits path now also honours the user's configured `compaction.buffer`.
// Point the global lookup at an empty throwaway tree BEFORE importing index.js
// so a developer's own config can never change the expected 15% reserves
// (T7/T16/T25/T37). T38 overrides this again and restores it afterwards.
process.env.XDG_CONFIG_HOME = join(tmpdir(), `oci-prepublish-xdg-${process.pid}`);

const mod  = await import(pathToFileURL(join(repoRoot, "index.js")).href);
const read = () => JSON.parse(readFileSync(HARNESS_STATE, "utf8"));

const capture = (fn) => {
  const logs = [], errs = [];
  const ol = console.log, oe = console.error;
  console.log = (...a) => logs.push(a.map(String).join(" "));
  console.error = (...a) => errs.push(a.map(String).join(" "));
  try { return { result: fn(), logs, errs }; }
  finally { console.log = ol; console.error = oe; }
};
const quietErr = (fn) => {
  const errs = [];
  const oe = console.error;
  console.error = (...a) => errs.push(a.map(String).join(" "));
  try { fn(); } finally { console.error = oe; }
  return errs;
};

let failed = 0;
let ranChecks = 0; // auto-counted: the hardcoded totals drifted from reality
const check = (name, fn) => {
  ranChecks++;
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg || "assertion failed"); };

const mockCtx = { session: { get: async () => ({}), context: async () => ({data: null}) } };

// T1
mod.modelLimits.clear();
const cap1 = capture(() => mod.hydrateModelLimitsFromState());
check("T1 hydrate seeds modelLimits from state.json", () => {
  assert(cap1.result >= 4, `got ${cap1.result}`);
  assert(mod.getUsableContext("test-provider","model-alpha")?.usable > 0);
});

// T2
mod.modelLimits.clear(); mod.sessionAgentCache.clear(); mod.sessionParentCache.clear();
const e2 = quietErr(() => mod.writeStateFile("ses_MAIN","model-alpha","test-provider",279000,279312,0));
check("T2 writeStateFile preserves usable/limit/agent (cold)", () => {
  assert(e2.length === 0);
  const e = read().ses_MAIN;
  // modelLimits is empty here, so the denominator is INHERITED from the seeded
  // entry (same model as prev): usable=445645, limit=524288, agent kept.
  assert(e.ctx === 279312 && e.usable === 445645 && e.limit === 524288 && e.agent === "orchestrator");
});

// T3
mod.modelLimits.clear(); mod.sessionAgentCache.clear(); mod.sessionParentCache.clear();
const e3 = quietErr(() => mod.writeStateFile("ses_OLDAGENT","model-beta","test-provider",60000,60950,0));
check("T3 writeStateFile preserves sub agent + parentID", () => {
  assert(e3.length === 0);
  const e = read().ses_OLDAGENT;
  assert(e.agent === "code_critic" && e.parentID === "ses_MAIN" && e.role === "sub");
});

// T4
mod.modelLimits.clear(); mod.sessionAgentCache.clear(); mod.sessionParentCache.clear();
// Re-seed so getUsableContext produces usable+reserve for the compact-at line.
capture(() => mod.hydrateModelLimitsFromState());
const state1 = read();
const repMain = await mod.collectSessionReport(mockCtx,"ses_MAIN",state1,Date.now()+2000);
check("T4 main report keeps the denominator from state", () => {
  // Derived: usable=445645; ctx=279312; pct=279312/445645=63%
  assert(repMain.usable === 445645);
  assert(repMain.ctxTokens === 279312);
  assert(Math.round((repMain.ctxTokens / repMain.usable) * 100) === 63);
});

// T4b
check("T4b report carries the compact-at reserve", () => {
  // window 512k -> reserve=max(floor(0.15*524288),16000)=78643
  assert(repMain.reserve === 78643, `reserve ${repMain.reserve}`);
});

// T5
const repSub = await mod.collectSessionReport(mockCtx,"ses_OLDAGENT",state1,Date.now()+2000);
check("T5 old record keeps the agent attribution", () => {
  assert(repSub.agent === "code_critic");
  assert(repSub.parentID === "ses_MAIN");
  assert(repSub.categories.user === 100, `user ${repSub.categories.user}`);
});

// T6
mod.modelLimits.clear();
const errsT6 = [], logsT6 = [];
const ol6 = console.log, oe6 = console.error;
console.log = (...a) => logsT6.push(a.map(String).join(" "));
console.error = (...a) => errsT6.push(a.map(String).join(" "));
try { await mod.ensureModelLimits({model:{list:async()=>[]}}); }
finally { console.log = ol6; console.error = oe6; }
check("T6 ensureModelLimits([]) logs reason + hydrates", () => {
  assert(errsT6.some((l)=>l.includes("yielded 0 usable limits")));
  assert(mod.getUsableContext("test-provider","model-alpha")?.usable > 0);
});

// T7
mod.modelLimits.clear(); mod.sessionAgentCache.clear(); mod.sessionParentCache.clear();
capture(() => mod.hydrateModelLimitsFromState());
const state2 = read();
const repT7 = await mod.collectSessionReport(mockCtx,"ses_T7",state2,Date.now()+2000);
check("T7 denominator == entry.limit window (new formula, not old usable-as-window)", () => {
  // Seed: limit=200000, usable=170000. Derived: window=200000, reserve=max(30000,16000)=30000, usable=170000
  // (The old formula would have double-reserved; the derived ceiling ignores the seed usable)
  assert(mod.getUsableContext("test-provider","model-gamma")?.usable === 170000);
  assert(repT7.usable === 170000, `got ${repT7.usable}`);
  // reserve should be 30000 (15% of 200000, which exceeds 16000)
  assert(mod.getUsableContext("test-provider","model-gamma")?.reserved === 30000);
});

// T8
mod.modelLimits.clear(); mod.sessionAgentCache.clear(); mod.sessionParentCache.clear();
const e8 = quietErr(() => mod.writeStateFile("ses_T8","model-theta","provB",1,2,0));
check("T8 provider change does not inherit usable/limit", () => {
  assert(e8.length === 0);
  const e = read().ses_T8;
  assert(e.providerID === "provB" && e.usable == null && e.limit == null);
});

// T9
mod.modelLimits.clear();
const cap9 = capture(() => mod.hydrateModelLimitsFromState());
check("T9 stale 170k vs fresh 891290 -> freshest wins", () => {
  // derived: window=1048576, reserve=max(157286,16000)=157286, usable=891290
  assert(mod.getUsableContext("test-provider","model-delta")?.usable === 891290);
  assert(cap9.logs.some((l)=>l.includes("model-delta")&&l.includes("891290")));
  assert(cap9.errs.some((l)=>l.includes("spread")&&l.includes("model-delta")));
});

// T10
mod.modelLimits.clear();
const cap10 = capture(() => mod.hydrateModelLimitsFromState());
check("T10 uniform candidates -> 170k, no spread warning", () => {
  // derived: window=200000, reserve=30000, usable=170000
  assert(mod.getUsableContext("test-provider","model-epsilon")?.usable === 170000);
  assert(!cap10.errs.some((l)=>l.includes("model-epsilon")));
});

// T11: usable > limit (300k/200k) — impossible, dropped.
mod.modelLimits.clear();
capture(() => mod.hydrateModelLimitsFromState());
check("T11 usable > limit is dropped", () => {
  assert(mod.getUsableContext("test-provider","model-zeta") == null);
  assert(!mod.modelLimits.has("test-provider:model-zeta"));
});

// T12: usable < limit (425k/500k) - LEGITIMATE, seeded.
mod.modelLimits.clear();
const cap12 = capture(() => mod.hydrateModelLimitsFromState());
check("T12 usable < limit is LEGITIMATE, seeded", () => {
  // derived: window=500000, reserve=75000, usable=425000 (seed usable <= limit)
  assert(mod.getUsableContext("test-provider","model-eta")?.usable === 425000);
  assert(cap12.logs.some((l)=>l.includes("model-eta")&&l.includes("425000")));
});

if (failed) fatal(`${failed} unit test(s) failed`);
pass(`all ${ranChecks} unit checks passed`);

// ---------------------------------------------------------------------------
// T13+ — lib/contributors.js pure-helper tests + new formula cases
// ---------------------------------------------------------------------------

// Import the new lib/contributors.js helpers directly (plain ESM, no TS).
const contrib = await import(pathToFileURL(join(repoRoot, "lib", "contributors.js")).href);

check("T13 measureContributors: empty input returns []", () => {
  assert(Array.isArray(contrib.measureContributors([])));
  assert(contrib.measureContributors([]).length === 0);
});

check("T13a measureContributors: ordering by tokens desc", () => {
  const msgs = [
    { type: "user", text: "a".repeat(100) }, // ~25 tokens
    { type: "assistant", content: [{ type: "text", text: "b".repeat(400) }] }, // ~100 tokens
    { type: "assistant", content: [{ type: "reasoning", text: "c".repeat(200) }] }, // ~80 tokens
  ];
  const result = contrib.measureContributors(msgs);
  assert(result.length > 0);
  assert(result[0].tokensEstimate >= result[1].tokensEstimate);
});

check("T13b measureContributors: per-tool-call granularity with tool name", () => {
  const msgs = [
    { type: "assistant", content: [
      { type: "tool", name: "bash", state: { input: { cmd: "ls" } } },
      { type: "tool", name: "read", state: { input: { path: "a.js" } } },
    ]},
  ];
  const result = contrib.measureContributors(msgs);
  const tools = result.filter((c) => c.kind === "asst.tool");
  assert(tools.length === 2, `expected 2 tool parts, got ${tools.length}`);
  assert(tools.some((c) => c.tool === "bash"), "tool name bash missing");
  assert(tools.some((c) => c.tool === "read"), "tool name read missing");
  // raw args JSON: no preview
  const bashPart = tools.find((c) => c.tool === "bash");
  assert(bashPart?.preview === "", "bash preview should be empty string");
});

check("T13c measureContributors: reasoning parts", () => {
  const msgs = [
    { type: "assistant", content: [
      { type: "reasoning", text: "thinking step one about the problem" },
      { type: "text", text: "Here is the answer." },
    ]},
  ];
  const result = contrib.measureContributors(msgs);
  const rsn = result.find((c) => c.kind === "asst.rsn");
  assert(rsn != null, "reasoning contributor missing");
  assert(rsn.tokensEstimate > 0);
});

check("T13d measureContributors: tool result outputs counted", () => {
  const msgs = [
    { type: "assistant", content: [
      { type: "tool", name: "bash", state: { input: { cmd: "pwd" }, content: [{ type: "text", text: "/home/user" }] } },
    ]},
  ];
  const result = contrib.measureContributors(msgs);
  const result2 = result.find((c) => c.kind === "asst.result");
  assert(result2 != null, "tool result contributor missing");
  assert(result2.tool === "bash");
});

check("T13e measureContributors: HH:MM ref from message time.created", () => {
  // Use a fixed timestamp: 2026-10-08 14:25:30 UTC
  const msgs = [
    { type: "assistant", content: [{ type: "text", text: "hello world" }], time: { created: 1728395130000 } },
  ];
  const result = contrib.measureContributors(msgs);
  // Timezone-dependent — just check the format (HH:MM, 2 digits each)
  assert(/^\d{2}:\d{2}$/.test(result[0]?.ref || ""), `expected HH:MM, got ${result[0]?.ref}`);
});

check("T13f measureContributors: preview bounded (26 chars, surrogate-safe)", () => {
  // Two boundary cases for the 26-code-point preview bound.
  // Case 1: the emoji sits exactly AT the cut (25 a's + emoji + filler). A
  // code-point-safe truncation drops it WHOLE (25 cps + "~"); a naive
  // UTF-16-unit slice would leave a lone high surrogate.
  const atCut = [
    { type: "assistant", content: [{ type: "text", text: "a".repeat(25) + "\u{1F600}" + "b".repeat(50) }] },
  ];
  const p1 = contrib.measureContributors(atCut)[0]?.preview || "";
  assert([...p1].length <= 26, `preview too long: ${[...p1].length} cps`);
  const noLone = (s) =>
    [...s].every((c) => c.codePointAt(0) < 0xd800 || c.codePointAt(0) > 0xdfff);
  assert(noLone(p1), "preview contains a broken surrogate pair (at-cut case)");
  // Case 2: the emoji sits INSIDE the kept window and must survive whole.
  const inside = [
    { type: "assistant", content: [{ type: "text", text: "x" + "\u{1F600}" + "a".repeat(50) }] },
  ];
  const p2 = contrib.measureContributors(inside)[0]?.preview || "";
  assert([...p2].length <= 26, `preview too long: ${[...p2].length} cps`);
  assert(noLone(p2), "preview contains a broken surrogate pair (inside case)");
  assert(
    [...p2].some((c) => c.codePointAt(0) === 0x1f600),
    "preview lost the emoji that fits inside the kept window",
  );
});

check("T13g measureContributors: top-5 cutoff", () => {
  const msgs = [];
  for (let i = 0; i < 10; i++) {
    msgs.push({ type: "assistant", content: [{ type: "text", text: `x`.repeat(i * 100) }] });
  }
  const result = contrib.measureContributors(msgs);
  // measureContributors itself returns all, top-5 is a display concern.
  // Verify result is sorted desc.
  for (let i = 1; i < result.length; i++) {
    assert(result[i - 1].tokensEstimate >= result[i].tokensEstimate);
  }
});

check("T13h measureContributors: robustness against junk entries", () => {
  const msgs = [null, 42, { type: "user" }, { type: "assistant", text: "hi" }, "not an object", { type: "assistant", content: null }];
  // Must not throw
  const result = contrib.measureContributors(msgs);
  assert(Array.isArray(result));
});

check("T14 buildRedactedPayload: no preview text, no full session id, no tool output content", () => {
  const now = new Date("2026-10-08T14:25:30.123Z");
  const sessionID = "ses_testABCDEF";
  const root = { model: "your-model", providerID: "your-provider", ctx: 100000, usable: 170000, limit: 200000, updatedAt: "2026-10-08T14:25:00.000Z" };
  const rows = [root, { model: "sub-model", ctx: 50000, usable: 90000, limit: 100000, updatedAt: "2026-10-08T14:20:00.000Z" }];
  const contributors = [
    { kind: "asst.text", ref: "14:25", chars: 200, tokensEstimate: 50, tool: "", preview: "SENSITIVE DATA" },
    { kind: "asst.result", ref: "14:25", chars: 500, tokensEstimate: 125, tool: "bash", preview: "user@host:~$ ls /etc/passwd" },
  ];
  const payload = contrib.buildRedactedPayload({ sessionID, root, rows, contributors, now, panelDenom: contrib.panelDenom, panelRole: contrib.panelRole, num: (v) => v || 0 });
  const json = JSON.stringify(payload);
  // NO preview text
  assert(!json.includes("SENSITIVE DATA"), "payload must not contain preview text");
  // NO tool output content
  assert(!json.includes("passwd"), "payload must not contain tool output");
  // NO full session id (only id8...)
  assert(!json.includes("ses_testABCDEF"), "payload must not contain full session id");
  assert(json.includes("ses_test..."), "payload must contain id8-prefixed id");
  // contributors must have no preview field
  assert(!payload.contributors[0].hasOwnProperty("preview"), "contributor must not have preview");
  assert(!payload.contributors[1].hasOwnProperty("preview"), "contributor must not have preview");
});

check("T14a buildRedactedPayload: pct rounding", () => {
  const now = new Date();
  const root = { model: "m", ctx: 33333, usable: 100000, limit: 200000, updatedAt: "2026-10-08T00:00:00.000Z" };
  const payload = contrib.buildRedactedPayload({ sessionID: "s", root, rows: [root], contributors: [], now, panelDenom: contrib.panelDenom, panelRole: contrib.panelRole, num: (v) => v || 0 });
  assert(payload.family[0].pct === Math.round(33333 / 100000 * 100), `got ${payload.family[0].pct}`);
});

check("T14b buildRedactedPayload: family role mapping (positional main)", () => {
  const now = new Date();
  const rows = [
    { model: "main-model", ctx: 100, usable: 170000, limit: 200000, updatedAt: "2026-10-08T00:00:00.000Z" },
    { model: "sub-model", ctx: 50, usable: 170000, limit: 200000, updatedAt: "2026-10-08T00:01:00.000Z" },
  ];
  const payload = contrib.buildRedactedPayload({ sessionID: "s", root: rows[0], rows, contributors: [], now, panelDenom: contrib.panelDenom, panelRole: contrib.panelRole, num: (v) => v || 0 });
  assert(payload.family[0].role === "main", `root should be main, got ${payload.family[0].role}`);
  assert(payload.family[1].role === "sub", `child should be sub, got ${payload.family[1].role}`);
});

check("T15 exportFileName: exact pattern", () => {
  // exportFileName uses LOCAL time (getHours/getMinutes/getSeconds on the Date).
  // Use local time: create a Date for 2026-10-08 14:25:30.123 in local timezone.
  // On systems where local = UTC+3 (e.g. Moscow), this becomes 2026-10-08T17:25:30.123 local.
  // We construct the date from its epoch ms so the local interpretation is deterministic.
  const localDate = new Date();
  localDate.setFullYear(2026, 9, 8); // month is 0-indexed
  localDate.setHours(14, 25, 30, 123);
  const name = contrib.exportFileName("ses_abcdefgh", localDate);
  // id8 = first 8 chars of "ses_abcdefgh" = "ses_abcd"; local date encoded
  assert(name.startsWith("context-ses_abcd-20261008-"), `got ${name}`);
  assert(name.endsWith(".json"), `got ${name}`);
  // The timestamp part is the only variable (timezone-dependent), so check format
  assert(/\.json$/.test(name));
  // id8 must be exactly 8 chars
  const idPart = name.split("-")[1];
  assert(idPart === "ses_abcd", `id8 should be ses_abcd, got ${idPart}`);
});

check("T15a exportFileName: id8 truncation", () => {
  const now = new Date("2026-10-08T14:25:30.123Z");
  const name = contrib.exportFileName("averylongsessionidstringhere", now);
  assert(name.includes("context-averylon-"), `got ${name}`);
  assert(!name.includes("averylongsessionidstringhere"), "full session id leaked");
});

check("T16 new formula: window 200000 -> usable 170000 reserve 30000", () => {
  // 200000 >= 32000, so reserve = max(30000, 16000) = 30000 (core: 15%)
  assert(mod.getUsableContext("test-provider","model-gamma")?.usable === 170000, "window=200000: usable should be 170000");
  assert(mod.getUsableContext("test-provider","model-gamma")?.reserved === 30000, "reserve should be 30000");
});

check("T16a new formula: window 100000 -> reserve 16000 (min beats 15%)", () => {
  // floor(100000 * 0.15) = 15000 < 16000 -> RESERVE_MIN wins
  const r = mod.reserveFor(100000, undefined);
  assert(r === 16000, `window=100000: reserve should be 16000, got ${r}`);
});

check("T16b new formula: window 24000 -> reserve 3600", () => {
  // 24000 < 2 * RESERVE_MIN, so no floor: floor(24000 * 0.15) = 3600
  const r = mod.reserveFor(24000, undefined);
  assert(r === 3600, `window=24000: reserve should be 3600, got ${r}`);
});

check("T16c new formula: window 30000 -> reserve 4500", () => {
  // 30000 < 32000, so no floor: floor(30000 * 0.15) = 4500
  const r = mod.reserveFor(30000, undefined);
  assert(r === 4500, `window=30000: reserve should be 4500, got ${r}`);
});

check("T16c2 new formula: window 32000 -> reserve 16000 (threshold)", () => {
  // 32000 === 2 * RESERVE_MIN -> floor = RESERVE_MIN
  assert(mod.reserveFor(32000, undefined) === 16000);
  assert(mod.reserveFor(31999, undefined) === 4799);
});

check("T16d reserve: window 120000 -> 18000 (share beats floor)", () => {
  // reserveFor(120000) = max(18000, 16000) = 18000
  const r = mod.reserveFor(120000, undefined);
  assert(r === 18000, `window=120000: reserve should be 18000, got ${r}`);
  assert(mod.getUsableContext("test-provider","model-gamma")?.limit === 200000, "window is the seeded context");
});

check("T16e new formula: unknown limits -> null", () => {
  assert(mod.getUsableContext("nonexistent-provider","nonexistent-model") == null);
});

check("T16f new formula: hydrated seed no double-reserve", () => {
  // Seed ses_T7: usable=170000, limit=200000.
  // The seed is re-derived from the raw window: 200000 - 30000 = 170000.
  mod.modelLimits.clear();
  capture(() => mod.hydrateModelLimitsFromState());
  const info = mod.getUsableContext("test-provider","model-gamma");
  assert(info?.usable === 170000, `hydrated usable should be 170000, got ${info?.usable}`);
  assert(info?.reserved === 30000, `hydrated reserve should be 30000, got ${info?.reserved}`);
});

check("T16g reserveFor: bufferOverride takes precedence", () => {
  const r = mod.reserveFor(200000, 5000);
  assert(r === 5000, `bufferOverride=5000: reserve should be 5000, got ${r}`);
});

check("T16h reserveFor: invalid bufferOverride falls through to formula", () => {
  const r1 = mod.reserveFor(200000, -1);
  assert(r1 === 30000, `negative bufferOverride should be ignored, got ${r1}`);
  const r2 = mod.reserveFor(200000, 1e10);
  assert(r2 === 30000, `>1e9 bufferOverride should be ignored, got ${r2}`);
  const r3 = mod.reserveFor(200000, NaN);
  assert(r3 === 30000, `NaN bufferOverride should be ignored, got ${r3}`);
  const r4 = mod.reserveFor(200000, "not a number");
  assert(r4 === 30000, `string bufferOverride should be ignored, got ${r4}`);
  // Valid: 0 is accepted (zero reserve), and any value < window is honored.
  assert(mod.reserveFor(200000, 0) === 0);
  assert(mod.reserveFor(200000, 199999) === 199999);
});

check("T16h2 reserveFor: buffer >= window is ignored (core semantics)", () => {
  // A buffer configured for a larger model must not leave zero room.
  assert(mod.reserveFor(200000, 200000) === 30000);
  assert(mod.reserveFor(200000, 250000) === 30000);
  assert(mod.reserveFor(50000, 50000) === 16000);
  // getUsableContext must apply the same guard to the env override.
  const prev = process.env.OPENCODE_CONTEXT_INDICATOR_COMPACT_BUFFER;
  process.env.OPENCODE_CONTEXT_INDICATOR_COMPACT_BUFFER = "250000";
  try {
    const info = mod.getUsableContext("test-provider", "model-gamma");
    assert(info?.usable === 170000, `ignored oversized env buffer, got ${info?.usable}`);
  } finally {
    if (prev === undefined) delete process.env.OPENCODE_CONTEXT_INDICATOR_COMPACT_BUFFER;
    else process.env.OPENCODE_CONTEXT_INDICATOR_COMPACT_BUFFER = prev;
  }
});

check("T16i reserveFor: non-finite window returns null", () => {
  assert(mod.reserveFor(0, undefined) == null);
  assert(mod.reserveFor(-100, undefined) == null);
  assert(mod.reserveFor(NaN, undefined) == null);
  assert(mod.reserveFor(Infinity, undefined) == null);
  assert(mod.reserveFor(null, undefined) == null);
  assert(mod.reserveFor(undefined, undefined) == null);
});

check("T17 state tombstone prune: month-old entries drop, fresh survive", () => {
  // Isolation: earlier writeStateFile calls in this suite (T2/T3/T8) may have
  // already pruned ses_T17_OLD via their own writes — re-seed the pair so this
  // check proves the prune on its own write, not a leftover from an earlier
  // one. Dates were computed at seed time (40d / 1d ago).
  const cur = read();
  cur.ses_T17_OLD = seedState.ses_T17_OLD;
  cur.ses_T17_FRESH = seedState.ses_T17_FRESH;
  writeFileSync(HARNESS_STATE, JSON.stringify(cur), "utf8");
  mod.writeStateFile("ses_MAIN", "model-alpha", "test-provider", 279000, 279312, 0);
  const snap = read();
  assert(!("ses_T17_OLD" in snap), "40-day-old entry should be pruned");
  assert("ses_T17_FRESH" in snap, "1-day-old entry should survive");
});

const t18ToolResult = (result) => ({
  sessionID: "t18probe",
  messages: [{ role: "user", content: [{ type: "tool-result", name: "probe", result }] }],
  system: [],
  tools: {},
});

check("T18 toolOut: estimator counts text/json/content results, skips file parts", () => {
  const text = mod.estimateBreakdownFromContext(
    t18ToolResult({ type: "text", value: "a".repeat(32) }), null,
  ).toolOutChars;
  assert(text === 8, `32 latin chars should estimate to 8 tokens, got ${text}`);
  const json = mod.estimateBreakdownFromContext(
    t18ToolResult({ type: "json", value: { big: "object" } }), null,
  ).toolOutChars;
  assert(json === 4, `'{"big":"object"}' (16 chars) should estimate to 4, got ${json}`);
  const content = mod.estimateBreakdownFromContext(
    t18ToolResult({
      type: "content",
      value: [{ type: "text", text: "out" }, { type: "file", uri: "file:///x", mime: "text/plain" }],
    }), null,
  ).toolOutChars;
  const textOnly = mod.estimateBreakdownFromContext(
    t18ToolResult({ type: "text", value: "out" }), null,
  ).toolOutChars;
  assert(content === textOnly, "content should count only its text items (file skipped)");
  const fileOnly = mod.estimateBreakdownFromContext(
    t18ToolResult({ type: "content", value: [{ type: "file", uri: "file:///x", mime: "application/pdf" }] }), null,
  ).toolOutChars;
  assert(fileOnly === 0, "file-only result must not be char-estimated");
  // Results also ride in the dedicated "tool" role (host message normalisation):
  // the counter must be role-independent.
  const toolRole = mod.estimateBreakdownFromContext(
    {
      sessionID: "t18probe",
      messages: [{ role: "tool", content: [{ type: "tool-result", name: "probe", result: { type: "text", value: "a".repeat(32) } }] }],
      system: [],
      tools: {},
    },
    null,
  ).toolOutChars;
  assert(toolRole === 8, `role:"tool" results must count too, got ${toolRole}`);
});

check("T18a toolOut: fallback counts persisted tool state.content (SessionMessageInfo shape)", () => {
  // SessionMessageToolStateCompleted carries the payload in state.content
  // (ToolContent[]: {type:"text",text}|{type:"file",uri,mime}) — there is no
  // state.output field on the persisted shape.
  const parts = mod.estimateBreakdownFromClientMessages([
    { type: "assistant", content: [
      {
        type: "tool",
        state: {
          status: "completed",
          input: { cmd: "x" },
          content: [{ type: "text", text: "r".repeat(40) }, { type: "file", uri: "file:///x", mime: "text/plain" }],
        },
      },
    ]},
  ]);
  assert(parts.toolOutChars === 10, `40 latin chars -> 10 tokens, got ${parts.toolOutChars}`);
  assert(parts.systemChars == null && parts.toolSchemasChars == null, "hook-only cells stay null");
  const unresolved = mod.estimateBreakdownFromClientMessages([
    { type: "assistant", content: [{ type: "tool", state: { status: "running", input: { cmd: "x" } } }] },
  ]);
  assert(unresolved.toolOutChars === 0, "no content yet (running) -> 0");
  // Errored tools also carry their payload in state.content (optional there).
  const errored = mod.estimateBreakdownFromClientMessages([
    { type: "assistant", content: [
      {
        type: "tool",
        state: {
          status: "error",
          input: { cmd: "x" },
          error: "boom",
          content: [{ type: "text", text: "e".repeat(20) }],
        },
      },
    ]},
  ]);
  assert(errored.toolOutChars === 5, `20 latin chars -> 5 tokens, got ${errored.toolOutChars}`);
});

check("T18b toolOut: hook -> cache -> state.json category + residual reconciliation", () => {
  mod.onV2Context({
    sessionID: "ses_T18B",
    messages: [
      { role: "user", content: [
        { type: "tool-result", name: "webfetch", result: { type: "text", value: "w".repeat(400) } },
      ]},
    ],
    system: [{ type: "text", text: "sys" }],
    tools: {},
  });
  mod.writeStateFile("ses_T18B", "model-alpha", "test-provider", 1000, 900, 0);
  const e18 = read().ses_T18B;
  assert(e18 && e18.categories.toolOut === 100, `toolOut should persist as 100, got ${e18?.categories?.toolOut}`);
  const c = e18.categories;
  const sum = c.user + c.assistant + c.reasoning + c.toolArgs + (c.toolOut || 0) +
    (c.system || 0) + (c.toolSchemas || 0) + c.other;
  assert(sum === e18.input, `categories + other must reconcile to input (${sum} != ${e18.input})`);
});

check("T18c toolOut: legacy entry without the field normalises to 0", () => {
  const cur = read();
  cur.ses_T18C = {
    sessionID: "ses_T18C", parentID: null, role: "main", agent: null,
    model: "model-alpha", providerID: "test-provider", ctx: 100, input: 100,
    usable: 170000, limit: 200000, reasoning: 0,
    categories: { user: 1, assistant: 1, reasoning: 0, toolArgs: 1, system: null, toolSchemas: null, other: 97 },
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(HARNESS_STATE, JSON.stringify(cur), "utf8");
  mod.writeStateFile("ses_T18C", "model-alpha", "test-provider", 100, 100, 0);
  const c2 = read().ses_T18C.categories;
  assert(c2.toolOut === 0, `legacy toolOut should normalise to 0, got ${c2.toolOut}`);
  assert(c2.other === 97, `other must stay the legacy residual, got ${c2.other}`);
});

// T19 — compaction staleness marker: a session.compacted write re-persists the
// PRE-compaction snapshot, so the entry must be flagged stale until a fresh
// breakdown (bd.capturedAt newer than the compaction) lands.
const busyWait = (ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) {} };

check("T19 compacted mark: stale until a fresh measurement lands", () => {
  const ctx = (txt) => ({
    sessionID: "ses_T19",
    messages: [{ role: "user", content: [{ type: "text", text: txt }] }],
    system: [],
    tools: {},
  });
  // Initial fresh measurement.
  mod.onV2Context(ctx("hello"));
  mod.writeStateFile("ses_T19", "model-alpha", "test-provider", 500, 500, 0);
  assert(read().ses_T19.compactStale === false, "fresh write is not stale");

  // Compaction write re-persists the stale snapshot -> flagged stale.
  busyWait(5);
  mod.writeStateFile("ses_T19", "model-alpha", "test-provider", 500, 500, 0, { compacted: true });
  const afterCompact = read().ses_T19;
  assert(afterCompact.compactStale === true, "compaction write must flag stale");
  assert(typeof afterCompact.compactedAt === "string", "compactedAt is stamped");

  // A later write from an instance WITHOUT a fresh breakdown keeps the mark.
  mod.writeStateFile("ses_T19", "model-alpha", "test-provider", 500, 500, 0);
  assert(read().ses_T19.compactStale === true, "non-measuring write keeps the mark");

  // A fresh context hook + write clears it.
  busyWait(5);
  mod.onV2Context(ctx("hello again"));
  busyWait(5);
  mod.writeStateFile("ses_T19", "model-alpha", "test-provider", 480, 480, 0);
  assert(read().ses_T19.compactStale === false, "fresh measurement clears the mark");
});

check("T19b compacted mark: stale even without a live breakdown (cross-instance)", () => {
  // A mirror instance with NO bd still re-persists pre-compaction numbers on
  // session.compacted — it must flag stale unconditionally (not fall back to a
  // missing prev verdict). ses_T19B never measured, so its bd is undefined.
  mod.writeStateFile("ses_T19B", "model-alpha", "test-provider", 300, 300, 0, { compacted: true });
  assert(read().ses_T19B.compactStale === true, "compaction write flags stale with no bd");
  // A later non-measuring write (still no bd) keeps the inherited mark.
  mod.writeStateFile("ses_T19B", "model-alpha", "test-provider", 300, 300, 0);
  assert(read().ses_T19B.compactStale === true, "no-bd non-measuring write keeps the mark");
});

const staleReport = await mod.collectSessionReport(mockCtx, "ses_T19B", read(), 0);
check("T19a stale flag reaches the report", () => {
  assert(staleReport.compactStale === true, JSON.stringify(staleReport.compactStale));
});

check("T20 toolOutByTool: hook estimator splits results per tool", () => {
  const parts = mod.estimateBreakdownFromContext({
    sessionID: "ses_T20",
    messages: [
      { role: "user", content: [
        { type: "tool-result", name: "webfetch", result: { type: "text", value: "w".repeat(40) } },
        { type: "tool-result", name: "read", result: { type: "text", value: "r".repeat(20) } },
        { type: "tool-result", name: "webfetch", result: { type: "text", value: "x".repeat(40) } },
      ]},
    ],
    system: [],
    tools: {},
  }, "ses_T20");
  assert(parts.toolOutChars === 25, `total toolOut 25, got ${parts.toolOutChars}`);
  assert(parts.toolOutByTool.webfetch === 20, `webfetch aggregates 20, got ${parts.toolOutByTool.webfetch}`);
  assert(parts.toolOutByTool.read === 5, `read 5, got ${parts.toolOutByTool.read}`);
});

check("T20a toolOutByTool: fallback splits persisted tool parts by name", () => {
  const parts = mod.estimateBreakdownFromClientMessages([
    { type: "assistant", content: [
      { type: "tool", name: "bash", state: { status: "completed", input: { cmd: "x" }, content: [{ type: "text", text: "o".repeat(40) }] } },
    ]},
  ]);
  assert(parts.toolOutByTool.bash === 10, `bash 40 chars -> 10 tokens, got ${parts.toolOutByTool.bash}`);
});

check("T20b toolOutByTool: sanitised + bounded (proto dropped, overflow bucketed)", () => {
  const dirty = JSON.parse('{"__proto__":5,"webfetch":10,"constructor":7,"read":4}');
  const cleanMap = mod.safeToolOutByTool(dirty);
  assert(cleanMap && cleanMap.webfetch === 10 && cleanMap.read === 4, "safe names kept");
  assert(!Object.prototype.hasOwnProperty.call(cleanMap, "__proto__"), "proto key dropped from own keys");
  assert(cleanMap["other tools"] === 12, `unsafe names folded into other tools, got ${cleanMap["other tools"]}`);
  // Bounding: 30 distinct safe names -> 24 kept + "other tools".
  const many = {};
  for (let i = 0; i < 30; i++) many[`t${i}`] = 1;
  const bounded = mod.safeToolOutByTool(many);
  assert(Object.keys(bounded).length === 25, `24 + overflow bucket, got ${Object.keys(bounded).length}`);
  assert(bounded["other tools"] === 6, "overflow summed into the bucket");
});

mod.onV2Context({
  sessionID: "ses_T20C",
  messages: [{ role: "user", content: [
    { type: "tool-result", name: "webfetch", result: { type: "text", value: "w".repeat(400) } },
    { type: "tool-result", name: "read", result: { type: "text", value: "r".repeat(40) } },
  ]}],
  system: [],
  tools: {},
});
mod.writeStateFile("ses_T20C", "model-alpha", "test-provider", 1000, 1000, 0);
// The Desktop RPC (and therefore the panel) reads the report, not state.json.
// Past deadline -> state.json only, no live RPC.
const t20cReport = await mod.collectSessionReport(mockCtx, "ses_T20C", read(), 0);
check("T20c toolOutByTool: persisted end-to-end and carried into the report", () => {
  const e = read().ses_T20C;
  assert(e.toolOutByTool && e.toolOutByTool.webfetch === 100, `webfetch 100 persisted, got ${e.toolOutByTool?.webfetch}`);
  assert(e.toolOutByTool.read === 10, "read 10 persisted");
  assert(t20cReport.toolOutByTool && t20cReport.toolOutByTool.webfetch === 100, "report carries the per-tool split");
  assert(t20cReport.toolOutByTool.read === 10, "report carries read too");
});

check("T21 shared category helpers: sum + residual (both record shapes)", () => {
  // nulls (hook-only system/schemas) count as 0; non-objects -> 0.
  assert(
    mod.sumCategories({ user: 10, assistant: 5, system: null, toolSchemas: null, other: 2 }) === 17,
    "sumCategories skips nulls",
  );
  assert(mod.sumCategories(null) === 0 && mod.sumCategories("x") === 0, "sumCategories(non-object) -> 0");
  // *Chars (cache record) and canonical (state entry) shapes normalise identically.
  const fromChars = mod.breakdownCategories(
    { userChars: 100, assistantChars: 40, toolOutChars: 10, systemChars: null },
    500,
  );
  const fromCanon = mod.breakdownCategories(
    { user: 100, assistant: 40, toolOut: 10, system: null },
    500,
  );
  assert(JSON.stringify(fromChars) === JSON.stringify(fromCanon), "both record shapes normalise identically");
  assert(fromChars.other === 350, `residual = 500 - 150, got ${fromChars.other}`);
  assert(mod.breakdownCategories({ user: 999 }, 10).other === 0, "residual clamps at 0");
});

check("T22 sanitizers + unicode densities (safeCell / isSafeSessionKey / estimateTokens)", () => {
  // safeCell: pipes escaped, backtick neutralised, controls/zero-width collapsed.
  assert(mod.safeCell("a|b") === "a\\|b", `pipe escaped, got ${JSON.stringify(mod.safeCell("a|b"))}`);
  assert(mod.safeCell("a\\b") === "a\\\\b", "backslash doubled");
  assert(mod.safeCell("x`y") === "x'y", "backtick neutralised");
  assert(!/[\u0000-\u001f]/.test(mod.safeCell("a\tb\nc")), "controls collapsed");
  assert(mod.safeCell("\u200bhi") === "hi", "zero-width dropped");
  // Truncation is code-point safe and happens BEFORE escaping: 200 source
  // codepoints -> 63 retained + ellipsis = exactly 64 (no escapes here).
  const capped = mod.safeCell("z".repeat(200));
  assert(capped.length === 64 && capped.endsWith("\u2026"), `cap = 64 chars + ellipsis, got ${capped.length}`);
  // Escape ORDER: `\` first, then `|` — a crafted `a\|b` must not leave a live pipe.
  assert(
    mod.safeCell("a\\|b") === "a" + "\\".repeat(3) + "|" + "b",
    `backslash escaped before pipe, got ${JSON.stringify(mod.safeCell("a\\|b"))}`,
  );
  // isSafeSessionKey: prototype vectors rejected, normal ids accepted.
  assert(
    !mod.isSafeSessionKey("__proto__") &&
      !mod.isSafeSessionKey("constructor") &&
      !mod.isSafeSessionKey("prototype"),
    "prototype vectors rejected",
  );
  assert(!mod.isSafeSessionKey("") && !mod.isSafeSessionKey(42), "empty/non-string rejected");
  assert(mod.isSafeSessionKey("ses_abc"), "normal id accepted");
  // estimateTokens densities: latin /4, cyrillic /2.5, CJK /1.5.
  assert(mod.estimateTokens("a".repeat(40)) === 10, "latin 40 -> 10");
  assert(mod.estimateTokens("\u0430".repeat(25)) === 10, "cyrillic 25 -> 10");
  assert(mod.estimateTokens("\u4e2d".repeat(15)) === 10, "CJK 15 -> 10");
  assert(mod.estimateTokens("") === 0 && mod.estimateTokens(null) === 0, "empty/null -> 0");
});

// T23 — provider-reported prompt cache (EXACT; a subset of input, never a
// category, inherited by mirror writes so a non-measuring write cannot drop it).
check("T23 prompt cache: persisted, inherited, never a category", () => {
  mod.writeStateFile("ses_T23", "model-alpha", "test-provider", 1000, 1000, 0, { cacheRead: 600, cacheWrite: 200 });
  const e = read().ses_T23;
  assert(e.cacheRead === 600 && e.cacheWrite === 200, `cache persisted, got ${e.cacheRead}/${e.cacheWrite}`);
  // A later mirror write without fresh figures must NOT drop them.
  mod.writeStateFile("ses_T23", "model-alpha", "test-provider", 1000, 1000, 0);
  assert(read().ses_T23.cacheRead === 600, "cache inherited by a non-measuring write");
  // A session that never reported cache stays null (not a misleading 0).
  mod.writeStateFile("ses_T23N", "model-alpha", "test-provider", 100, 100, 0);
  assert(read().ses_T23N.cacheRead === null && read().ses_T23N.cacheWrite === null, "absent cache -> null");
  // Cache is a SUBSET of input: it must not enter the category sum.
  const c = read().ses_T23.categories;
  const sum = c.user + c.assistant + c.reasoning + c.toolArgs + (c.toolOut || 0) + (c.system || 0) + (c.toolSchemas || 0) + c.other;
  assert(sum === read().ses_T23.input, `cache must not enter the category sum (${sum})`);
});

const repT23 = await mod.collectSessionReport(mockCtx, "ses_T23", read(), Date.now() + 2000);
check("T23a prompt cache: surfaced in the report", () => {
  assert(mod.lastKnownCacheRead("ses_none") === null, "accessor -> null when unknown");
  assert(repT23.cacheRead === 600 && repT23.cacheWrite === 200, `report carries cache, got ${repT23.cacheRead}/${repT23.cacheWrite}`);
});

check("T23b prompt cache: non-finite / absurd provider values are dropped", () => {
  assert(mod.safeSaneOrNull(600) === 600 && mod.safeSaneOrNull(0) === 0, "valid kept");
  assert(
    mod.safeSaneOrNull(NaN) === null && mod.safeSaneOrNull(-1) === null && mod.safeSaneOrNull(1e15) === null,
    "NaN/negative/absurd -> null",
  );
  mod.writeStateFile("ses_T23S", "model-alpha", "test-provider", 100, 100, 0, { cacheRead: NaN, cacheWrite: -5 });
  assert(read().ses_T23S.cacheRead === null && read().ses_T23S.cacheWrite === null, "poisoned cache -> null");
});

// T24 — waste detector: redundant tool output already in context (repeated
// target / identical output). Persisted PATH-FREE; surfaced in the breakdown.
check("T24 computeReclaim: repeated target / identical content / union", () => {
  const byTarget = mod.computeReclaim([
    { name: "read", target: "a.ts", tokens: 100, fp: "p1" },
    { name: "read", target: "a.ts", tokens: 40, fp: "p2" },
  ]);
  assert(byTarget.tokens === 40 && byTarget.count === 1, `keep largest, reclaim the rest: ${JSON.stringify(byTarget)}`);
  const byContent = mod.computeReclaim([
    { name: "bash", target: "cmd1", tokens: 50, fp: "same" },
    { name: "bash", target: "cmd2", tokens: 30, fp: "same" },
  ]);
  assert(byContent.tokens === 30 && byContent.count === 1, `identical output detected: ${JSON.stringify(byContent)}`);
  const union = mod.computeReclaim([
    { name: "read", target: "a.ts", tokens: 100, fp: "same" },
    { name: "read", target: "a.ts", tokens: 60, fp: "same" },
    { name: "read", target: "a.ts", tokens: 20, fp: "same" },
  ]);
  assert(union.tokens === 80 && union.count === 2, `union not double-counted: ${JSON.stringify(union)}`);
  assert(
    union.findings.reduce((a, f) => a + f.tokens, 0) === union.tokens,
    `findings must never sum above the total: ${JSON.stringify(union.findings)}`,
  );
  assert(mod.computeReclaim([{ name: "read", target: "a.ts", tokens: 10, fp: "x" }]).tokens === 0, "single instance -> 0");
  assert(mod.computeReclaim(null).tokens === 0, "null-safe");
});

check("T24a extractToolTarget + contentFingerprint", () => {
  assert(mod.extractToolTarget("read", { filePath: "src/a.ts" }) === "src/a.ts", "read filePath");
  assert(mod.extractToolTarget("webfetch", { url: "https://x/y" }) === "https://x/y", "webfetch url");
  assert(mod.extractToolTarget("bash", { command: "ls   -la" }) === "ls -la", "bash command collapsed");
  assert(mod.extractToolTarget("mystery", { foo: "first", bar: "second" }) === "first", "generic first string");
  assert(mod.extractToolTarget("read", null) === null && mod.extractToolTarget("read", {}) === null, "non-object/empty -> null");
  assert(mod.contentFingerprint("x".repeat(400)) === mod.contentFingerprint("x".repeat(400)), "same content -> same fp");
  assert(mod.contentFingerprint("a") !== mod.contentFingerprint("b"), "different content -> different fp");
  assert(mod.contentFingerprint("") === "", "empty -> empty fp");
});

check("T24b hook estimator: repeated tool result via call-id correlation", () => {
  const parts = mod.estimateBreakdownFromContext({
    sessionID: "ses_T24",
    messages: [
      { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: { filePath: "a.ts" } }] },
      { role: "user", content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "r".repeat(400) } }] },
      { role: "assistant", content: [{ type: "tool-call", id: "c2", name: "read", input: { filePath: "a.ts" } }] },
      { role: "user", content: [{ type: "tool-result", id: "c2", name: "read", result: { type: "text", value: "r".repeat(400) } }] },
    ],
    system: [],
    tools: {},
  }, "ses_T24");
  // 400 latin chars -> 100 tokens each; identical target+content -> reclaim 100.
  assert(parts.toolOutChars === 200, `toolOut total 200, got ${parts.toolOutChars}`);
  assert(parts.reclaim && parts.reclaim.tokens === 100 && parts.reclaim.count === 1, `reclaim 100/1, got ${JSON.stringify(parts.reclaim)}`);
});

mod.onV2Context({
  sessionID: "ses_T24C",
  messages: [
    { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "read", input: { filePath: "secret/path.ts" } }] },
    { role: "user", content: [{ type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "r".repeat(400) } }] },
    { role: "assistant", content: [{ type: "tool-call", id: "c2", name: "read", input: { filePath: "secret/path.ts" } }] },
    { role: "user", content: [{ type: "tool-result", id: "c2", name: "read", result: { type: "text", value: "r".repeat(400) } }] },
  ],
  system: [],
  tools: {},
});
mod.writeStateFile("ses_T24C", "model-alpha", "test-provider", 1000, 1000, 0);
const t24cReport = await mod.collectSessionReport(mockCtx, "ses_T24C", read(), 0);
check("T24c waste persisted path-free and carried into the report", () => {
  const e = read().ses_T24C;
  assert(e.reclaim && e.reclaim.tokens === 100, `reclaim persisted, got ${JSON.stringify(e.reclaim)}`);
  const findings = e.reclaim.findings || [];
  assert(findings.length >= 1, "at least one finding");
  for (const f of findings) {
    assert(!Object.prototype.hasOwnProperty.call(f, "target"), "persisted findings are path-free (no target)");
  }
  // The Desktop RPC reads the report: the reclaim total must survive the trip.
  assert(t24cReport.reclaim && t24cReport.reclaim.tokens === 100, `report reclaim, got ${JSON.stringify(t24cReport.reclaim)}`);
  assert(t24cReport.reclaim.count === e.reclaim.count, "report reclaim count matches the snapshot");
});

// T25 — compaction HOOK: the EXACT pre-compaction snapshot is persisted (and
// flagged stale) the moment opencode dispatches the compaction request, instead
// of relying on the trailing session.compacted event to re-persist whatever a
// previous request left behind.
const t25Err = quietErr(() => {
  mod.lastKnownCtxCache.set("ses_T25", 8000);
  mod.lastKnownInputCache.set("ses_T25", 8000);
  mod.lastKnownReasoningCache.set("ses_T25", 0);
  // A prior (smaller) context-hook measurement must NOT win over the hook.
  mod.onV2Context({
    sessionID: "ses_T25",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: [],
    tools: {},
  });
  mod.writeStateFile("ses_T25", "model-alpha", "test-provider", 8000, 8000, 0);
  // The compaction request carries the FULL pre-compaction history.
  mod.onV2Compaction({
    sessionID: "ses_T25",
    messages: [
      { role: "user", content: [{ type: "text", text: "u".repeat(400) }] },
      { role: "assistant", content: [{ type: "text", text: "a".repeat(400) }] },
    ],
    system: [],
    tools: {},
    model: { id: "model-alpha", providerID: "test-provider" },
  });
});
const t25 = read().ses_T25;
check("T25 compaction hook: exact pre-compaction snapshot + stale mark", () => {
  assert(t25Err.length === 0, `no errors: ${t25Err.join(" | ")}`);
  // 400 latin chars -> 100 tokens each; the hook payload owns the snapshot.
  assert(t25.categories.user === 100 && t25.categories.assistant === 100, `hook payload owns the snapshot: ${JSON.stringify(t25.categories)}`);
  assert(t25.compactStale === true, "compaction hook flags the entry stale");
  assert(typeof t25.compactedAt === "string", "compactedAt is stamped by the hook");
});

// T25a — a NO-OP compaction ("Nothing to compact yet", no measured context) must
// not fake a stale badge.
const t25aErr = quietErr(() => {
  mod.lastKnownCtxCache.delete("ses_T25N");
  mod.onV2Compaction({
    sessionID: "ses_T25N",
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    system: [],
    tools: {},
  });
});
check("T25a compaction hook: no-op (no measured context) writes no stale entry", () => {
  assert(t25aErr.length === 0, `no errors: ${t25aErr.join(" | ")}`);
  assert(!read().ses_T25N, "no state entry written for a no-op compaction");
});

// T25b — the session.compacted event is a FALLBACK: skipped when the hook
// already handled the write, and still marks stale when it did not.
mod.lastKnownCtxCache.set("ses_T25C", 5000);
mod.lastKnownInputCache.set("ses_T25C", 5000);
mod.writeStateFile("ses_T25C", "model-alpha", "test-provider", 5000, 5000, 0);
mod.onV2Compaction({
  sessionID: "ses_T25C",
  messages: [
    { role: "user", content: [{ type: "text", text: "u".repeat(40) }] },
    { role: "assistant", content: [{ type: "text", text: "a".repeat(40) }] },
  ],
  system: [], tools: {}, model: { id: "model-alpha", providerID: "test-provider" },
});
const afterHookAt25 = read().ses_T25C.updatedAt;
busyWait(5);
await mod.handleV2Event(mockCtx, { type: "session.compacted", id: "evt25c", data: { sessionID: "ses_T25C" } });
const skipped25 = read().ses_T25C.updatedAt === afterHookAt25;
mod.lastKnownCtxCache.set("ses_T25D", 5000);
mod.lastKnownInputCache.set("ses_T25D", 5000);
mod.writeStateFile("ses_T25D", "model-alpha", "test-provider", 5000, 5000, 0);
const beforeEvent25 = read().ses_T25D.updatedAt;
busyWait(5);
await mod.handleV2Event(mockCtx, { type: "session.compacted", id: "evt25d", data: { sessionID: "ses_T25D" } });
const fallback25 = read().ses_T25D;
check("T25b session.compacted event: skipped after the hook, fallback otherwise", () => {
  assert(skipped25, "event did not rewrite the entry the hook just handled");
  assert(fallback25.compactStale === true && fallback25.updatedAt !== beforeEvent25, "event fallback writes + flags stale");
});

// T25c — the guard also protects a HEALTHY entry: a hook firing with a COLD
// last-known cache (mirror instance / just after idle) must not zero ctx.
mod.writeStateFile("ses_T25E", "model-alpha", "test-provider", 5000, 5000, 0);
mod.lastKnownCtxCache.delete("ses_T25E");
mod.lastKnownInputCache.delete("ses_T25E");
const t25cErr = quietErr(() => mod.onV2Compaction({
  sessionID: "ses_T25E",
  messages: [
    { role: "user", content: [{ type: "text", text: "u".repeat(40) }] },
    { role: "assistant", content: [{ type: "text", text: "a".repeat(40) }] },
  ],
  system: [], tools: {}, model: { id: "model-alpha", providerID: "test-provider" },
}));
const t25c = read().ses_T25E;
// The hook armed nothing (it wrote nothing), so the trailing event MUST be the
// fallback: without this, a cold-cache hook made a compaction leave no trace at
// all ("after compaction nothing happens").
await mod.handleV2Event(mockCtx, {
  type: "session.compacted",
  id: "evt25e",
  data: { sessionID: "ses_T25E" },
});
const t25cAfterEvent = read().ses_T25E;
check("T25c compaction hook: cold last-known cache does not clobber ctx (no write)", () => {
  assert(t25cErr.length === 0, `no errors: ${t25cErr.join(" | ")}`);
  assert(t25c.ctx === 5000, `ctx preserved, got ${t25c.ctx}`);
  assert(t25c.compactStale === false && !t25c.compactedAt, "no stale mark when nothing was measured");
  assert(
    t25cAfterEvent.compactStale === true && !!t25cAfterEvent.compactedAt,
    "the trailing session.compacted event must still mark the entry stale",
  );
});

// T25d — the arming guard itself: the compaction hook fires on EVERY instance
// but its state write can legitimately FAIL (another instance holds the state
// lock, an unsafe key, a failed rename). In that case the hook persisted
// nothing, so the trailing `session.compacted` event must still do the fallback
// write. Simulated by holding the state lock across the hook call — the only
// way to make writeStateFile return false while ctxTokens > 0.
mod.writeStateFile("ses_T25F", "model-alpha", "test-provider", 4000, 4000, 0);
// The compaction hook reads the LAST-KNOWN counters, not state.json: seed them,
// otherwise `ctxTokens === 0` skips the whole write block and the guard under
// test is never reached (the test would then pass for the wrong reason).
mod.lastKnownCtxCache.set("ses_T25F", 4000);
mod.lastKnownInputCache.set("ses_T25F", 4000);
const t25dLockFile = `${HARNESS_STATE}.lock`;
writeFileSync(t25dLockFile, "held-by-peer", "utf8");
const t25dErr = quietErr(() => mod.onV2Compaction({
  sessionID: "ses_T25F",
  messages: [
    { role: "user", content: [{ type: "text", text: "u".repeat(60) }] },
    { role: "assistant", content: [{ type: "text", text: "a".repeat(60) }] },
  ],
  system: [], tools: {}, model: { id: "model-alpha", providerID: "test-provider" },
}));
const t25dBlocked = read().ses_T25F;
try { unlinkSync(t25dLockFile); } catch { /* already gone */ }
await mod.handleV2Event(mockCtx, {
  type: "session.compacted",
  id: "evt25f",
  data: { sessionID: "ses_T25F" },
});
const t25dAfterEvent = read().ses_T25F;
check("T25d compaction hook that could not persist does not arm the guard", () => {
  // The busy lock is EXPECTED (that is the whole point) - the write path logs it.
  // Anything else captured here means an unexpected failure path.
  assert(
    t25dErr.every((m) => m.includes("lock busy")),
    `only the busy-lock message is expected: ${t25dErr.join(" | ")}`,
  );
  assert(
    t25dErr.length > 0,
    "the state write was expected to be refused (lock held by a peer)",
  );
  assert(
    t25dBlocked.ctx === 4000 && t25dBlocked.compactStale === false,
    `busy lock: entry untouched, got ctx=${t25dBlocked.ctx} stale=${t25dBlocked.compactStale}`,
  );
  assert(
    t25dAfterEvent.compactStale === true && !!t25dAfterEvent.compactedAt,
    "the event fallback must still record the compaction (no silent no-op)",
  );
});

// ---- T26-T28: compaction reserve, /context-diff ----

const cacheMod = await import(pathToFileURL(join(repoRoot, "lib", "cache.js")).href);

check("T26 reserve mirrors core v2 calculateCeiling (15% share, 16k floor, 32k gate)", () => {
  const cases = [
    [200000, 30000], // 15% share wins
    [524288, 78643],
    [1048576, 157286],
    [100000, 16000], // 15% = 15000 < floor
    [32000, 16000], // 2 * RESERVE_MIN gate: floor applies exactly here
    [160000, 24000], // above the gate: 15% share beats the floor
    [31999, 4799], // one below the gate: share only, no floor
    [1000, 150], // tiny window: share only
    [1, 0],
  ];
  for (const [win, want] of cases) {
    const got = mod.reserveFor(win, undefined);
    assert(got === want, `window=${win}: reserve ${got} !== ${want}`);
  }
});

// T28 — /context-diff: previous distinct measurement, inherited on repeats.
cacheMod.breakdownCache.delete("ses_DIFF");
quietErr(() => mod.writeStateFile("ses_DIFF", "model-gamma", "test-provider", 1000, 1000, 0));
const t28First = read().ses_DIFF;
cacheMod.breakdownCache.set("ses_DIFF", {
  ...mod.estimateBreakdownFromContext({
    messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(4000) }] }],
    system: [],
    tools: {},
  }, null),
  capturedAt: Date.now(),
  source: "context-hook",
});
quietErr(() => mod.writeStateFile("ses_DIFF", "model-gamma", "test-provider", 2000, 2000, 0));
const t28Second = read().ses_DIFF;
check("T28 diff: previous holds the replaced measurement; repeat writes inherit it", () => {
  assert(t28First.previous == null, "first measurement has no previous");
  assert(t28Second.previous && t28Second.previous.ctx === 1000, JSON.stringify(t28Second.previous));
  assert(t28Second.previous.categories.user === 0);
  quietErr(() => mod.writeStateFile("ses_DIFF", "model-gamma", "test-provider", 2000, 2000, 0));
  assert(
    JSON.stringify(read().ses_DIFF.previous) === JSON.stringify(t28Second.previous),
    "an unchanged repeat write must not shift `previous`",
  );
});

const t28Report = await mod.collectSessionReport(mockCtx, "ses_DIFF", read(), 0);
const t28Diff = mod.renderContextDiff(t28Report);
check("T28a diff: renders total + category deltas", () => {
  assert(t28Diff.includes("total 1.0k -> 2.0k"), t28Diff);
  assert(t28Diff.includes("(+1.0k tokens, +100%)"), t28Diff);
  assert(t28Diff.includes("| user | 0 | 1.0k | +1.0k |"), t28Diff);
  assert(t28Diff.includes("previous "), t28Diff);
});

check("T28f diff: a model switch shows the window change only", () => {
  const now = new Date().toISOString();
  const diff = mod.renderContextDiff({
    modelID: "model-delta",
    providerID: "test-provider",
    ctxTokens: 3000,
    usable: 10000,
    categories: { user: 100, assistant: 200 },
    updatedAt: now,
    previous: {
      model: "model-gamma",
      ctx: 1000,
      input: 1000,
      categories: { user: 10, assistant: 20 },
      updatedAt: now,
    },
  });
  assert(diff.includes("model model-gamma -> model-delta"), diff);
  assert(diff.includes("not comparable across models"), diff);
  assert(!diff.includes("| user |"), "cross-model category rows must be omitted");
  assert(diff.includes("total 1.0k -> 3.0k"), diff);
});

cacheMod.breakdownCache.delete("ses_DIFF_FRESH");
quietErr(() => mod.writeStateFile("ses_DIFF_FRESH", "model-gamma", "test-provider", 500, 500, 0));
const t28FreshReport = await mod.collectSessionReport(mockCtx, "ses_DIFF_FRESH", read(), 0);
check("T28b diff: no previous measurement is reported honestly", () => {
  const diff = mod.renderContextDiff(t28FreshReport);
  assert(diff.includes("No previous measurement yet"), diff);
});

// T28c — a mirror/idle write with no token figure (all lastKnown* caches empty
// in THIS instance) must inherit the previous same-model numbers and must not
// rotate the diff baseline.
cacheMod.breakdownCache.delete("ses_DIFF");
quietErr(() => mod.writeStateFile("ses_DIFF", "model-gamma", "test-provider", 0, 0, 0));
const t28Unmeasured = read().ses_DIFF;
check("T28c unmeasured write keeps ctx/input and the previous baseline", () => {
  assert(t28Unmeasured.ctx === 2000, `ctx preserved, got ${t28Unmeasured.ctx}`);
  assert(t28Unmeasured.input === 2000, `input preserved, got ${t28Unmeasured.input}`);
  assert(
    JSON.stringify(t28Unmeasured.previous) === JSON.stringify(t28Second.previous),
    "previous must not rotate on an unmeasured write",
  );
});

// T28e — the same on an instance that does not even know the model (caches
// cleared after idle): an unknown model must not overwrite the known identity
// or drop the counters.
quietErr(() => mod.writeStateFile("ses_DIFF", "unknown", "", 0, 0, 0));
const t28Unknown = read().ses_DIFF;
check("T28e unmeasured unknown-model write keeps identity + counters", () => {
  assert(t28Unknown.model === "model-gamma", `model preserved, got ${t28Unknown.model}`);
  assert(t28Unknown.providerID === "test-provider", `provider preserved, got ${t28Unknown.providerID}`);
  assert(t28Unknown.ctx === 2000 && t28Unknown.input === 2000);
  assert(
    JSON.stringify(t28Unknown.previous) === JSON.stringify(t28Second.previous),
    "previous must not rotate when the model is unknown",
  );
});

check("T28d diff: a null category renders n/a, not a fake gain", () => {
  const diff = mod.renderContextDiff({
    modelID: "m",
    ctxTokens: 100,
    inputTokens: 100,
    usable: null,
    updatedAt: "2026-10-08T14:30:00.000Z",
    categories: {
      user: 10, assistant: 0, reasoning: 0, toolArgs: 0,
      toolOut: 0, system: 5, toolSchemas: null, other: 0,
    },
    previous: {
      model: "m",
      ctx: 50,
      input: 50,
      updatedAt: null,
      categories: {
        user: 10, assistant: 0, reasoning: 0, toolArgs: 0,
        toolOut: 0, system: null, toolSchemas: null, other: 0,
      },
    },
  });
  assert(diff.includes("| system | n/a | 5 | n/a |"), diff);
});

// T29 — a finishing subagent must not disappear from the parent's live roll-up
// (regression: session.idle wiped sessionParentCache/sessionTotals for the
// child, so every idle child dropped the parent's "subagents N session(s)" to
// zero until the parent's own idle swept the set).
const t29Ctx = {
  session: {
    get: async () => null,
    context: async () => null,
  },
};
// handleV2Event's lifecycle branches (created / step.ended / idle) run fully
// synchronously before their first await, so the assertions can stay sync.
check("T29 subagent roll-up survives a child idle, swept by the parent idle", () => {
  const { sessionParentCache, sessionTotals } = cacheMod;
  sessionParentCache.delete("ses_KID");
  sessionParentCache.delete("ses_ROOTKID");
  sessionTotals.delete("ses_KID");

  void mod.handleV2Event(t29Ctx, { type: "session.created", data: { sessionID: "ses_ROOTKID" } });
  void mod.handleV2Event(t29Ctx, {
    type: "session.created",
    data: { sessionID: "ses_KID", parentID: "ses_ROOTKID" },
  });
  void mod.handleV2Event(t29Ctx, {
    type: "session.step.ended",
    data: { sessionID: "ses_KID", tokens: { input: 300, output: 20, reasoning: 5 } },
  });
  assert(sessionTotals.get("ses_KID")?.input === 300, "child totals accumulated");

  void mod.handleV2Event(t29Ctx, { type: "session.idle", data: { sessionID: "ses_KID" } });
  assert(
    sessionParentCache.get("ses_KID") === "ses_ROOTKID",
    "child attribution survives the child's own idle",
  );
  assert(sessionTotals.get("ses_KID")?.input === 300, "child totals survive the child's own idle");
  assert(!mod.lastKnownInputCache.has("ses_KID"), "per-session last-known caches are still wiped");

  // Grand-child: only a recursive sweep can collect it once the child is gone.
  void mod.handleV2Event(t29Ctx, {
    type: "session.created",
    data: { sessionID: "ses_GRANDKID", parentID: "ses_KID" },
  });
  void mod.handleV2Event(t29Ctx, { type: "session.deleted", data: { sessionID: "ses_KID" } });
  assert(!sessionParentCache.has("ses_GRANDKID"), "deleting a child sweeps its sub-subagents");
  assert(!sessionParentCache.has("ses_KID"), "the deleted child is gone");

  // Re-seed a child + grandchild for the parent-idle sweep.
  void mod.handleV2Event(t29Ctx, {
    type: "session.created",
    data: { sessionID: "ses_KID2", parentID: "ses_ROOTKID" },
  });
  void mod.handleV2Event(t29Ctx, {
    type: "session.created",
    data: { sessionID: "ses_GRANDKID2", parentID: "ses_KID2" },
  });
  void mod.handleV2Event(t29Ctx, { type: "session.idle", data: { sessionID: "ses_ROOTKID" } });
  assert(!sessionParentCache.has("ses_KID2"), "parent idle sweeps the child attribution");
  assert(!sessionTotals.has("ses_KID2"), "parent idle sweeps the child totals");
  assert(!sessionParentCache.has("ses_GRANDKID2"), "parent idle sweeps grandchildren too");
});

// T30 - the Desktop RPC wire row must match on all three sides: the JSON Schema
// the GUI validates against (lib/rpc.js), the key list that schema exports, and
// the object the server builds (lib/desktop.js toDesktopRow). This check owns a
// LITERAL key list on purpose: comparing the schema with DESKTOP_ROW_KEYS alone
// would be a tautology (both come from the same object), and a field added only
// to the schema or only to the builder would silently arrive as undefined in
// the panel.
const DESKTOP_ROW_KEYS_EXPECTED = [
  "agent", "assistant", "ctx", "input", "modelID", "other", "parentID",
  "providerID", "reasoning", "reserve", "sessionID", "source", "stale",
  "system", "toolArgs", "toolOut", "toolSchemas", "updatedAt", "usable", "user",
].sort();
const rpcMod = await import(pathToFileURL(join(repoRoot, "lib", "rpc.js")).href);
check("T30 desktop RPC row schema matches the server row builder", () => {
  const schema =
    rpcMod.DesktopContextRpc.methods.family.output.properties.rows.items;
  const schemaKeys = Object.keys(schema.properties).sort();
  assert(
    schemaKeys.join(",") === DESKTOP_ROW_KEYS_EXPECTED.join(","),
    `schema keys drifted: ${schemaKeys.join(",")} vs expected ${DESKTOP_ROW_KEYS_EXPECTED.join(",")}`,
  );
  assert(
    [...rpcMod.DESKTOP_ROW_KEYS].sort().join(",") === schemaKeys.join(","),
    "DESKTOP_ROW_KEYS must list exactly the schema properties",
  );
  assert(
    schema.required.slice().sort().join(",") === schemaKeys.join(","),
    "every row property must be required",
  );
  const row = mod.toDesktopRow({
    sessionID: "ses_DESKTOP",
    parentID: null,
    agent: null,
    modelID: "model-alpha",
    providerID: "test-provider",
    ctxTokens: 10,
    inputTokens: 9,
    usable: null,
    reserve: null,
    categories: { user: 3 },
    source: "snapshot",
    updatedAt: null,
    compactStale: undefined,
  });
  assert(
    Object.keys(row).sort().join(",") === schemaKeys.join(","),
    `builder/schema key mismatch: ${Object.keys(row).sort().join(",")}`,
  );
  assert(row.parentID === "" && row.agent === "", "absent ids flatten to empty strings");
  assert(row.usable === 0 && row.reserve === 0, "unknown windows flatten to 0");
  assert(row.assistant === 0 && row.other === 0, "absent categories flatten to 0");
  assert(row.updatedAt === "" && row.stale === false, "absent time / stale flag flatten");
  assert(row.user === 3 && row.ctx === 10, "present values survive");
});

// T31 - the Desktop data path registers and answers. This is the wiring the GUI
// depends on: registerDesktopRpc -> collectFamilyReports -> toDesktopRow. The
// host itself cannot be exercised here, so the check drives the handler with a
// fake plugin context and a seeded state file (the harness's isolated one).
const t31Seed = { ...mod.readStateSnapshot() };
const t31Entry = (id, parentID, ctxTokens, agent) => ({
  sessionID: id,
  parentID,
  role: parentID ? "sub" : "primary",
  agent,
  model: "model-alpha",
  providerID: "test-provider",
  ctx: ctxTokens,
  input: ctxTokens,
  usable: 84000,
  reserve: 16000,
  categories: {
    user: 40,
    assistant: 20,
    reasoning: 10,
    toolArgs: 5,
    toolOut: 3,
    system: 30,
    toolSchemas: 25,
    other: 1,
  },
  updatedAt: new Date().toISOString(),
});
t31Seed.ses_GUIROOT = t31Entry("ses_GUIROOT", undefined, 2000, null);
t31Seed.ses_GUIKID = t31Entry("ses_GUIKID", "ses_GUIROOT", 800, "explore");
writeFileSync(HARNESS_STATE, JSON.stringify(t31Seed));

const t31Rpc = { handlers: null, definition: null };
// Live lookups are counted so a regression back to "session.get() on every
// poll" cannot pass: the Desktop panel polls this path.
const t31Live = { get: 0, context: 0 };
await mod.registerDesktopRpc({
  rpc: {
    register: async (definition, handlers) => {
      t31Rpc.definition = definition;
      t31Rpc.handlers = handlers;
      return { dispose: async () => {} };
    },
  },
  session: {
    get: async () => {
      t31Live.get++;
      return null;
    },
    context: async () => {
      t31Live.context++;
      return null;
    },
  },
});
const t31Answer = await t31Rpc.handlers.family({ sessionID: "ses_GUIROOT" });
const t31LiveFirst = t31Live.get + t31Live.context;
const t31Poll = await t31Rpc.handlers.family({ sessionID: "ses_GUIROOT" });
const t31LiveSecond = t31Live.get + t31Live.context - t31LiveFirst;
const t31Empty = await t31Rpc.handlers.family({});
// A session this plugin has never measured must not come back as a row of
// zeros: the GUI turns an empty list into "No measurement yet".
const t31Unknown = await t31Rpc.handlers.family({ sessionID: "ses_NEVERSEEN" });
check("T31 desktop RPC registers and answers with the session family", () => {
  assert(t31Rpc.definition?.id === "context-indicator", "contract id");
  assert(typeof t31Rpc.handlers.family === "function", "family handler registered");
  assert(t31Answer.rows.length === 2, `expected 2 rows, got ${t31Answer.rows.length}`);
  const [rootRow, kidRow] = t31Answer.rows;
  assert(rootRow.sessionID === "ses_GUIROOT", "root row first");
  assert(rootRow.parentID === "", "root has no parent id");
  assert(kidRow.sessionID === "ses_GUIKID", "child row follows");
  assert(kidRow.parentID === "ses_GUIROOT", "child keeps its parent link");
  assert(kidRow.agent === "explore", "child agent survives");
  assert(rootRow.user === 40 && rootRow.system === 30, "categories survive");
  assert(rootRow.usable > 0, "usable window resolved");
  assert(t31Empty.rows.length === 0, "a missing sessionID answers with no rows");
  assert(
    t31Unknown.rows.length === 0,
    "an unmeasured session answers with no rows, not a zero row",
  );
  assert(t31Poll.rows.length === 2, "a repeated poll answers the same family");
  assert(
    t31LiveSecond === 0,
    `a poll must not re-issue live lookups (${t31LiveSecond} call(s) on the second poll)`,
  );
});

// T32 - a client-context fallback record (rebuilt from persisted messages: no
// system prompt, no tool schemas) must never shadow the hook-measured categories
// in state.json. It used to: a second plugin instance (the Desktop window's,
// which answers the RPC without ever running the request hook) showed system 0,
// tool schemas 0 and their whole mass folded into `other`. Hook data still wins.
const t32State = { ...mod.readStateSnapshot() };
t32State.ses_SNAPSHOT = {
  sessionID: "ses_SNAPSHOT",
  model: "model-alpha",
  providerID: "test-provider",
  agent: "orchestrator",
  ctx: 1000,
  input: 1000,
  usable: 84000,
  categories: {
    user: 100,
    assistant: 50,
    reasoning: 10,
    toolArgs: 20,
    toolOut: 30,
    system: 400,
    toolSchemas: 200,
    other: 190,
  },
  updatedAt: new Date().toISOString(),
};
writeFileSync(HARNESS_STATE, JSON.stringify(t32State));
const t32Ctx = { session: { get: async () => null, context: async () => null } };
mod.breakdownCache.set("ses_SNAPSHOT", {
  userChars: 200,
  assistantChars: 100,
  reasoningChars: 20,
  toolArgsChars: 40,
  toolOutChars: 60,
  toolOutByTool: {},
  systemChars: null,
  toolSchemasChars: null,
  reclaim: null,
  capturedAt: Date.now(),
  source: "client-context",
});
const t32Fallback = await mod.collectSessionReport(
  t32Ctx,
  "ses_SNAPSHOT",
  t32State,
  Date.now() + 2000,
);
mod.breakdownCache.set("ses_SNAPSHOT", {
  userChars: 200,
  assistantChars: 100,
  reasoningChars: 20,
  toolArgsChars: 40,
  toolOutChars: 60,
  toolOutByTool: {},
  systemChars: 2000,
  toolSchemasChars: 1000,
  reclaim: null,
  capturedAt: Date.now(),
  source: "context-hook",
});
const t32Hook = await mod.collectSessionReport(
  t32Ctx,
  "ses_SNAPSHOT",
  t32State,
  Date.now() + 2000,
);
mod.breakdownCache.delete("ses_SNAPSHOT");
check("T32 client-context fallback never shadows hook-measured categories", () => {
  assert(
    t32Fallback.source === "snapshot",
    `expected the snapshot source, got ${t32Fallback.source}`,
  );
  assert(
    t32Fallback.categories.system === 400 &&
      t32Fallback.categories.toolSchemas === 200,
    `system/tool schemas must come from the snapshot, got ${t32Fallback.categories.system}/${t32Fallback.categories.toolSchemas}`,
  );
  assert(
    t32Fallback.categories.other === 190,
    `other must not be inflated by the fallback, got ${t32Fallback.categories.other}`,
  );
  assert(t32Hook.source === "context-hook", `hook source, got ${t32Hook.source}`);
  assert(
    t32Hook.categories.system === 2000,
    `hook categories must still win, got ${t32Hook.categories.system}`,
  );
});

// T33 - the SHARED state file is written by several plugin instances. The
// Desktop window's instance never serves a request, so its breakdown is always
// the client-context fallback; it used to overwrite the hook-measured categories
// (two writes landed 11 ms apart in the field), which is what made the panel show
// "system 0 / tool schemas 0 / other inflated" and could blank user/assistant.
// It also cleared the post-compaction stale mark without ever measuring the new
// context. Hook data must own the entry.
{
  const t33Id = "ses_T33";
  mod.breakdownCache.set(t33Id, {
    userChars: 100,
    assistantChars: 50,
    reasoningChars: 10,
    toolArgsChars: 20,
    toolOutChars: 30,
    toolOutByTool: { read: 30 },
    systemChars: 400,
    toolSchemasChars: 200,
    reclaim: null,
    capturedAt: Date.now(),
    source: "context-hook",
  });
  mod.writeStateFile(t33Id, "model-alpha", "test-provider", 1000, 1000, 0);
  const t33Hook = read()[t33Id];
  // Same session, mirror instance: fallback captured LATER, so a capturedAt
  // comparison alone would let it win.
  mod.breakdownCache.set(t33Id, {
    userChars: 0,
    assistantChars: 0,
    reasoningChars: 5,
    toolArgsChars: 7,
    toolOutChars: 11,
    toolOutByTool: { bash: 11 },
    systemChars: null,
    toolSchemasChars: null,
    reclaim: null,
    capturedAt: Date.now() + 5000,
    source: "client-context",
  });
  mod.writeStateFile(t33Id, "model-alpha", "test-provider", 1000, 1000, 0);
  const t33AfterFallback = read()[t33Id];
  // Compaction mark, then ANOTHER fallback write: the stale badge must survive.
  mod.writeStateFile(t33Id, "model-alpha", "test-provider", 1000, 1000, 0, {
    compacted: true,
  });
  mod.writeStateFile(t33Id, "model-alpha", "test-provider", 1000, 1000, 0);
  const t33Stale = read()[t33Id];
  // A session no hook ever measured keeps the fallback numbers (better than none).
  const t33FallbackOnly = "ses_T33F";
  mod.breakdownCache.set(t33FallbackOnly, {
    userChars: 20,
    assistantChars: 10,
    reasoningChars: 0,
    toolArgsChars: 0,
    toolOutChars: 0,
    toolOutByTool: {},
    systemChars: null,
    toolSchemasChars: null,
    reclaim: null,
    capturedAt: Date.now(),
    source: "client-context",
  });
  mod.writeStateFile(t33FallbackOnly, "model-alpha", "test-provider", 500, 500, 0);
  const t33Only = read()[t33FallbackOnly];
  mod.breakdownCache.delete(t33Id);
  mod.breakdownCache.delete(t33FallbackOnly);
  check("T33 client-context write never clobbers hook categories or the stale mark", () => {
    assert(t33Hook.source === "context-hook", `hook source, got ${t33Hook.source}`);
    assert(
      t33AfterFallback.categories.user === 100 &&
        t33AfterFallback.categories.assistant === 50 &&
        t33AfterFallback.categories.system === 400 &&
        t33AfterFallback.categories.toolSchemas === 200 &&
        t33AfterFallback.categories.toolOut === 30,
      `hook categories must survive the fallback write, got ${JSON.stringify(t33AfterFallback.categories)}`,
    );
    assert(
      t33AfterFallback.categories.other === 190,
      `other must stay 1000-810=190, got ${t33AfterFallback.categories.other}`,
    );
    assert(
      t33AfterFallback.source === "context-hook",
      `source must stay context-hook, got ${t33AfterFallback.source}`,
    );
    assert(
      t33Stale.compactStale === true,
      "a fallback write must not clear the post-compaction stale mark",
    );
    assert(
      t33Only.categories.user === 20 && t33Only.source === "client-context",
      `fallback-only session keeps its own numbers, got ${JSON.stringify(t33Only.categories)}/${t33Only.source}`,
    );
  });
}

// T34 - the log file is shared but `finalSummaries` is per-process: a snapshot
// rewrite from a different instance used to drop the notes the others had just
// appended (a compaction was recorded in state.json while its COMPACTION note
// vanished from the log). The persisted section must be merged, once.
{
  const stateMod = await import(
    pathToFileURL(join(repoRoot, "lib", "state.js")).href
  );
  const logPath = join(tmpdir(), "oci-prepublish-log.log");
  const oldNote = "[2026-01-01T00:00:00.000Z] COMPACTED session=ses_T34 (auto)";
  writeFileSync(
    logPath,
    [
      "# context-breakdown.log",
      "",
      "## live snapshot",
      "stale line",
      "",
      "## final summaries",
      oldNote,
      "",
    ].join("\n"),
    "utf8",
  );
  stateMod.writeLog(["[new] live snapshot line"]);
  const afterFirst = readFileSync(logPath, "utf8");
  stateMod.writeLog(["[new] live snapshot line"]);
  const afterSecond = readFileSync(logPath, "utf8");
  check("T34 final summaries merge across instances (no wipe, no duplicates)", () => {
    assert(afterFirst.includes(oldNote), "persisted summary line was wiped");
    assert(afterFirst.includes("[new] live snapshot line"), "live snapshot not written");
    assert(
      afterSecond.split(oldNote).length - 1 === 1,
      "merged summary line is duplicated",
    );
  });
}

// T35 - the hook-vs-fallback authority rule must cover every hook-family
// source, not just the V2 context hook: the compaction hook measures the SAME
// request payload (system prompt + tool schemas), the V1 transform hooks do too,
// and a legacy entry written before `source` existed is provable by a non-null
// system / tool-schema estimate. The live log must also print the hook-measured
// state.json entry when THIS instance has no cache entry at all (or only a
// fallback one) instead of a fallback-shaped snapshot.
{
  const v2Mod = await import(pathToFileURL(join(repoRoot, "lib", "v2.js")).href);
  const estimateMod = await import(
    pathToFileURL(join(repoRoot, "lib", "estimate.js")).href
  );
  // The authority set itself: only a source that measured the assembled payload
  // may own the categories. "fallback" (V1 session.messages) and
  // "client-context" (V2) are rebuilds and must never win.
  const hookSources = [
    "context-hook",
    "compaction-hook",
    "transform",
    "system-transform",
  ];
  const nonHookSources = ["fallback", "client-context", "snapshot", null, ""];
  check("T35 isHookSource classifies the authority set", () => {
    for (const s of hookSources) {
      assert(estimateMod.isHookSource(s), `${s} must be hook-family`);
    }
    for (const s of nonHookSources) {
      assert(!estimateMod.isHookSource(s), `${String(s)} must not be hook-family`);
    }
  });

  // (1) compaction-hook owns the categories over a later fallback write.
  const t35Id = "ses_T35";
  mod.breakdownCache.set(t35Id, {
    userChars: 120,
    assistantChars: 60,
    reasoningChars: 10,
    toolArgsChars: 20,
    toolOutChars: 40,
    toolOutByTool: { read: 40 },
    systemChars: 300,
    toolSchemasChars: 100,
    reclaim: null,
    capturedAt: Date.now(),
    source: "compaction-hook",
  });
  mod.writeStateFile(t35Id, "model-alpha", "test-provider", 900, 900, 0);
  mod.breakdownCache.set(t35Id, {
    userChars: 0,
    assistantChars: 0,
    reasoningChars: 0,
    toolArgsChars: 0,
    toolOutChars: 0,
    toolOutByTool: {},
    systemChars: null,
    toolSchemasChars: null,
    reclaim: null,
    capturedAt: Date.now() + 5000,
    source: "client-context",
  });
  mod.writeStateFile(t35Id, "model-alpha", "test-provider", 900, 900, 0);
  const t35Comp = read()[t35Id];

  // (2) V1 transform is hook-family as well.
  const t35V1 = "ses_T35V1";
  mod.breakdownCache.set(t35V1, {
    userChars: 70,
    assistantChars: 30,
    reasoningChars: 0,
    toolArgsChars: 10,
    toolOutChars: 5,
    toolOutByTool: {},
    systemChars: 250,
    toolSchemasChars: null,
    reclaim: null,
    capturedAt: Date.now(),
    source: "transform",
  });
  mod.writeStateFile(t35V1, "model-alpha", "test-provider", 800, 800, 0);
  mod.breakdownCache.set(t35V1, {
    userChars: 0,
    assistantChars: 0,
    reasoningChars: 0,
    toolArgsChars: 0,
    toolOutChars: 0,
    toolOutByTool: {},
    systemChars: null,
    toolSchemasChars: null,
    reclaim: null,
    capturedAt: Date.now() + 5000,
    source: "client-context",
  });
  mod.writeStateFile(t35V1, "model-alpha", "test-provider", 800, 800, 0);
  const t35V1After = read()[t35V1];
  // Restore a hook-shaped cache entry (slightly different user count) so the log
  // test can prove the cache is printed as-is, not the state snapshot.
  mod.breakdownCache.set(t35V1, {
    userChars: 71,
    assistantChars: 30,
    reasoningChars: 0,
    toolArgsChars: 10,
    toolOutChars: 5,
    toolOutByTool: {},
    systemChars: 250,
    toolSchemasChars: null,
    reclaim: null,
    capturedAt: Date.now(),
    source: "transform",
  });

  // (3) legacy entry: no `source`, but a hook-only system estimate.
  const t35Legacy = "ses_T35L";
  const t35LegacyEntry = {
    sessionID: t35Legacy,
    parentID: null,
    role: "main",
    agent: null,
    model: "model-alpha",
    providerID: "test-provider",
    ctx: 700,
    input: 700,
    usable: 1000,
    reserve: 100,
    limit: 1000,
    reasoning: 0,
    categories: {
      user: 90,
      assistant: 40,
      reasoning: 0,
      toolArgs: 10,
      toolOut: 0,
      system: 180,
      toolSchemas: 60,
      other: 320,
    },
    updatedAt: new Date().toISOString(),
  };
  {
    const all = read();
    all[t35Legacy] = t35LegacyEntry;
    writeFileSync(HARNESS_STATE, JSON.stringify(all), "utf8");
  }
  mod.breakdownCache.set(t35Legacy, {
    userChars: 0,
    assistantChars: 0,
    reasoningChars: 0,
    toolArgsChars: 0,
    toolOutChars: 0,
    toolOutByTool: {},
    systemChars: null,
    toolSchemasChars: null,
    reclaim: null,
    capturedAt: Date.now() + 5000,
    source: "client-context",
  });
  mod.writeStateFile(t35Legacy, "model-alpha", "test-provider", 700, 700, 0);
  const t35LegacyAfter = read()[t35Legacy];
  mod.breakdownCache.delete(t35Legacy);

  // (4) live log: a fallback cache entry (or none) is replaced by the
  // hook-measured state.json entry; a hook cache entry is printed as-is.
  mod.breakdownCache.set(t35Id, {
    userChars: 0,
    assistantChars: 0,
    reasoningChars: 0,
    toolArgsChars: 0,
    toolOutChars: 0,
    toolOutByTool: {},
    systemChars: null,
    toolSchemasChars: null,
    reclaim: null,
    capturedAt: Date.now(),
    source: "client-context",
  });
  const t35LogFallback = v2Mod
    .buildLiveLinesV2(t35Id, "model-alpha", "test-provider", 0, 900, 0)
    .join("\n");
  mod.breakdownCache.delete(t35Id);
  const t35LogEmpty = v2Mod
    .buildLiveLinesV2(t35Id, "model-alpha", "test-provider", 0, 900, 0)
    .join("\n");
  const t35LogHook = v2Mod
    .buildLiveLinesV2(t35V1, "model-alpha", "test-provider", 800, 800, 0)
    .join("\n");
  mod.breakdownCache.delete(t35V1);

  check("T35 hook-family authority: compaction-hook, V1 transform, legacy entries", () => {
    assert(
      t35Comp.categories.system === 300 &&
        t35Comp.categories.toolSchemas === 100 &&
        t35Comp.categories.user === 120 &&
        t35Comp.source === "compaction-hook",
      `compaction-hook categories must survive a fallback write, got ${JSON.stringify(t35Comp.categories)}/${t35Comp.source}`,
    );
    assert(
      t35V1After.categories.system === 250 &&
        t35V1After.categories.user === 70 &&
        t35V1After.source === "transform",
      `V1 transform entry must survive a fallback write, got ${JSON.stringify(t35V1After.categories)}/${t35V1After.source}`,
    );
    // NOTE: `system`/`toolSchemas` alone would also pass on a regression - the
    // writer inherits null-ish fields from prevEntry. `user` (a fallback-owned
    // category) and the persisted `source` are the discriminating assertions.
    assert(
      t35LegacyAfter.categories.user === 90,
      `legacy hook-measured entry must not be blanked, got ${JSON.stringify(t35LegacyAfter.categories)}`,
    );
    assert(
      t35LegacyAfter.categories.system === 180 &&
        t35LegacyAfter.categories.toolSchemas === 60 &&
        t35LegacyAfter.source === "context-hook",
      `legacy entry must be re-tagged as hook-measured, got ${JSON.stringify(t35LegacyAfter.categories)}/${t35LegacyAfter.source}`,
    );
  });

  check("T35 live log prefers the hook-measured state entry over a fallback", () => {
    for (const [label, text] of [
      ["client-context cache", t35LogFallback],
      ["no cache entry", t35LogEmpty],
    ]) {
      assert(
        text.includes("system      300 (est tokens)"),
        `${label}: system must come from state.json, got:\n${text}`,
      );
      assert(
        text.includes("user        120 (est tokens)"),
        `${label}: user must come from state.json, got:\n${text}`,
      );
      assert(
        text.includes("source      compaction-hook"),
        `${label}: source tag must be the hook one, got:\n${text}`,
      );
      // The residual must be the HOOK's (900 - 650 = 250), not recomputed
      // against this instance's input (0 here, i.e. a mirror that never saw the
      // request: recomputation would print 0). The header counters must come
      // from the same snapshot, otherwise "other = input - sum" contradicts
      // `input=0` right above it.
      assert(
        text.includes("other       250"),
        `${label}: residual must come from the state entry, got:\n${text}`,
      );
      assert(
        text.includes("input=900 snapshot="),
        `${label}: header must borrow the snapshot counters, got:\n${text}`,
      );
    }
    assert(
      t35LogHook.includes("system      250 (est tokens)") &&
        t35LogHook.includes("user        71 (est tokens)"),
      `a hook cache entry must be printed as-is, got:\n${t35LogHook}`,
    );
  });

  // (5) the V1 hooks themselves, not just the classifier: system.transform on
  // top of a `fallback` cache record must re-tag the entry as hook-family (the
  // M1 regression - a fallback tag with a non-null system estimate would let the
  // next fallback overwrite the hook numbers).
  const v1Mod = await import(pathToFileURL(join(repoRoot, "lib", "v1.js")).href);
  const t35V1HookId = "ses_T35V1H";
  mod.breakdownCache.set(t35V1HookId, {
    userChars: 50,
    assistantChars: 20,
    reasoningChars: 0,
    toolArgsChars: 0,
    toolOutChars: 0,
    toolOutByTool: {},
    systemChars: null,
    toolSchemasChars: null,
    reclaim: null,
    capturedAt: Date.now() - 1000,
    source: "fallback",
  });
  const t35V1Plugin = v1Mod.makeV1({
    config: { providers: async () => [] },
  });
  t35V1Plugin["experimental.chat.system.transform"](
    { sessionID: t35V1HookId },
    { system: ["s".repeat(400)] },
  );
  const t35V1HookEntry = mod.breakdownCache.get(t35V1HookId);

  check("T35 V1 system.transform re-tags a fallback record as hook-family", () => {
    assert(
      t35V1HookEntry.source === "system-transform",
      `source must be hook-family, got ${t35V1HookEntry.source}`,
    );
    assert(
      typeof t35V1HookEntry.systemChars === "number" &&
        t35V1HookEntry.systemChars > 0,
      `system estimate must be recorded, got ${t35V1HookEntry.systemChars}`,
    );
    assert(
      t35V1HookEntry.userChars === 50,
      `the fallback categories must be preserved, got ${t35V1HookEntry.userChars}`,
    );
    assert(
      estimateMod.isHookMeasuredEntry({
        categories: { system: t35V1HookEntry.systemChars },
        source: t35V1HookEntry.source,
      }) === true,
      "the merged record must be hook-measured (a later fallback cannot overwrite it)",
    );
  });

  // (6) A hook cache entry whose instance has NO request counters. The categories
  // are real, but `input`/`ctx` are 0 because this instance never completed a
  // step (a mirror that only saw the compaction). Printing `ctx=0` above real
  // categories is worse than useless: the state.json measurement is borrowed
  // whole, and when there is none the header says "?" instead of a fake 0.
  const t36NoState = "ses_T36b_nostate";
  mod.modelLimits.clear();
  capture(() => mod.hydrateModelLimitsFromState());
  mod.breakdownCache.delete(t35Id);
  mod.breakdownCache.set(t35Id, {
    userChars: 120,
    assistantChars: 80,
    reasoningChars: 0,
    toolArgsChars: 0,
    toolOutChars: 0,
    toolOutByTool: {},
    systemChars: 300,
    toolSchemasChars: 100,
    reclaim: null,
    capturedAt: Date.now(),
    source: "context-hook",
  });
  const t36Borrowed = v2Mod
    .buildLiveLinesV2(t35Id, "model-alpha", "test-provider", 0, 0, 0)
    .join("\n");
  mod.breakdownCache.delete(t35Id);

  mod.breakdownCache.set(t36NoState, {
    userChars: 60,
    assistantChars: 40,
    reasoningChars: 0,
    toolArgsChars: 0,
    toolOutChars: 0,
    toolOutByTool: {},
    systemChars: null,
    toolSchemasChars: null,
    reclaim: null,
    capturedAt: Date.now(),
    source: "compaction-hook",
  });
  const t36Unknown = v2Mod
    .buildLiveLinesV2(t36NoState, "model-alpha", "test-provider", 0, 0, 0)
    .join("\n");
  mod.breakdownCache.delete(t36NoState);

  // A state entry CAN exist while its counters are 0 (the trailing-event
  // fallback of a mirror writes one without a positive ctx gate). A zero is
  // "unknown", not knowledge: the header must still say "?", and the residual
  // must not be pulled from `other: 0` computed against input 0.
  const t36ZeroSnap = "ses_T36d_zerosnap";
  const t36ZeroState = read();
  t36ZeroState[t36ZeroSnap] = {
    sessionID: t36ZeroSnap,
    parentID: null,
    role: "main",
    agent: null,
    model: "model-alpha",
    providerID: "test-provider",
    ctx: 0,
    input: 0,
    usable: null,
    limit: null,
    reasoning: 0,
    categories: {
      user: 61,
      assistant: 41,
      reasoning: 0,
      toolArgs: 0,
      system: null,
      toolSchemas: null,
      other: 0,
    },
    source: "compaction-hook",
    updatedAt: "2026-10-29T17:00:00.000Z",
  };
  writeFileSync(HARNESS_STATE, JSON.stringify(t36ZeroState), "utf8");
  mod.breakdownCache.set(t36ZeroSnap, {
    userChars: 62,
    assistantChars: 42,
    reasoningChars: 0,
    toolArgsChars: 0,
    toolOutChars: 0,
    toolOutByTool: {},
    systemChars: null,
    toolSchemasChars: null,
    reclaim: null,
    capturedAt: Date.now(),
    source: "compaction-hook",
  });
  const t36Zero = v2Mod
    .buildLiveLinesV2(t36ZeroSnap, "model-alpha", "test-provider", 0, 0, 0)
    .join("\n");
  mod.breakdownCache.delete(t36ZeroSnap);
  delete t36ZeroState[t36ZeroSnap];
  writeFileSync(HARNESS_STATE, JSON.stringify(t36ZeroState), "utf8");

  // A ctx-only snapshot: the compaction hook knows the context size but a
  // mirror instance never saw the request, so `input` is genuinely unknown and
  // the residual (`other = input - sum`) must not be printed from a 0 input.
  const t36CtxOnly = "ses_T36e_ctxonly";
  const t36CtxState = read();
  t36CtxState[t36CtxOnly] = {
    sessionID: t36CtxOnly,
    parentID: null,
    role: "main",
    agent: null,
    model: "model-alpha",
    providerID: "test-provider",
    ctx: 500,
    input: 0,
    usable: null,
    limit: null,
    reasoning: 0,
    categories: {
      user: 80,
      assistant: 20,
      reasoning: 0,
      toolArgs: 0,
      system: null,
      toolSchemas: null,
      other: 0,
    },
    source: "compaction-hook",
    updatedAt: "2026-10-29T17:05:00.000Z",
  };
  writeFileSync(HARNESS_STATE, JSON.stringify(t36CtxState), "utf8");
  mod.breakdownCache.set(t36CtxOnly, {
    userChars: 81,
    assistantChars: 21,
    reasoningChars: 0,
    toolArgsChars: 0,
    toolOutChars: 0,
    toolOutByTool: {},
    systemChars: null,
    toolSchemasChars: null,
    reclaim: null,
    capturedAt: Date.now(),
    source: "compaction-hook",
  });
  const t36Ctx = v2Mod
    .buildLiveLinesV2(t36CtxOnly, "model-alpha", "test-provider", 0, 0, 0)
    .join("\n");
  mod.breakdownCache.delete(t36CtxOnly);
  delete t36CtxState[t36CtxOnly];
  writeFileSync(HARNESS_STATE, JSON.stringify(t36CtxState), "utf8");

  // Regression guard: with counters present nothing is borrowed (and the
  // residual is recomputed against the local input, no snapshot tag).
  const t36LocalId = "ses_T36c_local";
  mod.breakdownCache.set(t36LocalId, {
    userChars: 100,
    assistantChars: 60,
    reasoningChars: 0,
    toolArgsChars: 0,
    toolOutChars: 0,
    toolOutByTool: {},
    systemChars: 250,
    toolSchemasChars: null,
    reclaim: null,
    capturedAt: Date.now(),
    source: "transform",
  });
  const t36Local = v2Mod
    .buildLiveLinesV2(t36LocalId, "model-alpha", "test-provider", 800, 800, 0)
    .join("\n");
  mod.breakdownCache.delete(t36LocalId);

  check("T36 live log: a hook entry without counters borrows the snapshot or says unknown", () => {
    assert(
      t36Borrowed.includes("input=900 snapshot=") &&
        t36Borrowed.includes("other       250"),
      `a counter-less hook cache must borrow the whole snapshot, got:\n${t36Borrowed}`,
    );
    // The cache says assistant 80, the snapshot 60: only a whole-entry borrow
    // prints 60. Asserting just the counters would also pass a header-only fix.
    assert(
      t36Borrowed.includes("assistant   60 (est tokens)") &&
        !t36Borrowed.includes("assistant   80"),
      `the categories must come from the snapshot too, got:\n${t36Borrowed}`,
    );
    assert(
      !/\bctx=0\b/.test(t36Borrowed) && !/\bcount=0\b/.test(t36Borrowed),
      `the header must not print 0 next to real categories, got:\n${t36Borrowed}`,
    );
    assert(
      t36Unknown.includes("ctx=?/") && t36Unknown.includes("input=?"),
      `without a snapshot the counters must be unknown, got:\n${t36Unknown}`,
    );
    assert(
      t36Unknown.includes("other       n/a (input unknown on this instance)"),
      `the residual must not be fabricated, got:\n${t36Unknown}`,
    );
    assert(
      t36Unknown.includes("user        60 (est tokens)") &&
        t36Unknown.includes("source      compaction-hook"),
      `the local (measured) categories must still be printed, got:\n${t36Unknown}`,
    );
    assert(
      t36Zero.includes("ctx=?/") &&
        t36Zero.includes("input=?") &&
        t36Zero.includes("other       n/a (input unknown on this instance)") &&
        !/\bctx=0\b/.test(t36Zero) &&
        !/\bcount=0\b/.test(t36Zero) &&
        !t36Zero.includes("other       0"),
      `a zero-counter snapshot is still unknown, got:\n${t36Zero}`,
    );
    assert(
      t36Zero.includes("snapshot=2026-10-29T17:00:00.000Z"),
      `a borrowed zero-counter entry must still be stamped, got:\n${t36Zero}`,
    );
    assert(
      t36Ctx.includes("count=500") &&
        t36Ctx.includes("input=?") &&
        t36Ctx.includes("other       n/a (input unknown on this instance)") &&
        !t36Ctx.includes("other       0"),
      `a ctx-only snapshot keeps the window but not a fake input/residual, got:\n${t36Ctx}`,
    );
    assert(
      t36Local.includes("input=800") &&
        !t36Local.includes("snapshot=") &&
        t36Local.includes("other       390"),
      `a local measurement with counters must stay local, got:\n${t36Local}`,
    );
  });
}

// T37 - the denominator rule from opencode 2.2.5 (#60660). Core's inputWindow()
// is `input && context ? min(input, context) : input || context`: a provider
// that reports an input limit ABOVE the context window cannot use it in full,
// because the context also holds the reply. Before 2.2.5 the plugin used
// `input || context`, which overstated the window (and printed a compact-at
// point the host never reaches). These records are seeded directly so the rule
// is covered even if the state fixture changes.
{
  const t37Seed = (modelID, rec) =>
    mod.modelLimits.set(`test-provider:${modelID}`, rec);
  const t37Keys = [];
  try {
    t37Seed("model-window-cap", { context: 200000, input: 300000 });
    t37Keys.push("test-provider:model-window-cap");
    t37Seed("model-input-smaller", { context: 200000, input: 100000 });
    t37Keys.push("test-provider:model-input-smaller");
    t37Seed("model-input-only", { context: 0, input: 200000 });
    t37Keys.push("test-provider:model-input-only");
    t37Seed("model-context-only", { context: 200000, input: 0 });
    t37Keys.push("test-provider:model-context-only");
    t37Seed("model-window-equal", { context: 200000, input: 200000 });
    t37Keys.push("test-provider:model-window-equal");

    check("T37 min(input, context): an input limit above the context window is capped", () => {
      const info = mod.getUsableContext("test-provider", "model-window-cap");
      // input alone would give window 300000 -> reserve 45000 -> usable 255000;
      // the host caps at 200000 -> reserve 30000 -> usable 170000.
      assert(info?.limit === 200000, `window must be min(300000, 200000), got ${info?.limit}`);
      assert(info?.reserved === 30000, `reserve must be 15% of the capped window, got ${info?.reserved}`);
      assert(info?.usable === 170000, `usable must be 170000, got ${info?.usable}`);
    });

    check("T37 min(input, context): a smaller input limit still wins", () => {
      const info = mod.getUsableContext("test-provider", "model-input-smaller");
      assert(info?.limit === 100000, `window must be min(100000, 200000), got ${info?.limit}`);
      // 100000 < 2 * 16000, so the floor applies: 100000 - 16000.
      assert(info?.reserved === 16000, `reserve must be RESERVE_MIN, got ${info?.reserved}`);
      assert(info?.usable === 84000, `usable must be 84000, got ${info?.usable}`);
    });

    check("T37 min(input, context): single-sided limits are unchanged", () => {
      const inputOnly = mod.getUsableContext("test-provider", "model-input-only");
      assert(
        inputOnly?.limit === 200000 && inputOnly?.usable === 170000,
        `input-only must still use 200000, got ${inputOnly?.limit}/${inputOnly?.usable}`,
      );
      const contextOnly = mod.getUsableContext("test-provider", "model-context-only");
      assert(
        contextOnly?.limit === 200000 && contextOnly?.usable === 170000,
        `context-only must still use 200000, got ${contextOnly?.limit}/${contextOnly?.usable}`,
      );
      const equal = mod.getUsableContext("test-provider", "model-window-equal");
      assert(
        equal?.limit === 200000 && equal?.usable === 170000,
        `equal limits must be 200000, got ${equal?.limit}/${equal?.usable}`,
      );
    });

    check("T37 min(input, context): the buffer override applies to the capped window", () => {
      const info = mod.getUsableContext("test-provider", "model-window-cap", 50000);
      // The cap happens first; 50000 < 200000 so the override replaces the share.
      assert(info?.limit === 200000, `window must stay capped, got ${info?.limit}`);
      assert(info?.reserved === 50000, `override must replace the reserve, got ${info?.reserved}`);
      assert(info?.usable === 150000, `usable must be 200000 - 50000, got ${info?.usable}`);
    });
  } finally {
    for (const key of t37Keys) mod.modelLimits.delete(key);
  }
}

// ---------------------------------------------------------------------------
// T38 - configured compaction.buffer (opencode 2.2.5+).
//
// The plugin API exposes no config object, so lib/config.js reads the user's
// own JSONC/JSON file. Covered here: the comment stripper (string-aware), the
// percent/token conversion, the project-over-global precedence, and the wiring
// into getUsableContext (an explicit argument and the env var still win).
// Everything runs against a throwaway XDG_CONFIG_HOME; the live user config is
// never touched.
// ---------------------------------------------------------------------------
{
  const configMod = await import(
    pathToFileURL(join(repoRoot, "lib", "config.js")).href
  );
  const savedXdg = process.env.XDG_CONFIG_HOME;
  const savedEnvBuffer = process.env.OPENCODE_CONTEXT_INDICATOR_COMPACT_BUFFER;
  const cfgRoot = join(tmpdir(), `oci-t38-${process.pid}-${Date.now()}`);
  const globalDir = join(cfgRoot, "opencode");
  const projectDir = join(globalDir, "project-fixture");
  const writeCfg = (dir, name, body) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), body, "utf8");
  };
  const resetAll = () => {
    configMod.resetConfigCache();
    mod.resetConfiguredBufferCache();
  };
  try {
    delete process.env.OPENCODE_CONTEXT_INDICATOR_COMPACT_BUFFER;
    // Same directory as the project fixture keeps the walk deterministic: it is
    // a subdirectory of the global dir, which the resolver never scans.
    writeCfg(projectDir, "opencode.jsonc", "{}");
    process.env.XDG_CONFIG_HOME = cfgRoot;

    check("T38 stripJsonc: comments outside strings, strings with // and /* survive", () => {
      const text = [
        "{",
        '  // line comment',
        '  "a": "http://x/*y*/", // trailing',
        "  /* block",
        '     comment */ "b": 1,',
        "}",
      ].join("\n");
      const parsed = JSON.parse(configMod.stripJsonc(text));
      assert(
        parsed.a === "http://x/*y*/" && parsed.b === 1,
        `stripper damaged a string value: ${JSON.stringify(parsed)}`,
      );
    });

    check("T38 stripJsonc: trailing commas are tolerated, string values untouched", () => {
      const parsed = JSON.parse(configMod.stripJsonc('{"a":[1,2,],"b":2,}'));
      assert(parsed.a.length === 2 && parsed.b === 2, "trailing commas not removed");
      // A comma directly before `}` INSIDE a string must not be dropped.
      const str = JSON.parse(configMod.stripJsonc('{"cmd":"x,}","n":1}'));
      assert(str.cmd === "x,}", `a string value was rewritten: ${JSON.stringify(str.cmd)}`);
    });

    check("T38 bufferTokens: percentages and token counts", () => {
      assert(configMod.bufferTokens(200000, "20%") === 40000, "20% of 200000 must be 40000");
      assert(configMod.bufferTokens(200000, "12.5%") === 25000, "12.5% must round to 25000");
      assert(configMod.bufferTokens(200000, "99%") === 198000, "99% must be 198000");
      assert(configMod.bufferTokens(200000, 30000) === 30000, "a token count passes through");
    });

    check("T38 bufferTokens: invalid shapes are ignored, like core", () => {
      for (const bad of ["0%", "100%", "120%", "abc", " 20%", "20", -1, 1.5, 5e9, 1.5e300, null, {}]) {
        assert(
          configMod.bufferTokens(200000, bad) === undefined,
          `must reject ${String(bad)}`,
        );
      }
    });

    check("T38 resolveCompactionBuffer: project beats global, per-file JSONC", () => {
      writeCfg(globalDir, "opencode.jsonc", '{\n  // global\n  "compaction": { "buffer": "10%" },\n}\n');
      resetAll();
      let resolved = configMod.resolveCompactionBuffer();
      assert(resolved.value === "10%", `global buffer expected, got ${String(resolved.value)}`);
      writeCfg(projectDir, "opencode.jsonc", '{ "compaction": { "buffer": 30000 } }');
      resolved = configMod.resolveCompactionBuffer(projectDir);
      assert(resolved.value === 30000, `project buffer must win, got ${String(resolved.value)}`);
      // A project file WITHOUT a buffer must not shadow the global setting.
      writeCfg(projectDir, "opencode.jsonc", '{ "model": "model-alpha" }');
      resolved = configMod.resolveCompactionBuffer(projectDir);
      assert(resolved.value === "10%", `global must survive an unrelated project file, got ${String(resolved.value)}`);
    });

    check("T38 getUsableContext applies the configured percentage buffer", () => {
      mod.modelLimits.set("test-provider:model-configured", { context: 200000, input: 0, output: 32000 });
      writeCfg(globalDir, "opencode.jsonc", '{ "compaction": { "buffer": "20%" } }');
      resetAll();
      const info = mod.getUsableContext("test-provider", "model-configured");
      assert(info?.reserved === 40000, `reserve must be 20% of 200000, got ${info?.reserved}`);
      assert(info?.usable === 160000, `usable must be 160000, got ${info?.usable}`);
    });

    check("T38 getUsableContext: project buffer and env override win in order", () => {
      mod.modelLimits.set("test-provider:model-configured", { context: 200000, input: 0, output: 32000 });
      writeCfg(globalDir, "opencode.jsonc", '{ "compaction": { "buffer": "20%" } }');
      writeCfg(projectDir, "opencode.jsonc", '{ "compaction": { "buffer": 50000 } }');
      resetAll();
      let info = mod.getUsableContext("test-provider", "model-configured", undefined, projectDir);
      assert(info?.reserved === 50000, `project buffer must win over global, got ${info?.reserved}`);
      process.env.OPENCODE_CONTEXT_INDICATOR_COMPACT_BUFFER = "30000";
      info = mod.getUsableContext("test-provider", "model-configured", undefined, projectDir);
      assert(info?.reserved === 30000, `env must win over the config, got ${info?.reserved}`);
      delete process.env.OPENCODE_CONTEXT_INDICATOR_COMPACT_BUFFER;
      info = mod.getUsableContext("test-provider", "model-configured", 10000, projectDir);
      assert(info?.reserved === 10000, `an explicit argument must win, got ${info?.reserved}`);
    });

    // One server process can host several plugin instances (one per location).
    // The buffer cache is keyed by directory, so two projects must never see
    // each other's `compaction.buffer` in the same second.
    check("T38 two projects do not leak buffers into each other", () => {
      mod.modelLimits.set("test-provider:model-configured", { context: 200000, input: 0, output: 32000 });
      const otherDir = join(cfgRoot, "other-project");
      writeCfg(globalDir, "opencode.jsonc", '{ "compaction": { "buffer": "20%" } }');
      writeCfg(projectDir, "opencode.jsonc", '{ "compaction": { "buffer": 50000 } }');
      writeCfg(otherDir, "opencode.jsonc", '{ "compaction": { "buffer": "10%" } }');
      resetAll();
      const a = mod.getUsableContext("test-provider", "model-configured", undefined, projectDir);
      const b = mod.getUsableContext("test-provider", "model-configured", undefined, otherDir);
      const again = mod.getUsableContext("test-provider", "model-configured", undefined, projectDir);
      assert(a?.reserved === 50000, `project A must keep its own buffer, got ${a?.reserved}`);
      assert(b?.reserved === 20000, `project B must use 10%, got ${b?.reserved}`);
      assert(again?.reserved === 50000, `project A must not inherit B's buffer, got ${again?.reserved}`);
      const globalOnly = mod.getUsableContext("test-provider", "model-configured");
      assert(globalOnly?.reserved === 40000, `no directory must mean global only, got ${globalOnly?.reserved}`);
    });

    check("T38 a buffer >= the window falls back to the default share", () => {
      mod.modelLimits.set("test-provider:model-configured", { context: 200000, input: 0, output: 32000 });
      writeCfg(globalDir, "opencode.jsonc", '{ "compaction": { "buffer": 200000 } }');
      resetAll();
      const info = mod.getUsableContext("test-provider", "model-configured");
      assert(info?.reserved === 30000, `a >= window buffer must be ignored, got ${info?.reserved}`);
    });
  } finally {
    mod.modelLimits.delete("test-provider:model-configured");
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedEnvBuffer === undefined) delete process.env.OPENCODE_CONTEXT_INDICATOR_COMPACT_BUFFER;
    else process.env.OPENCODE_CONTEXT_INDICATOR_COMPACT_BUFFER = savedEnvBuffer;
    resetAll();
    try {
      rmSync(cfgRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup of the throwaway config tree */
    }
  }
}

// ---------------------------------------------------------------------------
// T39 - the TUI composer capsule (`prompt.footer.status`): thresholds and the
// null cases, shared with the Desktop pill (65% amber / 85% red).
// ---------------------------------------------------------------------------
{
  const dataMod = await import(
    pathToFileURL(join(repoRoot, "lib", "tui-data.js")).href
  );

  check("T39 composerStatus: no window -> no capsule", () => {
    assert(dataMod.composerStatus(null) === null, "null entry must be null");
    assert(dataMod.composerStatus({}) === null, "an entry without counters must be null");
    assert(dataMod.composerStatus({ ctx: 1000, usable: 0 }) === null, "usable 0 must be null");
    assert(dataMod.composerStatus({ ctx: 1000, usable: null }) === null, "null usable must be null");
  });

  check("T39 composerStatus: label and thresholds", () => {
    const calm = dataMod.composerStatus({ ctx: 90000, usable: 200000 });
    assert(calm.label === "45% ctx", `label must be 45% ctx, got ${calm?.label}`);
    assert(calm.tone === undefined, `45% must stay neutral, got ${calm?.tone}`);
    const warn = dataMod.composerStatus({ ctx: 130000, usable: 200000 });
    assert(warn.label === "65% ctx" && warn.tone === "warning", `65% must be amber, got ${warn?.label}/${warn?.tone}`);
    const danger = dataMod.composerStatus({ ctx: 170000, usable: 200000 });
    assert(danger.label === "85% ctx" && danger.tone === "danger", `85% must be red, got ${danger?.label}/${danger?.tone}`);
    const over = dataMod.composerStatus({ ctx: 240000, usable: 200000 });
    assert(over.percent === 120 && over.tone === "danger", `120% must stay honest and red, got ${over?.percent}/${over?.tone}`);
  });

  check("T39 composerStatus: rounding matches the displayed percent", () => {
    const edge = dataMod.composerStatus({ ctx: 169200, usable: 200000 }); // 84.6%
    assert(edge.percent === 85, `84.6% must round to 85, got ${edge?.percent}`);
    // The tone compares the RAW share (like the Desktop pill), so 84.6% rounds
    // up in the label while still showing the warning colour.
    assert(edge.tone === "warning", `84.6% must stay warning, got ${edge?.tone}`);
  });
}

// ---------------------------------------------------------------------------
// T40 - model-rendered payloads: data FIRST, one trailing imperative. Models
// used to echo the leading "Output the content ... exactly, verbatim" sentence
// into the answer; the instruction must not sit before the data any more.
// ---------------------------------------------------------------------------
{
  const tuiData = await import(
    pathToFileURL(join(repoRoot, "lib", "tui-data.js")).href
  );

  check("T40 taggedPayload: data first, single instruction last", () => {
    const body = "Context 10.0k / 100.0k (10%)\nmodel-alpha . 12:00:00\ncompact at 90.0k";
    const tag = "context-diff";
    const text = mod.taggedPayload(tag, body);
    assert(text.startsWith(`<${tag}>\n`), `${tag}: payload must open the message`);
    assert(text.includes(body), `${tag}: body lost`);
    assert(text.trimEnd().endsWith(mod.REPLY_ONLY), `${tag}: instruction must be the last line`);
    assert(
      text.indexOf(mod.REPLY_ONLY) === text.lastIndexOf(mod.REPLY_ONLY),
      `${tag}: the instruction must appear exactly once`,
    );
    assert(
      text.indexOf(mod.REPLY_ONLY) > text.indexOf(`</${tag}>`),
      `${tag}: the instruction must come AFTER the closing tag`,
    );
    assert(
      text.indexOf(mod.REPLY_ONLY) !== 0,
      `${tag}: nothing may precede the payload`,
    );
    // The imperative must not name the tags or the body: it is the last thing the
    // model reads, and a mention of the tags invites it to echo them.
    assert(!/<context-|verbatim/i.test(mod.REPLY_ONLY), "instruction must stay tag-free and short");
    assert(mod.REPLY_ONLY.split("\n").length === 1, "instruction must be one line");
  });

  check("T40 updatedAt: locale-independent HH:MM:SS", () => {
    const iso = "2026-09-29T18:51:54.013Z";
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    const expected = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const got = tuiData.updatedAt(iso);
    assert(/^\d{2}:\d{2}:\d{2}$/.test(got), `expected HH:MM:SS, got ${got}`);
    assert(got === expected, `local time mismatch: ${got} != ${expected}`);
    // A fixed width regardless of the host locale (no AM/PM, no dotted form).
    assert(tuiData.updatedAt("2026-09-29T05:06:07.000Z").length === 8, "6h7m7s must still be 8 chars");
    assert(tuiData.updatedAt("") === "?" && tuiData.updatedAt("not-a-date") === "?");
  });

  check("T40 updatedCell: the stale marker survives the width", () => {
    const iso = "2026-09-29T18:51:54.013Z";
    const full = tuiData.updatedCell(iso, false, 10);
    assert(full.length === 10, `fresh cell must fill 10 columns, got ${full.length}`);
    assert(!full.includes("*"), `a fresh row must carry no marker: ${full}`);
    const stale = tuiData.updatedCell(iso, true, 10);
    assert(stale.length === 10, `a stale cell must stay inside the width, got ${stale.length}`);
    assert(stale.endsWith(" *"), `the stale marker must survive: ${stale}`);
    assert(/\d{2}:\d{2}:\d{2}/.test(stale), `the time must not be truncated at 10 columns: ${stale}`);
    // Narrower column: the marker still wins over the time tail (fit() would
    // otherwise cut exactly the marker off and leave a legend with no owner).
    const narrow = tuiData.updatedCell(iso, true, 8);
    assert(narrow.length === 8, `narrow cell must fill 8 columns, got ${narrow.length}`);
    assert(narrow.endsWith(" *"), `narrow stale marker lost: ${narrow}`);
  });

  check("T40 contributorLine: unit + readable bucket label", () => {
    const msg = contrib.contributorLine(
      { kind: "asst.text", ref: "14:25", chars: 200, tokensEstimate: 50, tool: "", preview: "" },
      1,
    );
    assert(msg.includes("assistant 14:25 message"), msg);
    assert(msg.endsWith("50 tokens (est)"), `a bare number must carry its unit: ${msg}`);
    const res = contrib.contributorLine(
      { kind: "asst.result", ref: "14:26", chars: 5000, tokensEstimate: 1250, tool: "bash", preview: "" },
      2,
    );
    assert(res.includes("tool result (bash)"), res);
    assert(res.includes("1.3k tokens (est)"), `k-formatted value must carry its unit: ${res}`);
  });
}

// ---------------------------------------------------------------------------
// T41 - a MODEL SWITCH inside one session must not keep reporting the previous
// model's category split: cache reads are model-scoped and the persisted split
// is only inherited while model + provider stay the same.
// ---------------------------------------------------------------------------
{
  check("T41 breakdownForModel: cache reads are model-scoped", () => {
    mod.breakdownCache.set("ses_T41", { userChars: 10, source: "context-hook", model: "model-alpha" });
    assert(mod.breakdownForModel("ses_T41", "model-alpha") !== null, "same model must be served");
    assert(mod.breakdownForModel("ses_T41", "model-beta") === null, "another model must not be served");
    assert(mod.breakdownForModel("ses_T41", "unknown") !== null, "an unknown reader keeps the data");
    mod.breakdownCache.set("ses_T41", { userChars: 10, source: "context-hook" });
    assert(mod.breakdownForModel("ses_T41", "model-beta") !== null, "an untagged legacy entry is tolerated");
    mod.breakdownCache.delete("ses_T41");
    assert(mod.breakdownForModel("ses_T41", "model-alpha") === null, "a missing entry is null");
  });

  const t41Base = {
    sessionID: "ses_T41W", parentID: null, role: "main", agent: null,
    model: "model-alpha", providerID: "test-provider", ctx: 1000, input: 1000,
    usable: 170000, limit: 200000, reasoning: 0,
    categories: { user: 11, assistant: 12, reasoning: 0, toolArgs: 0, toolOut: 0, system: 13, toolSchemas: 14, other: 950 },
    source: "context-hook", updatedAt: new Date().toISOString(),
  };
  const t41Bd = (model, over) => ({
    userChars: 500, assistantChars: 40, reasoningChars: 0, toolArgsChars: 0,
    toolOutChars: 0, toolOutByTool: {}, systemChars: 100, toolSchemasChars: 100,
    reclaim: null, capturedAt: Date.now(), source: "context-hook", model,
    ...over,
  });
  writeFileSync(HARNESS_STATE, JSON.stringify({ ses_T41W: t41Base }), "utf8");

  check("T41 writeStateFile: another model's breakdown is not persisted", () => {
    mod.breakdownCache.set(
      "ses_T41W",
      t41Bd("model-beta", { userChars: 9999, assistantChars: 9999, systemChars: null, toolSchemasChars: null }),
    );
    capture(() => mod.writeStateFile("ses_T41W", "model-alpha", "test-provider", 1000, 1000, 0));
    const e = read().ses_T41W;
    assert(e.categories.user === 11, `a model-beta split landed on model-alpha (user=${e.categories.user})`);
    mod.breakdownCache.delete("ses_T41W");
  });

  check("T41 writeStateFile: an unknown provider is not a model switch", () => {
    // A mirror/idle write may persist `providerID: ""` for the same model; the
    // next write that knows the provider must keep the split, not zero it.
    const cur = read();
    cur.ses_T41P = { ...t41Base, sessionID: "ses_T41P", providerID: "" };
    writeFileSync(HARNESS_STATE, JSON.stringify(cur), "utf8");
    capture(() => mod.writeStateFile("ses_T41P", "model-alpha", "test-provider", 1000, 1000, 0));
    const e = read().ses_T41P;
    assert(e.providerID === "test-provider", `provider not learned: ${String(e.providerID)}`);
    assert(e.categories.user === 11, `learning the provider zeroed the split (user=${e.categories.user})`);
    assert(typeof e.usable === "number" && e.usable > 0, `learning the provider dropped the denominator (${String(e.usable)})`);
  });

  check("T41 writeStateFile: a switch uses the new model's split only", () => {
    mod.breakdownCache.set("ses_T41W", t41Bd("model-gamma"));
    capture(() => mod.writeStateFile("ses_T41W", "model-gamma", "test-provider", 2000, 2000, 0));
    let e = read().ses_T41W;
    assert(e.model === "model-gamma", `model not switched: ${e.model}`);
    assert(e.categories.user === 500, `the new model's split must win, got user=${e.categories.user}`);
    // No live breakdown for the NEXT switch: the old split must not be revived.
    mod.breakdownCache.delete("ses_T41W");
    capture(() => mod.writeStateFile("ses_T41W", "model-delta", "test-provider", 3000, 3000, 0));
    e = read().ses_T41W;
    assert(e.model === "model-delta", `model not switched: ${e.model}`);
    assert(e.categories.user === 0, `a switch without a breakdown revived the old split (user=${e.categories.user})`);
    assert(e.categories.system === null, `system must be unknown, not inherited (got ${e.categories.system})`);
  });
}

// ---------------------------------------------------------------------------
// T42 - the panel row layout: growing the `updated` cell (so the stale marker
// always fits) must not push the row past the panel width. The original defect
// was exactly that: updW 8 -> 10 without taking the columns from anywhere, so
// the host clipped the right edge and the marker disappeared again.
// ---------------------------------------------------------------------------
{
  const tuiData = await import(
    pathToFileURL(join(repoRoot, "lib", "tui-data.js")).href
  );
  check("T42 panelLayout: the row keeps the safe column at every width", () => {
    // Sweep, not samples: the safe column used to vanish exactly where the
    // model floor bound (w=60..62 were exact fits), which the sampled points
    // 60/72/80/100/120 could not distinguish from "fine".
    for (let w = 57; w <= 140; w++) {
      const L = tuiData.panelLayout(w);
      const total =
        L.roleW + L.modelW + L.ctxW + L.costW + L.updW + 4 * L.gutter.length;
      assert(
        total <= w - 1,
        `w=${w}: columns sum to ${total}, no safe column (panel is ${w})`,
      );
      assert(total >= w - 3, `w=${w}: layout wastes ${w - total} columns`);
      assert(L.gutter.length === 2, `w=${w}: gutter must stay 2 columns`);
      assert(L.modelW >= 8, `w=${w}: model cell below its 8-column floor`);
      assert(L.roleW >= 12, `w=${w}: role cell below its 12-column floor`);
      assert(L.updW === 10 || L.updW === 8, `w=${w}: unexpected updated width ${L.updW}`);
    }
    // Narrow panel: the updated cell gives up the stale marker's 2 columns
    // instead of pushing the row off the panel.
    assert(tuiData.panelLayout(60).updW === 8, "w=60 must use the 8-column time cell");
    assert(tuiData.panelLayout(72).updW === 10, "w=72 must fit HH:MM:SS + ' *'");
    // The role cell is what pays for the safe column once both floors bind.
    assert(tuiData.panelLayout(60).roleW === 15, "w=60: role must give back 1 column");
    // Undefined/zero width falls back to the 60-column default.
    const fallback = tuiData.panelLayout(undefined);
    assert(fallback.updW === 8 && fallback.modelW === 8, "default layout drifted");
  });
}

// ---------------------------------------------------------------------------
// T43 - `session.deleted` purges the persisted entry (and its subtree). Waiting
// for the 7-day tombstone left dead sessions in the breakdown table, the Desktop
// tab and the /cx picker, and a phantom row has no step left to be filtered by.
// ---------------------------------------------------------------------------
{
  const readRaw = () => JSON.parse(readFileSync(HARNESS_STATE, "utf8"));

  check("T43 pruneSessionState: a deleted session takes its subtree, not its peers", () => {
    writeFileSync(
      HARNESS_STATE,
      JSON.stringify({
        ses_T43root: { sessionID: "ses_T43root", parentID: null, ctx: 10 },
        ses_T43a: { sessionID: "ses_T43a", parentID: "ses_T43root", ctx: 20 },
        ses_T43b: { sessionID: "ses_T43b", parentID: "ses_T43a", ctx: 30 },
        ses_T43peer: { sessionID: "ses_T43peer", parentID: null, ctx: 40 },
      }),
      "utf8",
    );
    assert(mod.pruneSessionState("ses_T43root") === true, "prune must report a write");
    const after = readRaw();
    assert(
      !("ses_T43root" in after) && !("ses_T43a" in after) && !("ses_T43b" in after),
      `subtree survived: ${Object.keys(after).join(",")}`,
    );
    assert(after.ses_T43peer?.ctx === 40, "an unrelated session must survive");
  });

  check("T43 pruneSessionState: unknown and unsafe keys change nothing", () => {
    const before = readFileSync(HARNESS_STATE, "utf8");
    assert(mod.pruneSessionState("ses_T43missing") === false, "a missing session must report no write");
    assert(mod.pruneSessionState("__proto__") === false, "an unsafe key must be rejected");
    assert(readFileSync(HARNESS_STATE, "utf8") === before, "state.json must be untouched");
  });

  check("T43 a deleted child cannot be recreated by a late write", () => {
    // The deleted session's own idle/step may still arrive (or a child may still
    // be running): without the write barrier the row came back - as a ROOT, since
    // the parent cache was cleared too.
    const iso = new Date().toISOString();
    writeFileSync(
      HARNESS_STATE,
      JSON.stringify({
        ses_T43x: { sessionID: "ses_T43x", parentID: null, ctx: 10, updatedAt: iso },
        ses_T43y: { sessionID: "ses_T43y", parentID: "ses_T43x", ctx: 20, updatedAt: iso },
      }),
      "utf8",
    );
    assert(mod.pruneSessionState("ses_T43x") === true, "prune must report a write");
    assert(
      mod.writeStateFile("ses_T43y", "model-alpha", "test-provider", 500, 500, 0) === false,
      "a write for a pruned child must be dropped",
    );
    assert(!("ses_T43y" in readRaw()), "the pruned child was recreated");
  });

  check("T43 an in-memory child of a deleted session is blocked too", () => {
    // A child that has no persisted entry yet is invisible to the disk walk; the
    // in-memory parent cache is the only place it exists before its first write.
    mod.sessionParentCache.set("ses_T43m", "ses_T43p");
    assert(mod.pruneSessionState("ses_T43p") === false, "nothing persisted -> no write");
    assert(
      mod.writeStateFile("ses_T43m", "model-alpha", "test-provider", 700, 700, 0) === false,
      "an unpersisted child of a deleted session must not land as a root",
    );
    assert(!("ses_T43m" in readRaw()), "the unpersisted child was written anyway");
    mod.sessionParentCache.delete("ses_T43m");
  });

  check("T43 a busy lock queues the whole subtree for the next write", () => {
    // The lock file is what makes `pruneSessionState` defer: it cannot read the
    // snapshot, so it must queue the ROOT (the subtree is resolved later under
    // the next write's lock), not a flat id it cannot compute.
    const iso = new Date().toISOString();
    writeFileSync(
      HARNESS_STATE,
      JSON.stringify({
        ses_T43q: { sessionID: "ses_T43q", parentID: null, ctx: 10, updatedAt: iso },
        ses_T43qc: { sessionID: "ses_T43qc", parentID: "ses_T43q", ctx: 20, updatedAt: iso },
        ses_T43keeper: { sessionID: "ses_T43keeper", parentID: null, ctx: 30, updatedAt: iso },
      }),
      "utf8",
    );
    const lockFile = `${HARNESS_STATE}.lock`;
    writeFileSync(lockFile, "busy", "utf8");
    try {
      assert(mod.pruneSessionState("ses_T43q") === false, "a busy lock must defer the delete");
      assert("ses_T43q" in readRaw(), "nothing may be deleted without the lock");
    } finally {
      unlinkSync(lockFile);
    }
    // Any later write replays the queued root and its subtree, under its lock.
    assert(
      mod.writeStateFile("ses_T43keeper", "model-alpha", "test-provider", 900, 900, 0) === true,
      "the replaying write must succeed",
    );
    const after = readRaw();
    assert(!("ses_T43q" in after) && !("ses_T43qc" in after), `queued subtree survived: ${Object.keys(after)}`);
    assert(after.ses_T43keeper?.ctx === 900, "the unrelated session must be written");
    // The replay also armed the barrier for the queued subtree.
    assert(
      mod.writeStateFile("ses_T43qc", "model-alpha", "test-provider", 1000, 1000, 0) === false,
      "a replayed child must be behind the barrier",
    );
  });
}

// T44 - the auto-compaction ceiling mirrors the RELEASED core, not PR text or a
// branch head: reserve = max(floor(window * 0.15), window >= 2 * 16_000 ? 16_000
// : 0). The 200k case is the discriminator: the unreleased `v2` branch (and the
// PR #51271 description) would give 20_000 there, i.e. a compact-at point 10k
// above what the shipped host acts on. Offline, so the daily drift-watch is not
// the only guard.
{
  check("T44 compaction ceiling matches released core (15% / 16k / 2x gate)", () => {
    assert(mod.reserveFor(200000) === 30000, `200k window: ${mod.reserveFor(200000)} != 30000`);
    assert(mod.reserveFor(100000) === 16000, `100k window: ${mod.reserveFor(100000)} != 16000`);
    // Exactly at the gate: floor(32000 * 0.15) = 4800, the floor lifts it to 16k.
    assert(mod.reserveFor(32000) === 16000, `32k window: ${mod.reserveFor(32000)} != 16000`);
    // One token below the gate: the share only (floor(31999 * 0.15) = 4799).
    assert(mod.reserveFor(31999) === 4799, `31999 window: ${mod.reserveFor(31999)} != 4799`);
    // A buffer replaces the whole reserve only while it leaves room.
    assert(mod.reserveFor(200000, 50000) === 50000, "an override must replace the share");
    assert(mod.reserveFor(200000, 200000) === 30000, "a buffer >= window must be ignored");
    assert(mod.reserveFor(0) === null, "a non-positive window must be unmeasurable");
  });
}

if (failed) fatal(`${failed} unit test(s) failed`);
pass(`all ${ranChecks} unit checks passed (T1-T44)`);

// ---------------------------------------------------------------------------
// (e) corporate-identifier scan — no employer/vendor-specific names may appear
// in the published surface (index.js, tui.ts, lib/, README.md, package.json)
// or anywhere in the test tree.  The pattern is assembled from string
// fragments so this guard's own source cannot trip the check it performs.
// ---------------------------------------------------------------------------
console.log("\n(e) corporate-identifier scan...");
const FORBIDDEN = new RegExp(
  ["la" + "nit", "d" + "ks", "deep" + "seek"].join("|"),
  "i",
);
const scanFiles = [
  "index.js",
  "tui.ts",
  "README.md",
  "package.json",
  "CHANGELOG.md",
  "vite.gui.config.mjs",
  "tsconfig.gui.json",
];
for (const dir of ["lib", "test", "gui"]) {
  const abs = join(repoRoot, dir);
  if (!existsSync(abs)) continue;
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    if (ent.isFile()) scanFiles.push(`${dir}/${ent.name}`);
  }
}
// docs/ holds images only (gate (a) enforces it).

const hits = [];
for (const rel of scanFiles) {
  let text;
  try { text = readFileSync(join(repoRoot, rel), "utf8"); } catch { continue; }
  text.split("\n").forEach((line, i) => {
    if (FORBIDDEN.test(line)) hits.push(`${rel}:${i + 1}`);
  });
}
if (hits.length) {
  fatal(`corporate identifier(s) found in repo (${hits.length}): ${hits.join(", ")}`);
}
pass(`no corporate identifiers in ${scanFiles.length} scanned files`);

// ---------------------------------------------------------------------------
// (f) non-English scan. The plugin code and its published surface must contain
// nothing in any language other than English. Implementation: flag any
// non-ASCII LETTER (\p{L} with a code point above U+007F) — this catches
// Cyrillic/CJK/Arabic/etc. words while allowing typographic punctuation
// (em-dash, ellipsis, arrows, checkmarks) that English text legitimately uses.
// The regex uses \u escapes and \p classes only — this source can never trip
// itself (same trick as the corporate-identifier guard above).
// ---------------------------------------------------------------------------
console.log("\n(f) non-English scan...");
const NON_ASCII = /[^\x00-\x7F]/;
const NON_ASCII_LETTER = /\p{L}/u;
const nonEnglishHits = [];
for (const rel of scanFiles) {
  let text;
  try { text = readFileSync(join(repoRoot, rel), "utf8"); } catch { continue; }
  text.split("\n").forEach((line, i) => {
    if (!NON_ASCII.test(line)) return;
    for (const ch of line) {
      if (ch.codePointAt(0) > 0x7f && NON_ASCII_LETTER.test(ch)) {
        nonEnglishHits.push(`${rel}:${i + 1}`);
        break;
      }
    }
  });
}
if (nonEnglishHits.length) {
  fatal(
    `non-English (non-ASCII letter) text found in repo (${nonEnglishHits.length}): ` +
      `${nonEnglishHits.slice(0, 10).join(", ")}${nonEnglishHits.length > 10 ? " ..." : ""}`,
  );
}
pass(`no non-ASCII letters in ${scanFiles.length} scanned files`);

// ---------------------------------------------------------------------------
// (g) Desktop GUI bundle (./gui-experimental)
//
// The app loads ONE prebuilt CommonJS file and provides solid-js, the GUI SDK,
// the client, Effect and Electron/Node built-ins itself. Bundling any of them
// (or a second copy of Solid) desynchronises the app's instances, and a bare
// `opencode`/`@opentui` import cannot resolve at all in the window. The Vite
// preset already fails the build for most of these; this gate re-checks the
// artifact that actually ships, because the bundle is a build output that can
// go stale, be hand-edited, or be produced by a different config.
// ---------------------------------------------------------------------------
console.log("\n(g) Desktop GUI bundle...");
{
  const bundleRel = "dist/gui-experimental.cjs";
  const bundleAbs = join(repoRoot, bundleRel);
  if (!existsSync(bundleAbs)) {
    fatal(`${bundleRel} is missing - run: npm run build:gui`);
  }
  const bundle = readFileSync(bundleAbs, "utf8");
  if (bundle.length < 4000) {
    fatal(`${bundleRel} looks truncated (${bundle.length} bytes) - rebuild it`);
  }
  // CommonJS, single file: no ESM import statements, no dynamic import left.
  if (/^\s*import\s/m.test(bundle)) {
    fatal(`${bundleRel} still contains ESM import statements - not a CJS bundle`);
  }
  if (/\bimport\s*\(/.test(bundle)) {
    fatal(`${bundleRel} contains a dynamic import() - the app loads no second chunk`);
  }
  if (!bundle.includes("exports.default")) {
    fatal(`${bundleRel} has no default export (Plugin.define)`);
  }
  // Every module the app provides must stay a require(); a bundled copy would be
  // a second instance.
  for (const spec of ["solid-js", "solid-js/web", "@opencode/plugin/gui", "@opencode/plugin/rpc"]) {
    if (!bundle.includes(`require("${spec}")`)) {
      fatal(`${bundleRel} does not require the app-provided "${spec}" - bundled copy?`);
    }
  }
  // Modules the window cannot resolve: the TUI renderer and a bare opencode
  // specifier (also a regression guard for copy-pasted TUI code).
  for (const [needle, why] of [
    ["react/jsx-runtime", "React JSX runtime (Solid pragma missing)"],
    ["@opentui", "OpenTUI (a TUI-only renderer, not available in a window)"],
  ]) {
    if (bundle.includes(needle)) fatal(`${bundleRel} contains ${why}`);
  }
  if (/["']opencode(\/|["'])/.test(bundle)) {
    fatal(`${bundleRel} imports a bare 'opencode' specifier - not provided in a window`);
  }
  // Node built-ins are only available to the main process, never to a window
  // render; the bundle must not require them at all (it has no main entry).
  if (/require\("(node:)?(fs|os|path|url|module|child_process|worker_threads)"\)/.test(bundle)) {
    fatal(`${bundleRel} requires a Node built-in - a window cannot resolve it`);
  }
  // Build-output freshness: the bundle must be at least as new as every source
  // file it inlines. CI rebuilds right before this gate, but a manual
  // `node test/prepublish.mjs` without `npm run build:gui` would otherwise
  // validate (and let a publisher ship) a stale artifact.
  const bundleMtime = statSync(bundleAbs).mtimeMs;
  for (const rel of [
    "gui/index.tsx",
    "gui/panel.tsx",
    "lib/rpc.js",
    "lib/format.js",
  ]) {
    const srcAbs = join(repoRoot, rel);
    if (!existsSync(srcAbs)) fatal(`${rel} is missing - the GUI sources moved?`);
    if (statSync(srcAbs).mtimeMs > bundleMtime) {
      fatal(`${bundleRel} is older than ${rel} - run: npm run build:gui`);
    }
  }
  pass(
    `bundle: ${bundleRel} (${(bundle.length / 1024).toFixed(1)} kB, CJS, app-provided externals kept, newer than its sources)`,
  );
}

// ---------------------------------------------------------------------------
// (h) Desktop GUI runtime smoke (./gui-experimental, built bundle)
//
// Gate (g) only inspects the bundle as TEXT. A regression can still be a
// runtime one: a renamed host member (`ctx.add` -> `ctx.register`), a missing
// export, a wrong entry shape, or a pill that never renders. This gate LOADS the
// shipped artifact with synthetic host modules (the window provides them for
// real) and runs setup() against a fake context, exactly like the app's first
// window would.
//
// The stubs stand in for code the window injects: solid-js / solid-js/web (the
// renderer's reactive core), @opencode/plugin/gui (the contribution kinds and
// Plugin.define) and @opencode/plugin/rpc (Rpc.define). Everything else in the
// bundle is the real shipped code.
// ---------------------------------------------------------------------------
console.log("\n(h) Desktop GUI runtime smoke...");
{
  const bundleAbs = join(repoRoot, "dist/gui-experimental.cjs");
  if (!existsSync(bundleAbs)) {
    fatal("dist/gui-experimental.cjs is missing - run: npm run build:gui");
  }
  const { default: Module } = await import("node:module");

  // --- synthetic host modules ---------------------------------------------
  const cleanups = [];
  const timers = [];
  const cleared = [];
  const solidWeb = {
    template: () => () => ({ nodeType: 1 }),
    insert: () => {},
    render: () => () => {},
    spread: (props) => props,
    createComponent: (fn) => (fn ? fn() : null),
  };
  const solid = {
    createSignal: (initial) => {
      let value = initial;
      return [() => value, (next) => { value = typeof next === "function" ? next(value) : next; }];
    },
    createEffect: (fn) => { try { fn(); } catch { /* no owner in the stub */ } },
    createMemo: (fn) => fn(),
    onMount: () => {},
    onCleanup: (fn) => cleanups.push(fn),
    Show: () => null,
    For: () => null,
    Index: () => null,
    children: (v) => (typeof v === "function" ? v : () => v),
  };
  // Marker objects: the real host matches these identities; the smoke test only
  // needs distinct, stable values to assert what setup() registered.
  const guiKinds = {
    Panel: { kind: "Panel" },
    MenuItem: { kind: "MenuItem" },
    Command: { kind: "Command" },
    ComposerPill: { kind: "ComposerPill" },
    usePlugin: () => ({ client: null }),
    Plugin: { define: (spec) => spec },
  };
  let rpcDef = null;
  const rpc = {
    Rpc: {
      define: (def) => { rpcDef = def; return def; },
      call: async () => undefined,
    },
  };
  const stubs = new Map([
    ["solid-js", solid],
    ["solid-js/web", solidWeb],
    ["@opencode/plugin/gui", guiKinds],
    ["@opencode/plugin/rpc", rpc],
  ]);

  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  globalThis.setInterval = (fn, ms) => {
    const handle = { fake: true, ms };
    timers.push(handle);
    return handle; // never actually fires: the smoke test drives refreshPill
  };
  globalThis.clearInterval = (handle) => { cleared.push(handle); };

  const restoreGlobals = () => {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  };
  // Every exit path restores the real timer API - including fatal() below, which
  // ends the process. Module._load is restored by the finally around require().
  process.once("exit", restoreGlobals);

  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (stubs.has(request)) return stubs.get(request);
    return realLoad.call(this, request, parent, isMain);
  };
  let gui;
  try {
    gui = createRequire(import.meta.url)(bundleAbs);
  } finally {
    Module._load = realLoad;
  }

  const fail = (msg) => fatal(`(h) ${msg}`);

  const plugin = gui?.default;
  if (!plugin || typeof plugin.setup !== "function") {
    fail("bundle default export has no setup() - Plugin.define shape changed");
  }

  // --- fake host context --------------------------------------------------
  const adds = [];
  const opens = [];
  const fakeRows = [
    {
      sessionID: "ses_smoke", parentID: "", agent: "build", modelID: "model-alpha",
      providerID: "test-provider", ctx: 70, input: 70, usable: 100, reserve: 30,
      user: 1, assistant: 1, reasoning: 0, toolArgs: 0, toolOut: 0,
      system: 1, toolSchemas: 1, other: 66, source: "context-hook",
      updatedAt: "2026-01-01T00:00:00.000Z", stale: false,
    },
  ];
  const ctx = {
    id: "window-smoke",
    add: (kind, factory) => adds.push({ kind, factory }),
    layout: { open: (key, ref, opts) => opens.push({ key, ref, opts }) },
    sessions: { current: () => ({ id: "ses_smoke" }) },
    client: { rpc: (def) => ({ family: async () => ({ rows: fakeRows, def }) }) },
  };

  try {
    plugin.setup(ctx);
  } catch (err) {
    fail(`setup() threw: ${err && err.message ? err.message : err}`);
  }

  // --- registration assertions -------------------------------------------
  const kinds = adds.map((a) => a.kind && a.kind.kind);
  if (kinds.join(",") !== "Panel,MenuItem,Command,ComposerPill") {
    fail(`setup() registered [${kinds.join(", ")}] - expected Panel, MenuItem, Command, ComposerPill`);
  }
  const entryOf = (kind) => adds.find((a) => a.kind && a.kind.kind === kind);

  const panelEntry = entryOf("Panel").factory();
  if (panelEntry.id !== "context" || panelEntry.region !== "side" || panelEntry.wide !== true) {
    fail(`panel entry shape changed: ${JSON.stringify({ id: panelEntry.id, region: panelEntry.region, wide: panelEntry.wide })}`);
  }
  if (typeof panelEntry.render !== "function" || typeof panelEntry.list !== "function") {
    fail("panel entry lost render()/list()");
  }
  if (!Array.isArray(panelEntry.list({ open: [] })) || panelEntry.list({ open: [] }).length !== 0) {
    fail("panel list() must return no tab while the host has not opened it");
  }
  const listed = panelEntry.list({ open: ["context"] });
  if (!Array.isArray(listed) || listed.length !== 1 || listed[0].id !== "context") {
    fail("panel list() must return the Context tab once the host stores its key");
  }
  if (panelEntry.mobile?.kind !== "tab") {
    fail("panel entry lost its narrow-window (mobile) view");
  }

  const menuEntry = entryOf("MenuItem").factory();
  if (menuEntry.menu !== "session.panel" || menuEntry.id !== "context" || typeof menuEntry.run !== "function") {
    fail(`+ menu entry shape changed: ${JSON.stringify({ menu: menuEntry.menu, id: menuEntry.id })}`);
  }
  const cmdEntry = entryOf("Command").factory();
  if (cmdEntry.slash?.name !== "cx" || typeof cmdEntry.run !== "function") {
    fail(`command entry shape changed: ${JSON.stringify({ slash: cmdEntry.slash, id: cmdEntry.id })}`);
  }

  // The RPC contract the window talks to must still be defined with the family
  // method; the server side (gate d / T30) owns the row schema itself.
  if (!rpcDef || rpcDef.id !== "context-indicator" || !rpcDef.methods?.family) {
    fail("DesktopContextRpc definition missing from the bundle");
  }

  // --- pill behaviour -----------------------------------------------------
  const pillEntry = entryOf("ComposerPill").factory();
  if (typeof pillEntry.show !== "function" || pillEntry.id !== "usage") {
    fail("composer pill entry shape changed");
  }
  if (timers.length !== 1 || timers[0].ms !== 5000) {
    fail(`pill poll must schedule exactly one 5000 ms timer, got ${JSON.stringify(timers.map((t) => t.ms))}`);
  }
  // refreshPill() was started by setup(): let its promise chain settle.
  await new Promise((resolve) => setImmediate(resolve));
  const pill = pillEntry.show({ session: { id: "ses_smoke" } });
  if (!pill || pill.label !== "70% ctx") {
    fail(`pill label for 70/100 not "70% ctx": ${JSON.stringify(pill && pill.label)}`);
  }
  if (pill.tone !== "warning") {
    fail(`70% must be the warning tone, got ${String(pill.tone)}`);
  }
  if (pillEntry.show({ session: { id: "ses_other" } }) !== undefined) {
    fail("pill must not describe a session it did not measure");
  }
  // run() of the + menu item opens the stored layout key.
  menuEntry.run();
  if (opens.length !== 1 || opens[0].key !== "window-smoke:context" || opens[0].opts?.tab !== "select") {
    fail(`panel open() called layout.open wrongly: ${JSON.stringify(opens)}`);
  }
  // onCleanup must stop the poll (the host disposes the window).
  cleanups.forEach((fn) => fn());
  if (cleared.length !== 1 || cleared[0] !== timers[0]) {
    fail("onCleanup did not clear the pill poll timer");
  }

  restoreGlobals();
  pass("bundle loads, setup() registers panel/menu/command/pill, pill renders (70% ctx, warning)");
}



// Cleanup the isolated harness files only — never the live state.json/log.
try { unlinkSync(HARNESS_STATE); } catch { /* ok */ }
try { unlinkSync(`${HARNESS_STATE}.lock`); } catch { /* ok */ }
try { unlinkSync(join(tmpdir(), "oci-prepublish-log.log")); } catch { /* ok */ }
try { unlinkSync(join(tmpdir(), "oci-prepublish-log.log.lock")); } catch { /* ok */ }

console.log("\n[prepublish OK] All gates passed.\n");
