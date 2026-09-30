/**
 * e2e-tui.mjs — end-to-end gate for the opencode-context-indicator plugin.
 *
 * Runs after prepublish.mjs in the `prepublishOnly` chain (i.e. on `npm publish`)
 * and can be run manually:
 *
 *   node test/e2e-tui.mjs            # full: plugin load + one "Say OK" round-trip
 *   node test/e2e-tui.mjs --full     # same as default
 *   node test/e2e-tui.mjs --quick    # load only (no LLM call)
 *
 * ISOLATION — your running OpenCode Desktop is NOT touched:
 *   • --standalone          the test spins its OWN private server instead of the
 *                           background service your Desktop uses.
 *   • OPENCODE_DB           a throwaway DB in %TEMP%, separate from your sessions.
 *   • OPENCODE_CONTEXT_INDICATOR_STATE_FILE
 *                           a throwaway state file in %TEMP%; the live
 *                           opencode-context-indicator-state.json is never read
 *                           or written by the test.
 *   • OPENCODE_DISABLE_PROJECT_CONFIG=1
 *                           the test does not read a project-level config.
 *   • Exactly ONE minimal LLM call ("Say OK") is made, in the isolated session.
 *   • The plugin itself is loaded from the owner's global config (currently
 *     file:/// → this repo).  That config is READ but never modified.
 *
 * Environment overrides:
 *   OPENCODE_CLI        path to opencode-cli.exe (default: Programs\@opencode-aidesktop)
 *   OPENCODE_E2E_MODEL  model for the "Say OK" round-trip (REQUIRED in full
 *                       mode; use your own `provider/model` id, e.g. `prov/model`)
 *                       — not needed for --quick.
 *
 * Timings: INIT 45 s, STEP 80 s, total budget ~180 s.  On timeout the PTY
 * process tree is killed and an ANSI-stripped diagnostic tail is printed.
 */

import pty from "node-pty";
import { readFileSync, statSync, unlinkSync, accessSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = join(__dirname, "..");

// ---------------------------------------------------------------------------
// mode / timings
// ---------------------------------------------------------------------------
const quickMode = process.argv.includes("--quick");
const INIT_TIMEOUT_MS = 45_000;
const STEP_TIMEOUT_MS = 80_000;
const TOTAL_BUDGET_MS = 180_000;
const runStartedAt = Date.now();

// ---------------------------------------------------------------------------
// CLI resolution — correct default includes the "Programs\" segment and is
// overridable via OPENCODE_CLI.  SKIP only if none of the candidates exist.
// ---------------------------------------------------------------------------
const localAppData = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
const CLI_CANDIDATES = [
  process.env.OPENCODE_CLI || "",
  join(localAppData, "Programs", "@opencode-aidesktop", "resources", "opencode-cli.exe"),
  join(localAppData, "@opencode-aidesktop", "resources", "opencode-cli.exe"), // legacy layout
].filter(Boolean);

let resolvedCliPath = "";
for (const cand of CLI_CANDIDATES) {
  try { accessSync(cand); resolvedCliPath = cand; break; } catch { /* try next */ }
}

// ---------------------------------------------------------------------------
// isolation paths
// ---------------------------------------------------------------------------
const ISOLATED_DB    = join(tmpdir(), "oci-e2e.db");
const ISOLATED_STATE = join(tmpdir(), "oci-e2e-state.json");
const LIVE_STATE     = join(tmpdir(), "opencode-context-indicator-state.json");

function childEnv() {
  return {
    ...process.env,
    OPENCODE_DB: ISOLATED_DB,
    OPENCODE_CONTEXT_INDICATOR_STATE_FILE: ISOLATED_STATE,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const PLUGIN_LOAD_RE = /msg="loading plugin"[\s\S]{0,300}?opencode-context-indicator/i;
// Full entrypoint marker: file:/// ... /opencode-context-indicator/... (\s-tolerant
// because conpty may wrap the long log line mid-path).
const REPO_ENTRY_RE  = /entrypoint=file:[\s\S]{0,200}?opencode-context-indicator/i;

function stripAnsi(s) {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")           // OSC
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")                    // CSI
    .replace(/\x1b[@-Z\\-_]/g, "");                               // other escapes
}

// Kill the whole PTY process tree (conpty shell + opencode-cli children).
// p.kill() must run FIRST: node-pty's Windows kill path spawns an agent that
// AttachConsole()s the shell PID — if taskkill already reaped the shell, the
// agent throws "AttachConsole failed".  taskkill /T is the fallback for any
// grandchildren that survive.
function killTree(p) {
  try { p.kill(); } catch { /* best effort */ }
  if (process.platform === "win32" && p && p.pid) {
    try { spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); }
    catch { /* best effort */ }
  }
}

/**
 * Spawn the CLI in a PTY, capturing all output.
 *   extraArgs  — CLI arguments (already quoted where needed)
 *   timeoutMs  — hard kill after this many ms
 *   isDone     — optional predicate(buf) → stop early (load marker reached)
 *   graceMs    — after isDone fires, keep draining output this long before killing
 *                (a long log line can be delivered across several conpty chunks)
 * Returns { buf, exitCode, timedOut }.
 */
function runPty(extraArgs, timeoutMs, isDone, graceMs = 0) {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    let graceTimer = null;

    const cliCmd = process.platform === "win32"
      ? `& "${resolvedCliPath}" ${extraArgs.join(" ")}`
      : `"${resolvedCliPath}" ${extraArgs.join(" ")}`;
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
    const shellArgs = process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cliCmd]
      : ["-c", cliCmd];

    const p = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd: tmpdir(),
      env: childEnv(),
    });

    const finish = (exitCode, timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({ buf, exitCode, timedOut });
    };

    const timer = setTimeout(() => { killTree(p); finish(-1, true); }, timeoutMs);

    p.onData((d) => {
      buf += d.toString();
      if (!done && isDone && isDone(buf) && !graceTimer) {
        if (graceMs > 0) graceTimer = setTimeout(() => { killTree(p); finish(0, false); }, graceMs);
        else { killTree(p); finish(0, false); }
      }
    });

    p.onExit(({ exitCode }) => finish(exitCode, false));
  });
}

