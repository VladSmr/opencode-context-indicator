/**
 * prepublish.mjs — fast gate (<30 s) run automatically by `npm publish`.
 *
 * Checks performed:
 *   (a) tarball composition (base files + lib/ + docs/, no dev/test artifacts)
 *   (b) tui.tsx transpiles with the Solid pragma intact
 *   (c) resolve chain — @opentui/solid + solid-js resolvable from tui.tsx context
 *   (d) unit-harness T1–T29 for the limit/agent/state/command fixes
 *   (e) corporate-identifier scan (8 files)
 *   (f) non-English scan — no non-ASCII letters (any language other than
 *       English) anywhere in the published surface or the test tree
 *
 * Skip with:  npm publish --ignore-scripts
 *             (useful for testing the pack output without running checks)
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, readdirSync } from "node:fs";
import { transformSync } from "esbuild";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// repoRoot = parent of the test/ directory (where package.json lives)
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

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
// LICENSE, README.md, index.js, package.json, tui.tsx (5 files); the lib/ and
// docs/ member counts are computed from the directories so module splits and
// added screenshots are reflected automatically instead of needing a hardcoded
// number.
// Base files in `files[]` outside lib/ (index.js, package.json, tui.tsx,
// README.md, CHANGELOG.md, LICENSE).
const BASE_MEMBER_COUNT = 6;
const fileMembers = new Set(["LICENSE","README.md","index.js","package.json","tui.tsx"]);
let libMemberCount = 0;
let docsMemberCount = 0;
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
  } else if (!f.endsWith("/")) {
    fileMembers.add(f);
  }
  // Other directory wildcards are not used in this repo.
});
const expectedMembers = BASE_MEMBER_COUNT + libMemberCount + docsMemberCount;
if (fileMembers.size !== expectedMembers) {
  fatal(`expected ${expectedMembers} tarball members, got ${fileMembers.size}: ${[...fileMembers].join(", ")}`);
}
const bad = [...fileMembers].filter(
  (f) => f.includes("node_modules") || f.includes("test/") ||
         f.includes("tsconfig") || f.includes(".git"),
);
if (bad.length) fatal(`package.json files includes dev/test artifacts: ${bad.join(", ")}`);
pass(`tarball: ${[...fileMembers].join(", ")} (${fileMembers.size} members, no dev artifacts)`);

// ---------------------------------------------------------------------------
// (b) tui.tsx transpilation — pragma regression check
//
// Uses the esbuild PROGRAMMATIC API (transformSync), never `node <cli-bin>`.
// The API resolves the native binary from `@esbuild/<platform>` and spawns it
// as an executable with correct platform semantics (ELF/exe), identically on
// Windows and Linux. The old code ran `node node_modules/esbuild/bin/esbuild`,
// which works on Windows (JS shim) but fails on Linux where that path is the
// native ELF binary — node then parses it as JS and throws
// `SyntaxError: Invalid or unexpected token`.
// ---------------------------------------------------------------------------
console.log("\n(b) tui.tsx + lib/*.tsx transpilation (esbuild transform, jsx=automatic)...");
// The npm path relies on each TUI file's own line-1 pragma (the host skips the
// Solid transform for node_modules paths), so EVERY .tsx of the entry — the
// file itself and the imported components — must carry the pragma and compile
// against @opentui/solid/jsx-runtime. A regression in any one of them would
// ship undetected otherwise.
const tsxFiles = [
  "tui.tsx",
  ...readdirSync(join(repoRoot, "lib"))
    .filter((f) => f.endsWith(".tsx"))
    .sort()
    .map((f) => join("lib", f)),
];
let checked = 0;
for (const rel of tsxFiles) {
  const source = readFileSync(join(repoRoot, rel), "utf8");

  let transpiled;
  try {
    transpiled = transformSync(source, {
      loader: "tsx",
      jsx: "automatic",
      format: "esm",
    }).code;
  } catch (e) {
    fatal(`esbuild failed for ${rel}: ${((e && e.message) || String(e)).slice(0, 300)}`);
  }
  if (!transpiled.includes("@opentui/solid/jsx-runtime")) {
    fatal(`${rel}: transpiled output missing @opentui/solid/jsx-runtime — pragma may be missing`);
  }
  if (transpiled.includes("react/jsx-runtime")) {
    fatal(`${rel}: transpiled output contains react/jsx-runtime — pragma regression detected`);
  }
  // Bare `opencode` specifiers (e.g. `import "opencode/process"`) are NOT bridged
  // by the opencode TUI runtime loader: ensureRuntimePluginSupport only remaps
  // `@opencode/plugin/tui` to the synthetic host module. A bare specifier resolves
  // to package `opencode`, which exists only inside the opencode monorepo, so the
  // real TUI throws `Cannot find package 'opencode'`. Guard against reintroducing
  // one. The quote anchor excludes the legitimate `@opencode/*` scoped imports.
  if (/["']opencode(\/|["'])/.test(transpiled)) {
    fatal(`${rel}: transpiled output imports a bare 'opencode' specifier — not bridged at runtime`);
  }
  const firstLine = source.split("\n")[0];
  if (!firstLine.startsWith("/** @jsxImportSource @opentui/solid */")) {
    fatal(`${rel}: first line is not the pragma: ${firstLine}`);
  }
  checked++;
}
pass(`pragma intact in ${checked} tsx file(s): @opentui/solid/jsx-runtime present, react absent`);

