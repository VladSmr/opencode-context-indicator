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
 * The same pass also reads the released core's `session/compaction.ts` and
 * `session/model-request.ts` and compares the constants this plugin mirrors:
 * the auto-compaction reserve (`RESERVE_SHARE`, `RESERVE_MIN`, the
 * `2 * RESERVE_MIN` gate), the `inputWindow()` min(input, context) cap and the
 * `OUTPUT_TOKEN_MAX` reply cap. A changed formula FAILS in every mode (it makes
 * every displayed percentage wrong); a changed reply cap is advisory because the
 * plugin does not model the fitted output budget.
 *
 * In GitHub Actions a warning is also emitted as a `::warning::` annotation so
 * it shows up in the run summary without failing the build.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { RESERVE_MIN, RESERVE_SHARE } from "../lib/constants.js";

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

// Plain-text sibling of fetchJson for the core source files whose constants we
// mirror (the compaction ceiling is not exposed through any API the plugin can
// query at runtime, so the release tag's source is the only source of truth).
async function fetchText(url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: "text/plain" },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return await res.text();
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status !== 404 && res.status < 500) break;
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

  // Core source files this plugin mirrors numerically. The plugin API exposes
  // the assembled payload but not the compaction trigger, so a released formula
  // change is invisible at runtime - and a wrong reserve silently makes every
  // displayed percentage wrong. Fetched separately in run() so a 404 here can
  // never hide a version-pin drift.
  return {
    hostVersion,
    tag,
    solid: catalog["@opentui/solid"],
    core: catalog["@opentui/core"],
    hostPlugin,
  };
}

