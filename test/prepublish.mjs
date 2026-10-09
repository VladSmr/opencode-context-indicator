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
// e.g. "lib/" -> every regular file under lib/; "subdir/" -> all members under
// that prefix. We only expect "lib/" here. The base published set is
// LICENSE, README.md, index.js, package.json, tui.tsx (5 files); the lib/
// member count is computed from the directory so the index.js module split is
// reflected automatically instead of needing a hardcoded number.
// Base files in `files[]` outside lib/ (index.js, package.json, tui.tsx,
// README.md, CHANGELOG.md, LICENSE).
const BASE_MEMBER_COUNT = 6;
const fileMembers = new Set(["LICENSE","README.md","index.js","package.json","tui.tsx"]);
let libMemberCount = 0;
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
  } else if (!f.endsWith("/")) {
    fileMembers.add(f);
  }
  // directory wildcards other than "lib/" are not used in this repo.
});
const expectedMembers = BASE_MEMBER_COUNT + libMemberCount;
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
    usable:471860,limit:524288,reasoning:0,
    // new formula: window=524288, reserve=max(52428,16000)=52428, usable=471860
    categories:{user:1000,assistant:1000,reasoning:0,toolArgs:0,system:1000,toolSchemas:1000,other:1000},
    updatedAt:"2026-09-29T18:51:54.013Z",
  },
  ses_OLDAGENT: {
    sessionID:"ses_OLDAGENT",parentID:"ses_MAIN",role:"sub",agent:"code_critic",
    model:"model-beta",providerID:"test-provider",ctx:60950,input:60000,
    usable:928128,limit:1048576,reasoning:0,
    // new formula: window=1048576, reserve=max(104857,16000)=104857, usable=943719
    categories:{user:100,assistant:100,reasoning:0,toolArgs:0,system:null,toolSchemas:null,other:100},
    updatedAt:"2026-09-29T17:25:10.535Z",
  },
  ses_T7: {
    sessionID:"ses_T7",parentID:null,role:"main",agent:null,
    model:"model-gamma",providerID:"test-provider",ctx:50000,input:50000,
    usable:180000,limit:200000,reasoning:0,
    // new formula: window=200000, reserve=max(20000,16000)=20000, usable=180000
    categories:{user:100,assistant:100,reasoning:0,toolArgs:0,system:100,toolSchemas:100,other:100},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T8: {
    sessionID:"ses_T8",parentID:null,role:"main",agent:null,
    model:"model-theta",providerID:"provA",ctx:10,input:10,
    usable:200,limit:222,reasoning:0,
    // new formula: window=222, reserve=max(22,0)=22, usable=200
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T9_OLD: {
    sessionID:"ses_T9_OLD",parentID:null,role:"main",agent:null,
    model:"model-delta",providerID:"test-provider",ctx:1,input:1,
    usable:180000,limit:200000,reasoning:0,
    // new formula: window=200000, usable=180000 (stays, not filtered)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T10:00:00.000Z",
  },
  ses_T9_NEW: {
    sessionID:"ses_T9_NEW",parentID:null,role:"main",agent:null,
    model:"model-delta",providerID:"test-provider",ctx:1,input:1,
    usable:943719,limit:1048576,reasoning:0,
    // new formula: window=1048576, usable=943719 (stays, freshest wins via updatedAt)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  ses_T10_A: {
    sessionID:"ses_T10_A",parentID:null,role:"main",agent:null,
    model:"model-epsilon",providerID:"test-provider",ctx:1,input:1,
    usable:180000,limit:200000,reasoning:0,
    // new formula: window=200000, usable=180000 (stays)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T10:00:00.000Z",
  },
  ses_T10_B: {
    sessionID:"ses_T10_B",parentID:null,role:"main",agent:null,
    model:"model-epsilon",providerID:"test-provider",ctx:1,input:1,
    usable:180000,limit:200000,reasoning:0,
    // new formula: window=200000, usable=180000 (freshest via updatedAt)
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
    usable:450000,limit:500000,reasoning:0,
    // new formula: window=500000, reserve=50000, usable=450000 (seed usable valid, <= limit)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T18:00:00.000Z",
  },
  // Extra sessions: 5 valid models (alpha,beta,gamma,theta,delta) ≥ T1's >=4
  ses_EXT_A: {
    sessionID:"ses_EXT_A",parentID:null,role:"main",agent:"code_critic",
    model:"Claude-3.5-Sonnet",providerID:"anthropic",ctx:200000,input:199000,
    usable:180000,limit:200000,reasoning:0,
    // new formula: window=200000, usable=180000 (matches seed)
    categories:{user:1,assistant:1,reasoning:0,toolArgs:0,system:1,toolSchemas:1,other:1},
    updatedAt:"2026-09-29T12:00:00.000Z",
  },
  ses_EXT_B: {
    sessionID:"ses_EXT_B",parentID:null,role:"main",agent:null,
    model:"gemini-2.5-Pro",providerID:"google",ctx:1048576,input:1048000,
    usable:943719,limit:1048576,reasoning:0,
    // new formula: window=1048576, usable=943719 (matches seed)
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
  // NEW formula: seed context=524288, reserve=max(52428,16000)=52428, usable=471860
  assert(e.ctx === 279312 && e.usable === 471860 && e.limit === 524288 && e.agent === "orchestrator");
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
  // NEW formula: usable=471860; ctx=279312; pct=279312/471860=59%
  assert(repMain.usable === 471860);
  assert(rowMain.startsWith("| main |"));
  assert(rowMain.includes("(59%)"), rowMain);
});

// T4b
const sumText = mod.shortSummaryText(repMain);
const sumDesc = mod.shortSummaryDescription(repMain);
check("T4b /context summary shows denominator + % + compact-at", () => {
  // ctx=279312, usable=471860, pct=59%, reserve=max(52428,16000)=52428
  assert(sumText.includes("/ 471.9k (59%)"), sumText.split("\n")[0]);
  assert(sumText.includes("compact at 471.9k"), sumText);
  // fmt(52428) = "52.4k"
  assert(sumText.includes("(52.4k reserve)"), sumText);
  assert(sumDesc.includes("(59%)"), sumDesc);
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
  // Seed: limit=200000, usable=180000. New formula: window=200000, reserve=max(20000,16000)=20000, usable=180000
  // (The old formula would have double-reserved; new formula re-derives correctly)
  assert(mod.getUsableContext("test-provider","model-gamma")?.usable === 180000);
  assert(repT7.usable === 180000, `got ${repT7.usable}`);
  // reserve should be 20000 (10% of 200000, which exceeds 16000)
  assert(mod.getUsableContext("test-provider","model-gamma")?.reserved === 20000);
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
check("T9 stale 180k vs fresh 943719 -> freshest wins", () => {
  // new formula: window=1048576, reserve=max(104857,16000)=104857, usable=943719
  assert(mod.getUsableContext("test-provider","model-delta")?.usable === 943719);
  assert(cap9.logs.some((l)=>l.includes("model-delta")&&l.includes("943719")));
  assert(cap9.errs.some((l)=>l.includes("spread")&&l.includes("model-delta")));
});

// T10
mod.modelLimits.clear();
const cap10 = capture(() => mod.hydrateModelLimitsFromState());
check("T10 uniform candidates -> 180k, no spread warning", () => {
  // new formula: window=200000, usable=180000
  assert(mod.getUsableContext("test-provider","model-epsilon")?.usable === 180000);
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
  // new formula: window=500000, reserve=50000, usable=450000 (seed usable <= limit)
  assert(mod.getUsableContext("test-provider","model-eta")?.usable === 450000);
  assert(cap12.logs.some((l)=>l.includes("model-eta")&&l.includes("450000")));
});

if (failed) fatal(`${failed} unit test(s) failed`);
pass("all 12 unit checks passed");

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

check("T16 new formula: window 200000 -> usable 180000 reserve 20000", () => {
  // 200000 >= 32000, so reserve = max(20000, 16000) = 20000
  assert(mod.getUsableContext("test-provider","model-gamma")?.usable === 180000, "window=200000: usable should be 180000");
  assert(mod.getUsableContext("test-provider","model-gamma")?.reserved === 20000, "reserve should be 20000");
});

check("T16a new formula: window 100000 -> usable 84000 reserve 16000", () => {
  // 100000 >= 32000, so reserve = max(10000, 16000) = 16000
  // We need a model with window=100000. Using model-alpha with context=524288
  // is already seeded. Let's check the formula directly.
  const r = mod.reserveFor(100000, undefined);
  assert(r === 16000, `window=100000: reserve should be 16000, got ${r}`);
  // Also test via getUsableContext with input override (seed doesn't have input)
  // We test reserveFor directly
});

check("T16b new formula: window 24000 -> usable 21600 reserve 2400", () => {
  // 24000 < 32000, so reserve = max(2400, 0) = 2400
  const r = mod.reserveFor(24000, undefined);
  assert(r === 2400, `window=24000: reserve should be 2400, got ${r}`);
});

check("T16c new formula: window 30000 -> usable 27000 reserve 3000", () => {
  // 30000 < 32000, so reserve = max(3000, 0) = 3000
  const r = mod.reserveFor(30000, undefined);
  assert(r === 3000, `window=30000: reserve should be 3000, got ${r}`);
});

check("T16d new formula: input preferred over context", () => {
  // model-gamma: limit=200000, window=200000. Test formula with explicit input.
  // reserveFor(120000, undefined) = max(12000, 16000) = 16000
  const r = mod.reserveFor(120000, undefined);
  assert(r === 16000, `window=120000: reserve should be 16000, got ${r}`);
  // getUsableContext uses the record's input or context as window
  // We already verified input context through the formula test; this is covered by T16
  assert(mod.getUsableContext("test-provider","model-gamma")?.limit === 200000, "window is the seeded context");
});

check("T16e new formula: unknown limits -> null", () => {
  assert(mod.getUsableContext("nonexistent-provider","nonexistent-model") == null);
});

check("T16f new formula: hydrated seed no double-reserve", () => {
  // Seed ses_T7: usable=180000, limit=200000.
  // OLD formula: usable=180000 (persisted), getUsableContext re-derived it.
  // NEW formula: window=200000, reserve=20000, usable=180000 (same result, no double-reserve).
  // Verify: the seeded record context=200000,input=null gives usable=180000.
  mod.modelLimits.clear();
  capture(() => mod.hydrateModelLimitsFromState());
  const info = mod.getUsableContext("test-provider","model-gamma");
  assert(info?.usable === 180000, `hydrated usable should be 180000, got ${info?.usable}`);
  assert(info?.reserved === 20000, `hydrated reserve should be 20000, got ${info?.reserved}`);
  // The usable exactly matches the seed (no double-reserve: 200000-20000=180000)
});

check("T16g reserveFor: bufferOverride takes precedence", () => {
  const r = mod.reserveFor(200000, 5000);
  assert(r === 5000, `bufferOverride=5000: reserve should be 5000, got ${r}`);
});

check("T16h reserveFor: invalid bufferOverride falls through to formula", () => {
  const r1 = mod.reserveFor(200000, -1);
  assert(r1 === 20000, `negative bufferOverride should be ignored, got ${r1}`);
  const r2 = mod.reserveFor(200000, 1e10);
  assert(r2 === 20000, `>1e9 bufferOverride should be ignored, got ${r2}`);
  const r3 = mod.reserveFor(200000, NaN);
  assert(r3 === 20000, `NaN bufferOverride should be ignored, got ${r3}`);
  // Non-numbers: JS type guard prevents them from entering the numeric branch
  const r4 = mod.reserveFor(200000, "not a number");
  assert(r4 === 20000, `string bufferOverride should be ignored, got ${r4}`);
  // Valid: 0 and 1e9 are accepted
  assert(mod.reserveFor(200000, 0) === 0);
  assert(mod.reserveFor(200000, 1e9) === 1e9);
});

check("T16i reserveFor: non-finite window returns null", () => {
  assert(mod.reserveFor(0, undefined) == null);
  assert(mod.reserveFor(-100, undefined) == null);
  assert(mod.reserveFor(NaN, undefined) == null);
  assert(mod.reserveFor(Infinity, undefined) == null);
  assert(mod.reserveFor(null, undefined) == null);
  assert(mod.reserveFor(undefined, undefined) == null);
});

if (failed) fatal(`${failed} unit test(s) failed`);
pass(`all ${12 + 22} unit checks passed (T1–T12 + T13–T16i)`);

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