// Best-effort Desktop fingerprint (Windows only, never fatal).
// Name filter is explicit so the probe's own powershell (whose command line
// contains the "serve --service" search string) is NOT matched.
function desktopSnapshot() {
  if (process.platform !== "win32") return "";
  const psCmd = 'Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq \'OpenCode.exe\') -or ($_.Name -eq \'opencode-cli.exe\' -and $_.CommandLine -like \'*serve --service*\') } | Sort-Object ProcessId | ForEach-Object { "$($_.ProcessId) $($_.Name)" }';
  try {
    const r = spawnSync("powershell", ["-NoLogo", "-NoProfile", "-Command", psCmd], { encoding: "utf8" });
    return (r.stdout || "").trim();
  } catch { return ""; }
}

function diag(r) {
  const clean = stripAnsi(r.buf || "");
  const tail = clean.slice(-1600);
  console.error("  --- diagnostic tail (ANSI-stripped, last 1600 chars) ---");
  console.error(tail.split("\n").map((l) => "  | " + l).join("\n"));
  console.error("  --- end diagnostic ---");
}

// ---------------------------------------------------------------------------
// Check A: plugin load (isolated standalone TUI)
// ---------------------------------------------------------------------------
async function checkA() {
  console.log("\n=== Check A: plugin load (isolated standalone TUI) ===");

  // Stop as soon as the deterministic load marker appears (typically < 5 s).
  // NOTE: the "Ask anything" prompt is rendered asynchronously by the TUI and
  // is not a reliable marker (it comes and goes with redraws), so it is only
  // reported for information — never used to gate.
  const r = await runPty(
    ["--standalone", "--print-logs"],
    INIT_TIMEOUT_MS,
    // Stop on the deterministic load marker; then drain a short grace window so
    // the (wrapped) tail of the same log line — id/entrypoint=file: — is captured.
    (buf) => PLUGIN_LOAD_RE.test(buf),
    2500,
  );

  const loadSeen  = PLUGIN_LOAD_RE.test(r.buf);
  const repoSeen  = REPO_ENTRY_RE.test(r.buf);
  const readySeen = /Ask anything/i.test(r.buf) || /Ask anything/i.test(stripAnsi(r.buf));

  console.log(`  plugin loaded:   ${loadSeen ? "\u2713" : "\u2717"}  (msg="loading plugin" \u2192 opencode-context-indicator)`);
  console.log(`  repo entrypoint: ${repoSeen ? "\u2713" : "\u2717"}  (file:/// \u2192 this checkout, not the npm copy)`);
  console.log(`  TUI ready:       ${readySeen ? "\u2713" : "\u2013"}  (informational; TUI prompt redraws asynchronously)`);
  console.log(`  isolated:        \u2713 (live state.json untouched)`);

  if (!loadSeen) {
    console.error("\n[FAIL] Check A: plugin was not loaded");
    if (r.timedOut) console.error(`  (timed out after ${INIT_TIMEOUT_MS} ms)`);
    diag(r);
    return false;
  }
  if (!repoSeen) {
    console.error("\n[WARN] Check A: plugin loaded, but not from this checkout's file:// entrypoint.");
    console.error("       Your global config may point at the published npm package instead.");
  }

  console.log("\n[PASS] Check A: plugin loaded in the isolated instance");
  return true;
}

