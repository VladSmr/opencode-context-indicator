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
 *   • Plugin source per check:
 *       Check A — an ISOLATED global config written to %TEMP%/oci-e2e-config
 *         (env OPENCODE_CONFIG_DIR) whose only plugin entry is this checkout's
 *         file:// URL → deterministic, fail-closed, independent of the owner's
 *         real config (which is never read or modified).
 *       Check B — the owner's real global config (read-only): the round-trip
 *         needs the configured provider/model, which may be defined there.
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
import {
  readFileSync,
  statSync,
  unlinkSync,
  accessSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
// Isolated global config directory (see header): the ONLY plugin entry is this
// checkout's file:// URL, so Check A's "repo entrypoint" assertion cannot be
// flipped by the owner's real config pointing at the npm package. Used for
// Check A ONLY — Check B needs the owner's provider/model definitions.
const ISOLATED_CONFIG_DIR = join(tmpdir(), "oci-e2e-config");
// Private XDG roots (Check A only): the data root holds the authoritative log
// file, so Check A's assertions can never be contaminated by the live
// Desktop's log streams (see the PLUGIN_LOAD_RE block below).
const ISOLATED_DATA       = join(tmpdir(), "oci-e2e-xdg-data");
const ISOLATED_CACHE      = join(tmpdir(), "oci-e2e-xdg-cache");
const ISOLATED_STATE_ROOT = join(tmpdir(), "oci-e2e-xdg-state");
const ISOLATED_LOG        = join(ISOLATED_DATA, "opencode", "log", "opencode.log");

function writeIsolatedConfig() {
  const entrypoint = pathToFileURL(repoRoot).href;
  // `update: "disable"` keeps the test instance from even checking for host
  // updates (no banners, no surprise installs inside the PTY).
  const config = { plugins: [entrypoint], update: "disable" };
  mkdirSync(ISOLATED_CONFIG_DIR, { recursive: true });
  writeFileSync(join(ISOLATED_CONFIG_DIR, "opencode.json"), JSON.stringify(config, null, 2), "utf8");
  // Clean slate for the private log tree (XDG_DATA_HOME, Check A only): the
  // assertions must only ever see THIS run's lines.
  rmSync(ISOLATED_DATA, { recursive: true, force: true });
}
writeIsolatedConfig();

function childEnv(configDir) {
  const env = {
    ...process.env,
    OPENCODE_DB: ISOLATED_DB,
    OPENCODE_CONTEXT_INDICATOR_STATE_FILE: ISOLATED_STATE,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  };
  // Check A only: isolated config + fully private XDG roots (the data root
  // holds the authoritative log file). Check B keeps the owner's real
  // environment — provider/model definitions and auth live there.
  if (configDir) {
    env.OPENCODE_CONFIG_DIR = configDir;
    env.XDG_DATA_HOME = ISOLATED_DATA;
    env.XDG_CACHE_HOME = ISOLATED_CACHE;
    env.XDG_STATE_HOME = ISOLATED_STATE_ROOT;
  }
  return env;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const PLUGIN_LOAD_RE = /msg="loading plugin"[\s\S]{0,300}?opencode-context-indicator/i;
// Authoritative Check A assertions come from the ISOLATED instance's OWN log
// file (ISOLATED_LOG, declared above): the data root is redirected via
// XDG_DATA_HOME, so that log holds ONLY lines from this test run — no
// interleaving with the live Desktop's log streams, and no false positives
// when the owner's own config points at this checkout. (PTY scraping alone is
// unreliable on 2.0.25+: async multi-stream logs interleave and conpty
// wrapping shreds regex windows.)

// The exact entrypoint URL of THIS checkout's server entry — the npm cache
// copy would ALSO contain "opencode-context-indicator" in its path, so the
// assertion must pin the full checkout URL, not just the package name.
const CHECKOUT_ENTRYPOINT = pathToFileURL(join(repoRoot, "index.js")).href;

const logHasCheckoutEntrypoint = () => newLogSlice().includes(`entrypoint=${CHECKOUT_ENTRYPOINT}`);

// The private log starts empty every run (the data tree is wiped before the
// spawn), so the slice is simply the whole file. readSync's bytesRead is
// honored (a torn tail cannot fake a match, and rotation/shrink cannot go
// negative: a missing or emptied file just yields "").
function newLogSlice() {
  try {
    const size = statSync(ISOLATED_LOG).size;
    if (size === 0) return "";
    const fh = openSync(ISOLATED_LOG, "r");
    try {
      const buf = Buffer.alloc(size);
      const bytesRead = readSync(fh, buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      closeSync(fh);
    }
  } catch {
    return "";
  }
}

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
// Quote ONE argument for the PowerShell command line so a value can never break
// out of its token and inject commands (CWE-78). Safe bare tokens are left as-is;
// anything else becomes a single-quoted PowerShell literal (embedded single
// quotes doubled). This is defence-in-depth on top of the checkB format check.
function psQuoteArg(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9._:\/@=+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "''")}'`;
}

// POSIX equivalent for the bash branch.
function shQuoteArg(arg) {
  const s = String(arg);
  if (/^[A-Za-z0-9._:\/@=+-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function runPty(extraArgs, timeoutMs, isDone, graceMs = 0, configDir) {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    let graceTimer = null;
    const cliBefore = new Set(opencodeCliCandidates().map((x) => x.pid));

    const cliCmd = process.platform === "win32"
      ? `& ${psQuoteArg(resolvedCliPath)} ${extraArgs.map(psQuoteArg).join(" ")}`
      : `${shQuoteArg(resolvedCliPath)} ${extraArgs.map(shQuoteArg).join(" ")}`;
    const shell = process.platform === "win32" ? "powershell.exe" : "/bin/bash";
    const shellArgs = process.platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", cliCmd]
      : ["-c", cliCmd];

    const p = pty.spawn(shell, shellArgs, {
      name: "xterm-256color",
      cols: 200,
      rows: 50,
      cwd: tmpdir(),
      env: childEnv(configDir),
    });

    const finish = (exitCode, timedOut) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      killNewOpencodeCli(cliBefore); // no lingering isolated instances
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

// Lingering-instance cleanup: the --standalone opencode-cli can survive the
// conpty killTree (a survivor also holds the inherited stdout pipe, which
// hangs pipelines after the node process is long gone). Snapshot the existing
// opencode-cli PIDs before the spawn; after the run, kill any NEW ones —
// EXCEPT `serve --service`, which is the user's live Desktop background
// service even if it happens to (re)start while the test is running.
function opencodeCliCandidates() {
  if (process.platform !== "win32") return [];
  try {
    const r = spawnSync(
      "powershell",
      ["-NoLogo", "-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name='opencode-cli.exe'\" | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"],
      { encoding: "utf8" },
    );
    return (r.stdout || "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf("|");
        return { pid: Number(line.slice(0, i)), cmd: line.slice(i + 1) };
      })
      .filter((x) => Number.isFinite(x.pid) && x.pid > 0);
  } catch { return []; }
}

function killNewOpencodeCli(before) {
  // Only instances THIS test spawned (they carry --standalone in their command
  // line); never the user's plain TUI/run sessions, and never `serve --service`
  // — that is the live Desktop background service.
  for (const { pid, cmd } of opencodeCliCandidates()) {
    if (!before.has(pid) && /--standalone/.test(cmd) && !/serve --service/.test(cmd)) {
      try { spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* best effort */ }
    }
  }
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

  // Early-stop on the first of: the PTY load marker OR the authoritative
  // log-file entrypoint line (atomic, so its presence implies the full line).
  const r = await runPty(
    ["--standalone", "--print-logs"],
    INIT_TIMEOUT_MS,
    (buf) => logHasCheckoutEntrypoint() || PLUGIN_LOAD_RE.test(buf),
    2500,
    // Isolated global config: the ONLY plugin entry is this checkout.
    ISOLATED_CONFIG_DIR,
  );

  if (r.timedOut) {
    // A cold/slow machine may flush the loading line just after the PTY
    // timeout — give the private log a short grace before failing.
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  // Authoritative assertions from the isolated instance's OWN log file.
  const slice = newLogSlice();
  const loadSeen  = /msg="loading plugin"/.test(slice);
  const repoSeen  = slice.includes(`entrypoint=${CHECKOUT_ENTRYPOINT}`);
  const readySeen = /Ask anything/i.test(r.buf) || /Ask anything/i.test(stripAnsi(r.buf));

  console.log(`  plugin loaded:   ${loadSeen ? "\u2713" : "\u2717"}  (host log: msg="loading plugin")`);
  console.log(`  checkout source: ${repoSeen ? "\u2713" : "\u2717"}  (host log: entrypoint=${CHECKOUT_ENTRYPOINT})`);
  console.log(`  TUI ready:       ${readySeen ? "\u2713" : "\u2013"}  (informational; PTY redraws asynchronously)`);
  console.log(`  isolated:        \u2713 (live state.json untouched)`);

  if (!loadSeen) {
    console.error("\n[FAIL] Check A: the isolated instance never logged a plugin load");
    if (r.timedOut) console.error(`  (timed out after ${INIT_TIMEOUT_MS} ms)`);
    diag(r);
    return false;
  }
  if (!repoSeen) {
    // Fail-closed: the isolated config pins the plugin to THIS checkout, so a
    // missing checkout entrypoint means the OPENCODE_CONFIG_DIR override was
    // not honored (older host build) or the log line format changed — either
    // way the e2e no longer proves what it claims to prove.
    console.error("\n[FAIL] Check A: plugin loaded, but NOT from this checkout's file:// entrypoint.");
    console.error(`       expected entrypoint=${CHECKOUT_ENTRYPOINT}`);
    console.error("       The isolated config (OPENCODE_CONFIG_DIR -> %TEMP%/oci-e2e-config) may not");
    console.error("       be honored by this CLI build, or the log line format changed.");
    diag(r);
    return false;
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

  // OPENCODE_E2E_MODEL ends up on a PowerShell command line (see runPty). Reject
  // any value that is not a strict provider/model id so it can never carry
  // shell metacharacters (quotes, ;, $, backtick, spaces, ...) — CWE-78.
  const MODEL_RE = /^[\w.:@/-]{1,120}$/;
  if (typeof model !== "string" || !MODEL_RE.test(model)) {
    console.error(
      "[FAIL] Check B: OPENCODE_E2E_MODEL must match ^[\\w.:@/-]{1,120}$ " +
        "(no spaces/quotes/shell metacharacters).",
    );
    return false;
  }

  const r = await runPty(
    ["run", "Say OK", "--standalone", "--print-logs", "--model", model],
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
