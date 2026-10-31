/**
 * drift-watch.mjs — OpenTUI pin / host-type alignment check (CI + manual).
 *
 * The plugin pins @opentui/solid (a DEV dependency: types only — the host
 * provides the runtime instance) to the EXACT version of the OpenTUI stack the
 * host OpenCode ships, so our type surface matches the renderer an npm install
 * talks to. The @opencode/plugin devDependency feeds tsc for the TUI entry, so
 * it must track the released host too.
 *
 * Source of truth for "what the host ships": the latest RELEASED opencode.
 *   1. npm registry: @opencode/cli latest version (no GitHub API, no auth,
 *      no shared-IP rate limits).
 *   2. Map to the release tag v<version>.
 *   3. Fetch that tag's root package.json -> workspaces.catalog.
 *   4. Compare @opentui/solid, @opentui/core and @opencode/plugin.
 *
 * POLICY — advisory by default:
 *   - PATCH drift WARNS and exits 0, so the daily pipeline does not go red on
 *     every host patch release.
 *   - BREAKING drift exits 1: a major bump; a minor bump of @opencode/plugin
 *     (its type surface is not guaranteed additive); or a minor bump for a
 *     0.x package (@opentui/* is 0.x, where minor is the breaking axis).
 *   - A structural host change (no workspaces.catalog, or no @opentui entries
 *     in it) is BREAKING, never inconclusive.
 *   - An unreachable registry or a missing release tag is INCONCLUSIVE: warns
 *     and exits 0 (a release in flight must not red the pipeline).
 *   - `--strict` (or DRIFT_STRICT=1) fails on ANY drift or an inconclusive
 *     check. Use it before a release:
 *         node test/drift-watch.mjs --strict
 *
 * In GitHub Actions a warning is also emitted as a `::warning::` annotation so
 * it shows up in the run summary without failing the build.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

const strict =
  process.argv.includes("--strict") || /^(1|true)$/i.test(process.env.DRIFT_STRICT || "");

const ours = {
  solid: pkg.devDependencies?.["@opentui/solid"],
  core: pkg.devDependencies?.["@opentui/core"],
  hostPlugin: pkg.devDependencies?.["@opencode/plugin"],
};

// Exit control: set process.exitCode and let the event loop drain instead of
// calling process.exit(), which can truncate piped stdout/stderr (the GitHub
// Actions log is a pipe, so a `::warning::` annotation could be lost).
class Exit extends Error {
  constructor(code, message) {
    super(message ?? "");
    this.code = code;
  }
}

function warn(msg) {
  console.error(`[drift-watch WARN] ${msg}`);
  // Visible in the GitHub Actions run summary without failing the build.
  // Escape % first, then CR/LF, as the runner decodes %XX sequences.
  if (process.env.GITHUB_ACTIONS) {
    const escaped = String(msg)
      .replace(/%/g, "%25")
      .replace(/\r/g, "%0D")
      .replace(/\n/g, "%0A");
    console.log(`::warning title=drift-watch::${escaped}`);
  }
}

function fail(msg) {
  throw new Exit(1, `[drift-watch FAIL] ${msg}`);
}

function inconclusive(msg) {
  if (strict) fail(`${msg} (strict mode: alignment cannot be verified)`);
  warn(`${msg} (inconclusive - advisory mode; re-run with --strict before a release)`);
  throw new Exit(0);
}

async function fetchJson(url) {
  let lastErr;
  // One retry with a hard per-request timeout: a hung registry response must
  // not stall CI forever, and a release-in-flight (npm "latest" bumped a
  // moment before the git tag / raw file exists) should not fail on the first
  // 404.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return await res.json();
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status !== 404 && res.status < 500) break; // deterministic failure
    } catch (err) {
      lastErr = err;
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw lastErr;
}

function parseVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(typeof value === "string" ? value : "");
  return m
    ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) }
    : null;
}

// Semver-ish compatibility:
//   - a major bump is always breaking;
//   - `minorIsBreaking` marks a package whose minor releases may change the
//     type surface (@opencode/plugin computes TUI types we compile against);
//   - for 0.x packages the MINOR bump is the breaking axis (0.6 -> 0.7), which
//     is exactly how @opentui/* releases.
// An unparseable version cannot be reasoned about, so it is treated as risky.
function isBreaking(oursVersion, hostVersion, options = {}) {
  const a = parseVersion(oursVersion);
  const b = parseVersion(hostVersion);
  if (!a || !b) return true;
  if (a.major !== b.major) return true;
  if (options.minorIsBreaking && a.minor !== b.minor) return true;
  if (options.zeroMinorIsBreaking && a.major === 0 && a.minor !== b.minor) return true;
  return false;
}

async function readHost() {
  let hostVersion;
  try {
    const cli = await fetchJson("https://registry.npmjs.org/@opencode/cli/latest");
    hostVersion = cli?.version;
    if (typeof hostVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(hostVersion)) {
      inconclusive(
        `npm registry returned an unusable @opencode/cli version: ${JSON.stringify(hostVersion)}`,
      );
    }
  } catch (err) {
    if (err instanceof Exit) throw err;
    inconclusive(
      `cannot read the released opencode version from the npm registry: ${err?.message ?? err}`,
    );
  }

  const tag = `v${hostVersion}`;
  let catalog;
  try {
    const root = await fetchJson(
      `https://raw.githubusercontent.com/anomalyco/opencode/${tag}/package.json`,
    );
    catalog = root?.workspaces?.catalog;
  } catch (err) {
    if (err instanceof Exit) throw err;
    inconclusive(
      `cannot read the OpenTUI catalog from ${tag} ` +
        `(npm latest may be ahead of the git tag - release in flight?): ${err?.message ?? err}`,
    );
  }

  // A 200 response with a reshaped package.json is a real host change, not a
  // transient outage: fail (advisory mode included) instead of hiding it.
  if (!catalog || typeof catalog !== "object") {
    fail(`${tag}/package.json carries no workspaces.catalog (host layout changed)`);
  }
  if (catalog["@opentui/solid"] == null || catalog["@opentui/core"] == null) {
    fail(`${tag} catalog dropped the @opentui entries (host layout changed)`);
  }

  let hostPlugin;
  try {
    const pluginLatest = await fetchJson("https://registry.npmjs.org/@opencode/plugin/latest");
    hostPlugin = pluginLatest?.version;
    if (typeof hostPlugin !== "string" || !/^\d+\.\d+\.\d+$/.test(hostPlugin)) {
      inconclusive(
        `npm registry returned an unusable @opencode/plugin version: ${JSON.stringify(hostPlugin)}`,
      );
    }
  } catch (err) {
    if (err instanceof Exit) throw err;
    inconclusive(
      `cannot read @opencode/plugin latest from the npm registry: ${err?.message ?? err}`,
    );
  }

  return {
    hostVersion,
    tag,
    solid: catalog["@opentui/solid"],
    core: catalog["@opentui/core"],
    hostPlugin,
  };
}

async function run() {
  const host = await readHost();

  console.log(`host: opencode ${host.hostVersion} (${host.tag})`);
  console.log(`catalog: @opentui/solid=${host.solid}  @opentui/core=${host.core}`);
  console.log(`ours:   @opentui/solid=${ours.solid}  @opentui/core=${ours.core}`);
  console.log(`plugin types: @opencode/plugin host=${host.hostPlugin}  ours=${ours.hostPlugin}`);

  const drifts = [];
  const check = (name, oursVersion, hostVersion, options) => {
    if (oursVersion === hostVersion) return;
    drifts.push({
      name,
      ours: oursVersion,
      host: hostVersion,
      breaking: isBreaking(oursVersion, hostVersion, options),
    });
  };

  check(
    'devDependencies["@opentui/solid"]',
    ours.solid,
    host.solid,
    { zeroMinorIsBreaking: true },
  );
  check(
    'devDependencies["@opentui/core"]',
    ours.core,
    host.core,
    { zeroMinorIsBreaking: true },
  );
  // Same release train as the host; its .d.ts feeds our tsc, and minor
  // releases have changed types before (providerState -> native in 2.1.0).
  check(
    'devDependencies["@opencode/plugin"]',
    ours.hostPlugin,
    host.hostPlugin,
    { minorIsBreaking: true },
  );

  if (drifts.length === 0) {
    console.log(
      "[drift-watch OK] OpenTUI pin + @opencode/plugin types aligned with the released host.",
    );
    return;
  }

  const report = drifts
    .map((d) => `  ${d.breaking ? "BREAKING" : "advisory"}  ${d.name}  ${d.ours} -> ${d.host}`)
    .join("\n");

  if (strict || drifts.some((d) => d.breaking)) {
    const reason = strict
      ? "strict mode: drift detected."
      : "breaking version drift detected.";
    throw new Exit(
      1,
      `[drift-watch FAIL] ${reason}\n${report}\n` +
        "  Align this repo with the host before the next release, then update\n" +
        "  the README/tui.ts header mentions and re-run the gates.",
    );
  }

  console.error(`\n${report}`);
  warn(
    `host drift is non-breaking (${drifts.length} item(s)); bump when convenient. ` +
      "A major bump, a plugin minor bump, or a 0.x @opentui minor bump fails this gate; " +
      "run --strict before a release.",
  );
}

try {
  await run();
  process.exitCode = 0;
} catch (err) {
  if (err instanceof Exit) {
    if (err.message) console.error(err.message);
    process.exitCode = err.code;
  } else {
    console.error(`[drift-watch FAIL] unexpected error: ${err?.stack ?? err}`);
    process.exitCode = 1;
  }
}
