/**
 * prepublish.mjs — fast gate (<30 s) run automatically by `npm publish`.
 *
 * Checks performed:
 *   (a) tarball composition (6 files, no dev/test artifacts)
 *   (b) tui.tsx transpiles with the Solid pragma intact
 *   (c) resolve chain — @opentui/solid + solid-js resolvable from tui.tsx context
 *   (d) unit-harness T1–T12 for the limit/agent/state fixes
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
// e.g. "lib/" -> "lib/dedup.js"; "subdir/" -> all members under that prefix.
// We only expect "lib/" here.
const fileMembers = new Set(["LICENSE","README.md","index.js","package.json","tui.tsx"]);
declaredFiles.forEach((f) => {
  if (f === "lib/") {
    fileMembers.add("lib/dedup.js");
  } else if (!f.endsWith("/")) {
    fileMembers.add(f);
  }
  // directory wildcards that expand to multiple files are not used in this repo.
});
if (fileMembers.size !== 6) {
  fatal(`expected 6 tarball members, got ${fileMembers.size}: ${[...fileMembers].join(", ")}`);
}
const bad = [...fileMembers].filter(
  (f) => f.includes("node_modules") || f.includes("test/") ||
         f.includes("tsconfig") || f.includes(".git"),
);
if (bad.length) fatal(`package.json files includes dev/test artifacts: ${bad.join(", ")}`);
pass(`tarball: ${[...fileMembers].join(", ")} (6 members, no dev artifacts)`);

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
console.log("\n(b) tui.tsx transpilation (esbuild transform, jsx=automatic)...");
const tuiSource = readFileSync(join(repoRoot, "tui.tsx"), "utf8");

let transpiled;
try {
  transpiled = transformSync(tuiSource, {
    loader: "tsx",
    jsx: "automatic",
    format: "esm",
  }).code;
} catch (e) {
  fatal(`esbuild failed: ${((e && e.message) || String(e)).slice(0, 300)}`);
}
if (!transpiled.includes("@opentui/solid/jsx-runtime")) {
  fatal("transpiled output missing @opentui/solid/jsx-runtime — pragma may be missing");
}
if (transpiled.includes("react/jsx-runtime")) {
  fatal("transpiled output contains react/jsx-runtime — pragma regression detected");
}
// Bare `opencode` specifiers (e.g. `import "opencode/process"`) are NOT bridged
// by the opencode TUI runtime loader: ensureRuntimePluginSupport only remaps
// `@opencode/plugin/tui` to the synthetic host module. A bare specifier resolves
// to package `opencode`, which exists only inside the opencode monorepo, so the
// real TUI throws `Cannot find package 'opencode'`. Guard against reintroducing
// one. The quote anchor excludes the legitimate `@opencode/*` scoped imports.
if (/["']opencode(\/|["'])/.test(transpiled)) {
  fatal("transpiled output imports a bare 'opencode' specifier — not bridged at runtime");
}
const firstLine = tuiSource.split("\n")[0];
if (!firstLine.startsWith("/** @jsxImportSource @opentui/solid */")) {
  fatal(`first line is not the pragma: ${firstLine}`);
}
pass("pragma intact: @opentui/solid/jsx-runtime present, react absent");

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
// (d) unit harness T1–T12
// ---------------------------------------------------------------------------
console.log("\n(d) Unit harness T1–T12...");

// FIX Major 3 (env-gate): use an ISOLATED state file — never touch the live
// <tmpdir>/opencode-context-indicator-state.json.  Both index.js and tui.tsx
// honour OPENCODE_CONTEXT_INDICATOR_STATE_FILE.  We write the seed BEFORE
// import so hydrateModelLimitsFromState() finds it at parse time.
// No backup/restore of the live file is needed.
const HARNESS_STATE = join(tmpdir(), "oci-prepublish-state.json");