async function readCompactionContract(tag) {
  return {
    compactionSource: await fetchText(
      `https://raw.githubusercontent.com/anomalyco/opencode/${tag}/packages/core/src/session/compaction.ts`,
    ),
    modelRequestSource: await fetchText(
      `https://raw.githubusercontent.com/anomalyco/opencode/${tag}/packages/core/src/session/model-request.ts`,
    ),
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

  // Compaction contract: the numbers lib/constants.js mirrors from the released
  // core. Version drift is a warning; a changed FORMULA is breaking, because the
  // plugin keeps showing the old ceiling (and a percentage the host never acts
  // on). Fetched separately from the pins, and a network miss only skips this
  // section - it must never hide a pin drift.
  let contractSrc = null;
  try {
    contractSrc = await readCompactionContract(host.tag);
  } catch (err) {
    const msg =
      `cannot read the compaction ceiling from ${host.tag} (release in flight?): ` +
      `${err?.message ?? err}`;
    if (strict) fail(`${msg} (strict mode: alignment cannot be verified)`);
    warn(`${msg} (inconclusive - compaction contract skipped; version pins still reported)`);
  }

  let contractChecked = false;
  if (contractSrc) {
    contractChecked = true;
    const squash = (s) => s.replace(/\s+/g, " ");
    // Slice exactly ONE function body. A braced arrow always runs to the first
    // column-0 `\n}` (a blank line inside the body is normal formatting, not the
    // end); a single-expression arrow ends at the blank line before the next
    // declaration. No fixed character windows and no premature cut on internal
    // blank lines.
    const functionSource = (src, name) => {
      const at = src.indexOf(`const ${name}`);
      if (at < 0) return "";
      const arrow = src.indexOf("=>", at);
      if (arrow < 0) return "";
      let cursor = arrow + 2;
      while (cursor < src.length && /\s/.test(src[cursor])) cursor++;
      if (src[cursor] === "{") {
        const end = src.indexOf("\n}", cursor);
        return end < 0 ? src.slice(at) : src.slice(at, end + 2);
      }
      const end = src.indexOf("\n\n", arrow);
      return end < 0 ? src.slice(at) : src.slice(at, end);
    };
    const numConst = (src, name, where) => {
      const m = new RegExp(`const ${name} = ([0-9_.]+)`).exec(src);
      if (!m) {
        fail(
          `${where} no longer declares ${name} - the compaction formula changed; ` +
            "re-audit lib/constants.js and lib/limits.js against the new source",
        );
      }
      return Number(m[1].replace(/_/g, ""));
    };
    // The reply cap is NOT modelled by the plugin, so a missing/renamed constant
    // is an advisory signal, never a hard failure.
    const optionalNum = (src, name) => {
      const m = new RegExp(`const ${name} = ([0-9_.]+)`).exec(src);
      return m ? Number(m[1].replace(/_/g, "")) : null;
    };

    const hostShare = numConst(
      contractSrc.compactionSource,
      "RESERVE_SHARE",
      `${host.tag} compaction.ts`,
    );
    const hostMin = numConst(
      contractSrc.compactionSource,
      "RESERVE_MIN",
      `${host.tag} compaction.ts`,
    );
    const hostOutputMax = optionalNum(contractSrc.modelRequestSource, "OUTPUT_TOKEN_MAX");

    const ceilingBody = functionSource(contractSrc.compactionSource, "calculateCeiling");
    const inputWindowBody = functionSource(contractSrc.compactionSource, "inputWindow");
    const ceilingOpen = ceilingBody.length > 0;
    const inputWindowOpen = inputWindowBody.length > 0;
    const ceilingFlat = squash(ceilingBody);
    const inputWindowFlat = squash(inputWindowBody);
    const hasShare =
      /Math\.floor\(window \* RESERVE_SHARE\)|Math\.floor\(RESERVE_SHARE \* window\)/.test(
        ceilingFlat,
      ) && /Math\.max\(/.test(ceilingFlat);
    const hasMinGate = /window >= 2 \* RESERVE_MIN \? RESERVE_MIN : 0/.test(ceilingFlat);
    const hasInputMin =
      /Math\.min\(limit\.input, limit\.context\)|Math\.min\(limit\.context, limit\.input\)/.test(
        inputWindowFlat,
      );

    console.log(
      `compaction: reserve=max(${hostShare * 100}%, ${hostMin})  ` +
        `window=${hasInputMin ? "min(input, context)" : "NOT min(input, context)"}  ` +
        `outputMax=${hostOutputMax ?? "unknown"}`,
    );

    const contract = (name, oursValue, hostValue, breaking) =>
      drifts.push({
        name,
        ours: String(oursValue),
        host: String(hostValue),
        breaking,
      });
    if (!ceilingOpen) {
      fail(
        `${host.tag} compaction.ts lost calculateCeiling() - re-audit lib/constants.js and lib/limits.js`,
      );
    }
    if (!inputWindowOpen) {
      fail(
        `${host.tag} compaction.ts lost inputWindow() - re-audit lib/constants.js and lib/limits.js`,
      );
    }
    if (!hasShare) {
      contract("core compaction RESERVE_SHARE usage", `${RESERVE_SHARE}`, "formula changed", true);
    }
    if (!hasMinGate) {
      contract("core compaction 2 * RESERVE_MIN gate", `${RESERVE_MIN}`, "formula changed", true);
    }
    if (!hasInputMin) {
      contract("core inputWindow min(input, context)", "min(input, context)", "not capped", true);
    }
    if (hostShare !== RESERVE_SHARE) {
      contract("core compaction RESERVE_SHARE", RESERVE_SHARE, hostShare, true);
    }
    if (hostMin !== RESERVE_MIN) {
      contract("core compaction RESERVE_MIN", RESERVE_MIN, hostMin, true);
    }
    if (hostOutputMax !== 256_000) {
      // Advisory: the reply cap sizes the output, not the trigger, so it changes
      // no percentage; it still fails under --strict before a release.
      contract(
        "core OUTPUT_TOKEN_MAX",
        "not modelled",
        hostOutputMax == null ? "constant removed" : hostOutputMax,
        false,
      );
    }
  }

  if (drifts.length === 0) {
    if (contractChecked) {
      console.log(
        "[drift-watch OK] OpenTUI pin, @opencode/plugin types and the compaction ceiling are aligned with the released host.",
      );
    } else {
      console.log(
        "[drift-watch OK] OpenTUI pin and @opencode/plugin types are aligned with the released host; " +
          "the compaction contract was NOT verified (see warning above).",
      );
    }
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