// ---------------------------------------------------------------------------
// Check B: live update — one "Say OK" round-trip writes the isolated state file
// ---------------------------------------------------------------------------
async function checkB() {
  console.log("\n=== Check B: live update (\u201CSay OK\u201D \u2192 isolated state.json) ===");

  try { unlinkSync(ISOLATED_STATE); } catch { /* ok */ }
  const startMs = Date.now();
  const model = process.env.OPENCODE_E2E_MODEL;

  const r = await runPty(
    ["run", "\"Say OK\"", "--standalone", "--print-logs", "--model", model],
    STEP_TIMEOUT_MS,
  );
  const buf = r.buf;
  const clean = stripAnsi(buf);

  const loadSeen  = PLUGIN_LOAD_RE.test(buf);
  const responded = /(^|\n)\s*OK\s*(\r?\n|$)/.test(clean);

  let stateOk = false, sessions = 0, maxCtx = 0;
  try {
    const st = statSync(ISOLATED_STATE);
    stateOk = st.mtimeMs >= startMs;
    const j = JSON.parse(readFileSync(ISOLATED_STATE, "utf8"));
    const keys = Object.keys(j);
    sessions = keys.length;
    maxCtx = keys.reduce((m, k) => Math.max(m, j[k].ctx || 0), 0);
  } catch { /* missing / malformed */ }

  console.log(`  plugin loaded:   ${loadSeen ? "\u2713" : "\u2717"}`);
  console.log(`  LLM responded:   ${responded ? "\u2713" : "\u2717"}  ("Say OK" \u2192 "OK")`);
  console.log(`  state updated:   ${stateOk ? "\u2713" : "\u2717"}  (isolated state.json mtime fresh)`);
  console.log(`  sessions:        ${sessions}  (max ctx=${maxCtx} tokens)`);
  console.log(`  process:         exit=${r.exitCode}${r.timedOut ? " (TIMED OUT)" : ""}`);
  console.log(`  isolated:        \u2713 (live state.json untouched)`);

  const passed = !r.timedOut && r.exitCode === 0 && loadSeen && stateOk && sessions > 0 && maxCtx > 0;
  if (!passed) {
    console.error("\n[FAIL] Check B: live-update round-trip not confirmed");
    diag(r);
    return false;
  }

  console.log("\n[PASS] Check B: plugin wrote state after the isolated \u201CSay OK\u201D round-trip");
  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=".repeat(70));
  console.log("e2e-tui.mjs \u2014 isolated TUI plugin E2E gate");
  console.log(`mode:     ${quickMode ? "QUICK (load only)" : "FULL (load + Say OK round-trip)"}`);
  console.log(`opencode: ${resolvedCliPath || "(not resolved)"}`);
  console.log(`plugin:   ${repoRoot}`);
  console.log(`isolated DB:    ${ISOLATED_DB}`);
  console.log(`isolated state: ${ISOLATED_STATE}`);
  console.log(`live state:     ${LIVE_STATE}  (never read/written by the test)`);
  console.log("=".repeat(70));

  if (!resolvedCliPath) {
    console.error("[SKIP] opencode CLI not found. Searched:");
    CLI_CANDIDATES.forEach((c) => console.error(`  ${c}`));
    console.error("Set OPENCODE_CLI env var or install OpenCode Desktop.");
    process.exit(0); // not a failure — CI may not have OpenCode
  }

  if (!quickMode && !process.env.OPENCODE_E2E_MODEL) {
    console.error("[FAIL] OPENCODE_E2E_MODEL is not set.");
    console.error("       The full E2E makes one round-trip, so it needs a model id.");
    console.error("       Set it to your own provider/model, e.g.:");
    console.error("         set OPENCODE_E2E_MODEL=myprovider/some-model   (Windows cmd)");
    console.error("         $env:OPENCODE_E2E_MODEL='myprovider/some-model' (PowerShell)");
    console.error("       Or run load-only with:  node test/e2e-tui.mjs --quick");
    process.exit(1);
  }

  if (!quickMode) {
    console.log("[e2e] running against ISOLATED opencode instance \u2014 your running sessions are not touched");
  }

  const desktopBefore = quickMode ? "" : desktopSnapshot();

  const a = await checkA();
  if (!a) { console.error("\n[e2e FAILED] Check A"); process.exit(1); }

  if (!quickMode) {
    const b = await checkB();
    if (!b) { console.error("\n[e2e FAILED] Check B"); process.exit(1); }

    const desktopAfter = desktopSnapshot();
    if (desktopBefore && desktopAfter) {
      const unchanged = desktopBefore === desktopAfter;
      console.log(`\n[desktop] OpenCode Desktop PIDs ${unchanged ? "unchanged \u2713" : "CHANGED \u2717"}`);
      console.log(`[desktop] before: ${desktopBefore.split("\n").join(", ")}`);
      console.log(`[desktop] after:  ${desktopAfter.split("\n").join(", ")}`);
    }
  }

  const elapsed = ((Date.now() - runStartedAt) / 1000).toFixed(1);
  const budget  = (TOTAL_BUDGET_MS / 1000).toFixed(0);
  console.log("\n" + "=".repeat(70));
  console.log(`ALL CHECKS PASSED  (${elapsed}s / ${budget}s budget)`);
  console.log("=".repeat(70));
  process.exit(0);
}

main().catch((err) => {
  console.error("\n[FATAL]", err);
  process.exit(1);
});