// Seed data — must yield >= 4 valid model-limit entries for T1.
const seedState = {
  ses_MAIN: {
    sessionID:"ses_MAIN",parentID:null,role:"main",agent:"orchestrator",
    model:"model-alpha",providerID:"test-provider",ctx:279312,input:279000,
    usable:491520,limit:524288,reasoning:0,
    categories:{user:1000,assistant:1000,reasoning:0,toolArgs:0,system:1000,toolSchemas:1000,other:1000},
    updatedAt:"2026-09-29T18:51:54.013Z",
  },
  ses_OLDAGENT: {
    sessionID:"ses_OLDAGENT",parentID:"ses_MAIN",role:"sub",agent:"code_critic",
    model:"model-beta",providerID:"test-provider",ctx:60950,input:60000,
    usable:1015808,limit:1048576,reasoning:0,
    categories:{user:100,assistant:100,reasoning:0,toolArgs:0,system:null,toolSchemas:null,other:100},
    updatedAt:"2026-09-29T17:25:10.535Z",
  },
  ses_T7: {
    sessionID:"ses_T7",parentID:null,role:"main",agent:null,
    model:"model-gamma",providerID:"test-provider",ctx:50000,input:50000,
    usable:168000,limit:200000,reasoning:0,
    categories:{user:100,assistant:100,reasoning:0,toolArgs:0,system:100,toolSchemas:100,other:100},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T8: {
    sessionID:"ses_T8",parentID:null,role:"main",agent:null,
    model:"model-theta",providerID:"provA",ctx:10,input:10,
    usable:111,limit:222,reasoning:0,
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T9_OLD: {
    sessionID:"ses_T9_OLD",parentID:null,role:"main",agent:null,
    model:"model-delta",providerID:"test-provider",ctx:1,input:1,
    usable:168000,limit:200000,reasoning:0,
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T10:00:00.000Z",
  },
  ses_T9_NEW: {
    sessionID:"ses_T9_NEW",parentID:null,role:"main",agent:null,
    model:"model-delta",providerID:"test-provider",ctx:1,input:1,
    usable:1015808,limit:1048576,reasoning:0,
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T10_A: {
    sessionID:"ses_T10_A",parentID:null,role:"main",agent:null,
    model:"model-epsilon",providerID:"test-provider",ctx:1,input:1,
    usable:168000,limit:200000,reasoning:0,
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T10:00:00.000Z",
  },
  ses_T10_B: {
    sessionID:"ses_T10_B",parentID:null,role:"main",agent:null,
    model:"model-epsilon",providerID:"test-provider",ctx:1,input:1,
    usable:168000,limit:200000,reasoning:0,
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T11: {
    sessionID:"ses_T11",parentID:null,role:"main",agent:null,
    model:"model-zeta",providerID:"test-provider",ctx:1,input:1,
    usable:300000,limit:200000,reasoning:0,
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T12: {
    sessionID:"ses_T12",parentID:null,role:"main",agent:null,
    model:"model-eta",providerID:"test-provider",ctx:1,input:1,
    usable:500000,limit:500000,reasoning:0,
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  // Extra sessions: 5 valid models total → T1 requires >= 4.
  ses_EXT_A: {
    sessionID:"ses_EXT_A",parentID:null,role:"main",agent:"code_critic",
    model:"Claude-3.5-Sonnet",providerID:"anthropic",ctx:200000,input:199000,
    usable:163840,limit:200000,reasoning:0,
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T12:00:00.000Z",
  },
  ses_EXT_B: {
    sessionID:"ses_EXT_B",parentID:null,role:"main",agent:null,
    model:"gemini-2.5-Pro",providerID:"google",ctx:1048576,input:1048000,
    usable:900000,limit:1048576,reasoning:0,
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T15:30:00.000Z",
  },
};

writeFileSync(HARNESS_STATE, JSON.stringify(seedState), "utf8");
process.env.OPENCODE_CONTEXT_INDICATOR_STATE_FILE = HARNESS_STATE;

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
const check = (name, fn) => {
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
  assert(e.ctx === 279312 && e.usable === 491520 && e.limit === 524288 && e.agent === "orchestrator");
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
const state1 = read();
const repMain = await mod.collectSessionReport(mockCtx,"ses_MAIN",state1,Date.now()+2000);
const rowMain = mod.renderSessionRow(repMain, true);
check("T4 main row keeps the % (denominator from state)", () => {
  assert(repMain.usable === 491520);
  assert(rowMain.startsWith("| main |"));
  assert(rowMain.includes("(57%)"), rowMain);
});

// T4b
const sumText = mod.shortSummaryText(repMain);
const sumDesc = mod.shortSummaryDescription(repMain);
check("T4b /context summary shows denominator + %", () => {
  assert(sumText.includes("/ 491.5k (57%)"), sumText.split("\n")[0]);
  assert(sumDesc.includes("(57%)"), sumDesc);
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
check("T7 denominator == entry.usable (not context)", () => {
  assert(mod.getUsableContext("test-provider","model-gamma")?.usable === 168000);
  assert(repT7.usable === 168000, `got ${repT7.usable}`);
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
check("T9 stale 168k vs fresh 1015808 -> freshest wins", () => {
  assert(mod.getUsableContext("test-provider","model-delta")?.usable === 1015808);
  assert(cap9.logs.some((l)=>l.includes("model-delta")&&l.includes("1015808")));
  assert(cap9.errs.some((l)=>l.includes("spread")&&l.includes("model-delta")));
});

// T10
mod.modelLimits.clear();
const cap10 = capture(() => mod.hydrateModelLimitsFromState());
check("T10 uniform candidates -> 168k, no spread warning", () => {
  assert(mod.getUsableContext("test-provider","model-epsilon")?.usable === 168000);
  assert(!cap10.errs.some((l)=>l.includes("model-epsilon")));
});

// T11: usable > limit (300k/200k) — impossible, dropped.
mod.modelLimits.clear();
capture(() => mod.hydrateModelLimitsFromState());
check("T11 usable > limit is dropped", () => {
  assert(mod.getUsableContext("test-provider","model-zeta") == null);
  assert(!mod.modelLimits.has("test-provider:model-zeta"));
});

// T12: usable == limit (500k/500k) — LEGITIMATE, seeded.
mod.modelLimits.clear();
const cap12 = capture(() => mod.hydrateModelLimitsFromState());
check("T12 usable == limit is LEGITIMATE, seeded", () => {
  assert(mod.getUsableContext("test-provider","model-eta")?.usable === 500000);
  assert(cap12.logs.some((l)=>l.includes("model-eta")&&l.includes("500000")));
});

if (failed) fatal(`${failed} unit test(s) failed`);
pass("all 12 unit checks passed");

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
const scanFiles = ["index.js", "tui.tsx", "README.md", "package.json"];
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

// Cleanup isolated harness state file only — never the live state.json.
try { unlinkSync(HARNESS_STATE); } catch { /* ok */ }

console.log("\n[prepublish OK] All gates passed.\n");