// ---------------------------------------------------------------------------
// (c) resolve chain — @opentui/solid + solid-js resolvable from tui.tsx context
// ---------------------------------------------------------------------------
console.log("\n(c) resolve chain — @opentui/solid + solid-js...");
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
  console.log(`  ✓ @opentui/solid/jsx-runtime resolved`);
  console.log(`  ✓ solid-js resolved`);
}

// ---------------------------------------------------------------------------
// (d) unit harness T1–T12 + T13+ (contributors.js extraction)
// ---------------------------------------------------------------------------
console.log("\n(d) Unit harness T1–T12 + T13+...");

// FIX Major 3 (env-gate): use an ISOLATED state file — never touch the live
// <tmpdir>/opencode-context-indicator-state.json.  Both index.js and tui.tsx
// honour OPENCODE_CONTEXT_INDICATOR_STATE_FILE.  We write the seed BEFORE
// import so hydrateModelLimitsFromState() finds it at parse time.
// No backup/restore of the live file is needed.
const HARNESS_STATE = join(tmpdir(), "oci-prepublish-state.json");

// Seed data — must yield >= 4 valid model-limit entries for T1.
// NOTE: seed usable/limit are the OLD persisted values used by hydrateModelLimitsFromState.
// The new formula derives usable = window - reserve, so the seed usable must NOT exceed
// the NEW formula ceiling. All entries here are designed so new usable <= seed limit.
const seedState = {
  ses_MAIN: {
    sessionID:"ses_MAIN",parentID:null,role:"main",agent:"orchestrator",
    model:"model-alpha",providerID:"test-provider",ctx:279312,input:279000,
    usable:445645,limit:524288,reasoning:0,
    // new formula: window=524288, reserve=max(78643,16000)=78643, usable=445645
    categories:{user:1000,assistant:1000,reasoning:0,toolArgs:0,system:1000,toolSchemas:1000,other:1000},
    updatedAt:"2026-09-29T18:51:54.013Z",
  },
  ses_OLDAGENT: {
    sessionID:"ses_OLDAGENT",parentID:"ses_MAIN",role:"sub",agent:"code_critic",
    model:"model-beta",providerID:"test-provider",ctx:60950,input:60000,
    usable:891290,limit:1048576,reasoning:0,
    // new formula: window=1048576, reserve=max(157286,16000)=157286, usable=891290
    categories:{user:100,assistant:100,reasoning:0,toolArgs:0,system:null,toolSchemas:null,other:100},
    updatedAt:"2026-09-29T17:25:10.535Z",
  },
  ses_T7: {
    sessionID:"ses_T7",parentID:null,role:"main",agent:null,
    model:"model-gamma",providerID:"test-provider",ctx:50000,input:50000,
    usable:170000,limit:200000,reasoning:0,
    // new formula: window=200000, reserve=max(30000,16000)=30000, usable=170000
    categories:{user:100,assistant:100,reasoning:0,toolArgs:0,system:100,toolSchemas:100,other:100},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T8: {
    sessionID:"ses_T8",parentID:null,role:"main",agent:null,
    model:"model-theta",providerID:"provA",ctx:10,input:10,
    usable:189,limit:222,reasoning:0,
    // new formula: window=222, reserve=max(33,0)=33, usable=189
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T9_OLD: {
    sessionID:"ses_T9_OLD",parentID:null,role:"main",agent:null,
    model:"model-delta",providerID:"test-provider",ctx:1,input:1,
    usable:170000,limit:200000,reasoning:0,
    // new formula: window=200000, usable=170000 (stays, not filtered)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T10:00:00.000Z",
  },
  ses_T9_NEW: {
    sessionID:"ses_T9_NEW",parentID:null,role:"main",agent:null,
    model:"model-delta",providerID:"test-provider",ctx:1,input:1,
    usable:891290,limit:1048576,reasoning:0,
    // new formula: window=1048576, usable=891290 (stays, freshest wins via updatedAt)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T10_A: {
    sessionID:"ses_T10_A",parentID:null,role:"main",agent:null,
    model:"model-epsilon",providerID:"test-provider",ctx:1,input:1,
    usable:170000,limit:200000,reasoning:0,
    // new formula: window=200000, usable=170000 (stays)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T10:00:00.000Z",
  },
  ses_T10_B: {
    sessionID:"ses_T10_B",parentID:null,role:"main",agent:null,
    model:"model-epsilon",providerID:"test-provider",ctx:1,input:1,
    usable:170000,limit:200000,reasoning:0,
    // new formula: window=200000, usable=170000 (freshest via updatedAt)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T11: {
    sessionID:"ses_T11",parentID:null,role:"main",agent:null,
    model:"model-zeta",providerID:"test-provider",ctx:1,input:1,
    usable:300000,limit:200000,reasoning:0,
    // new formula: usable > limit => filtered (T11 unchanged)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T12: {
    sessionID:"ses_T12",parentID:null,role:"main",agent:null,
    model:"model-eta",providerID:"test-provider",ctx:1,input:1,
    usable:425000,limit:500000,reasoning:0,
    // new formula: window=500000, reserve=75000, usable=425000 (seed usable valid, <= limit)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  // Extra sessions: 5 valid models (alpha,beta,gamma,theta,delta) ≥ T1's >=4
  ses_EXT_A: {
    sessionID:"ses_EXT_A",parentID:null,role:"main",agent:"code_critic",
    model:"Claude-3.5-Sonnet",providerID:"anthropic",ctx:200000,input:199000,
    usable:170000,limit:200000,reasoning:0,
    // new formula: window=200000, usable=170000 (matches seed)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T12:00:00.000Z",
  },
  ses_EXT_B: {
    sessionID:"ses_EXT_B",parentID:null,role:"main",agent:null,
    model:"gemini-2.5-Pro",providerID:"google",ctx:1048576,input:1048000,
    usable:891290,limit:1048576,reasoning:0,
    // new formula: window=1048576, usable=891290 (matches seed)
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

// Age-immunity refresh: the state.js tombstone prune (PRUNE_AFTER_MS = 30
// days) would eventually eat the hardcoded 2026-09-29 seed dates and break
// the suite. Re-stamp every seeded entry (except the T17 pair, which manages
// its own dates) to ~10 days ago, preserving the original relative ordering
// — T9_OLD/T9_NEW and T10_A/T10_B freshest-wins semantics stay intact.
{
  const exempt = new Set(["ses_T17_OLD", "ses_T17_FRESH"]);
  const stampable = Object.entries(seedState)
    .filter(([k, v]) => !exempt.has(k) && Number.isFinite(Date.parse(v.updatedAt)))
    .sort((a, b) => Date.parse(a[1].updatedAt) - Date.parse(b[1].updatedAt));
  const base = Date.now() - 10 * 86400e3;
  stampable.forEach(([k, v], i) => {
    seedState[k].updatedAt = new Date(base + i * 60000).toISOString();
  });
}

writeFileSync(HARNESS_STATE, JSON.stringify(seedState), "utf8");
process.env.OPENCODE_CONTEXT_INDICATOR_STATE_FILE = HARNESS_STATE;
// Same isolation for the human-readable log: idle/compacted handlers rewrite
// it, so point them at a throwaway file instead of the user's real one.
process.env.OPENCODE_CONTEXT_INDICATOR_LOG_FILE = join(tmpdir(), "oci-prepublish-log.log");

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
  // NEW formula: seed context=524288, reserve=max(78643,16000)=78643, usable=445645
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
const rowMain = mod.renderSessionRow(repMain, true);
check("T4 main row keeps the % (denominator from state)", () => {
  // NEW formula: usable=445645; ctx=279312; pct=279312/445645=63%
  assert(repMain.usable === 445645);
  assert(rowMain.startsWith("| main |"));
  assert(rowMain.includes("(63%)"), rowMain);
});

// T4b
const sumText = mod.shortSummaryText(repMain);
const sumDesc = mod.shortSummaryDescription(repMain);
check("T4b /context summary shows denominator + % + compact-at", () => {
  // ctx=279312, usable=445645, pct=63%, reserve=max(78643,16000)=78643
  assert(sumText.includes("/ 445.6k (63%)"), sumText.split("\n")[0]);
  assert(sumText.includes("compact at 445.6k"), sumText);
  // fmt(78643) = "78.6k"
  assert(sumText.includes("(78.6k reserve)"), sumText);
  assert(sumDesc.includes("(63%)"), sumDesc);
});

// T5
const repSub = await mod.collectSessionReport(mockCtx,"ses_OLDAGENT",state1,Date.now()+2000);
const rowSub = mod.renderSessionRow(repSub, false);
check("T5 old record shows sub:<agent> label", () => {
  assert(repSub.agent === "code_critic");
  assert(rowSub.includes("sub:code_critic"), rowSub);
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
  // Seed: limit=200000, usable=170000. New formula: window=200000, reserve=max(30000,16000)=30000, usable=170000
  // (The old formula would have double-reserved; new formula re-derives correctly)
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
  // new formula: window=1048576, reserve=max(157286,16000)=157286, usable=891290
  assert(mod.getUsableContext("test-provider","model-delta")?.usable === 891290);
  assert(cap9.logs.some((l)=>l.includes("model-delta")&&l.includes("891290")));
  assert(cap9.errs.some((l)=>l.includes("spread")&&l.includes("model-delta")));
});

// T10
mod.modelLimits.clear();
const cap10 = capture(() => mod.hydrateModelLimitsFromState());
check("T10 uniform candidates -> 170k, no spread warning", () => {
  // new formula: window=200000, usable=170000
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

// T12: usable < limit (450k/500k) — LEGITIMATE, seeded.
mod.modelLimits.clear();
const cap12 = capture(() => mod.hydrateModelLimitsFromState());
check("T12 usable < limit is LEGITIMATE, seeded", () => {
  // new formula: window=500000, reserve=75000, usable=425000 (seed usable <= limit)
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
  const root = { model: "your-model", providerID: "your-provider", ctx: 100000, usable: 180000, limit: 200000, updatedAt: "2026-10-08T14:25:00.000Z" };
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
    { model: "main-model", ctx: 100, usable: 180000, limit: 200000, updatedAt: "2026-10-08T00:00:00.000Z" },
    { model: "sub-model", ctx: 50, usable: 180000, limit: 200000, updatedAt: "2026-10-08T00:01:00.000Z" },
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
  // 200000 >= 32000, so reserve = max(30000, 16000) = 30000 (core 2.1.4: 15%)
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

check("T16d new formula: input preferred over context", () => {
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
    usable: 180000, limit: 200000, reasoning: 0,
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

check("T19a stale surface: summary + table row show the marker", () => {
  const report = {
    sessionID: "ses_T19", modelID: "model-alpha", providerID: "test-provider",
    ctxTokens: 480, usable: 180000, reserve: 18000,
    categories: { user: 1, assistant: 1, reasoning: 0, toolArgs: 0, toolOut: 0, system: 1, toolSchemas: 1, other: 0 },
    toolOutByTool: null, compactStale: true, source: "snapshot",
    updatedAt: new Date().toISOString(),
  };
  assert(mod.shortSummaryText(report).includes("stale — compacted"), "summary carries the marker");
  assert(mod.renderSessionRow(report, true).includes("(stale)"), "table row carries the marker");
  const clean = { ...report, compactStale: false };
  assert(!mod.shortSummaryText(clean).includes("stale"), "clean summary has no marker");
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

check("T20c toolOutByTool: persisted end-to-end and rendered in the breakdown", () => {
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
  const e = read().ses_T20C;
  assert(e.toolOutByTool && e.toolOutByTool.webfetch === 100, `webfetch 100 persisted, got ${e.toolOutByTool?.webfetch}`);
  assert(e.toolOutByTool.read === 10, "read 10 persisted");
  const row = mod.renderSessionRow({ sessionID: "ses_T20C", modelID: "model-alpha", ctxTokens: 1000, usable: 180000, categories: e.categories, toolOutByTool: e.toolOutByTool, source: "snapshot", updatedAt: e.updatedAt }, true);
  const table = mod.renderBreakdownTable([row], 0, { toolOutByTool: e.toolOutByTool });
  assert(table.includes("Tool results by tool (main)"), "by-tool section present");
  assert(table.includes("webfetch 100"), `by-tool line lists webfetch 100: ${table.split("\n").slice(-1)[0]}`);
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
check("T23a prompt cache: surfaced in the report / table / summary", () => {
  assert(mod.lastKnownCacheRead("ses_none") === null, "accessor -> null when unknown");
  assert(repT23.cacheRead === 600 && repT23.cacheWrite === 200, `report carries cache, got ${repT23.cacheRead}/${repT23.cacheWrite}`);
  const table = mod.renderBreakdownTable([], 0, repT23);
  assert(table.includes("Prompt cache"), "table has a prompt-cache section");
  assert(table.includes("read 600"), `table shows read 600: ${table}`);
  assert(mod.shortSummaryText(repT23).includes("prompt cache"), "summary shows the cache line");
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

check("T24c waste persisted path-free + rendered", () => {
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
  const e = read().ses_T24C;
  assert(e.reclaim && e.reclaim.tokens === 100, `reclaim persisted, got ${JSON.stringify(e.reclaim)}`);
  const findings = e.reclaim.findings || [];
  assert(findings.length >= 1, "at least one finding");
  for (const f of findings) {
    assert(!Object.prototype.hasOwnProperty.call(f, "target"), "persisted findings are path-free (no target)");
  }
  const rep = {
    sessionID: "ses_T24C", modelID: "model-alpha", providerID: "test-provider",
    ctxTokens: 1000, inputTokens: 1000, usable: 180000, reserve: 18000,
    categories: e.categories, toolOutByTool: e.toolOutByTool, reclaim: e.reclaim,
    cacheRead: null, cacheWrite: null, compactStale: false, source: "snapshot",
    updatedAt: e.updatedAt,
  };
  const table = mod.renderBreakdownTable([], 0, rep);
  assert(table.includes("Potential reclaim"), "table has a reclaim section");
  assert(table.includes("read x2"), `reclaim line lists read x2: ${table}`);
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
check("T25c compaction hook: cold last-known cache does not clobber ctx (no write)", () => {
  assert(t25cErr.length === 0, `no errors: ${t25cErr.join(" | ")}`);
  assert(t25c.ctx === 5000, `ctx preserved, got ${t25c.ctx}`);
  assert(t25c.compactStale === false && !t25c.compactedAt, "no stale mark when nothing was measured");
});

// ---- T26-T28: compaction reserve, top consumers, /context-diff ----

const cacheMod = await import(pathToFileURL(join(repoRoot, "lib", "cache.js")).href);

check("T26 reserve formula mirrors opencode 2.1.4 (0.15 share, 16k floor, 32k gate)", () => {
  const cases = [
    [200000, 30000],
    [524288, 78643],
    [1048576, 157286],
    [100000, 16000],
    [32000, 16000],
    [31999, 4799],
    [1000, 150],
    [1, 0],
  ];
  for (const [win, want] of cases) {
    const got = mod.reserveFor(win, undefined);
    assert(got === want, `window=${win}: reserve ${got} !== ${want}`);
  }
});

// T27 — top-5 heaviest single items: live estimate -> persisted (path-free) ->
// rendered section.
const t27Context = {
  messages: [
    { role: "user", content: [{ type: "text", text: "u".repeat(4000) }] }, // 1000
    {
      role: "assistant",
      content: [
        { type: "tool-call", id: "c1", name: "read", input: { filePath: "src/abc.ts" } },
        { type: "tool-result", id: "c1", name: "read", result: { type: "text", value: "r".repeat(8000) } }, // 2000
        { type: "reasoning", text: "x".repeat(2000) }, // 500
        { type: "text", text: "a".repeat(1000) }, // 250
      ],
    },
  ],
  system: [{ type: "text", text: "s".repeat(400) }], // 100
  tools: {},
};
const t27Parts = mod.estimateBreakdownFromContext(t27Context, null);
check("T27 top consumers: heaviest first, bounded to 5, targets on live data", () => {
  assert(Array.isArray(t27Parts.top) && t27Parts.top.length === 5, `got ${t27Parts.top?.length}`);
  assert(t27Parts.top[0].kind === "tool" && t27Parts.top[0].tokens === 2000, JSON.stringify(t27Parts.top[0]));
  assert(t27Parts.top[0].name === "read" && t27Parts.top[0].target === "src/abc.ts");
  assert(t27Parts.top[1].kind === "user" && t27Parts.top[1].tokens === 1000);
  assert(t27Parts.top[2].kind === "reasoning" && t27Parts.top[2].tokens === 500);
  const kinds = t27Parts.top.map((t) => t.kind);
  assert(kinds.includes("system") || kinds.includes("assistant"), kinds.join(","));
});

check("T27a top consumers: persisted copy is path-free and sanitised", () => {
  cacheMod.breakdownCache.set("ses_TOP", {
    ...t27Parts,
    capturedAt: Date.now(),
    source: "context-hook",
  });
  mod.writeStateFile("ses_TOP", "model-gamma", "test-provider", 6000, 6000, 0);
  const e = read().ses_TOP;
  assert(Array.isArray(e.top) && e.top.length === 5, `persisted top: ${JSON.stringify(e.top)}`);
  assert(e.top[0].kind === "tool" && e.top[0].tokens === 2000);
  assert(!("target" in e.top[0]), "target must not be persisted");
  assert(!JSON.stringify(e.top).includes("src/abc.ts"), "no path leaked into state.json");
});

const t27Report = await mod.collectSessionReport(mockCtx, "ses_TOP", read(), 0);
const t27Table = mod.renderBreakdownTable(
  [mod.renderSessionRow(t27Report, true)],
  0,
  t27Report,
);
check("T27b top consumers: rendered section uses live targets + input share", () => {
  assert(t27Report.top && t27Report.top[0].target === "src/abc.ts", "live cache keeps the target");
  assert(t27Table.includes("### Top context consumers (main)"), t27Table);
  assert(t27Table.includes("tool result · read src/abc.ts"), t27Table);
  assert(t27Table.includes("~2.0k (33% of input)"), t27Table);
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

if (failed) fatal(`${failed} unit test(s) failed`);
pass(`all ${ranChecks} unit checks passed (T1-T12 + T13-T29)`);

// ---------------------------------------------------------------------------
// (e) corporate-identifier scan — no employer/vendor-specific names may appear
// in the published surface (index.js, tui.tsx, lib/, README.md, package.json)
// or anywhere in the test tree.  The pattern is assembled from string
// fragments so this guard's own source cannot trip the check it performs.
// ---------------------------------------------------------------------------
console.log("\n(e) corporate-identifier scan...");
const FORBIDDEN = new RegExp(
  ["la" + "nit", "d" + "ks", "deep" + "seek"].join("|"),
  "i",
);
const scanFiles = ["index.js", "tui.tsx", "README.md", "package.json", "CHANGELOG.md"];
for (const dir of ["lib", "test"]) {
  const abs = join(repoRoot, dir);
  if (!existsSync(abs)) continue;
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    if (ent.isFile()) scanFiles.push(`${dir}/${ent.name}`);
  }
}
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

// Cleanup the isolated harness files only — never the live state.json/log.
try { unlinkSync(HARNESS_STATE); } catch { /* ok */ }
try { unlinkSync(join(tmpdir(), "oci-prepublish-log.log")); } catch { /* ok */ }

console.log("\n[prepublish OK] All gates passed.\n");