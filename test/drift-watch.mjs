/**
 * drift-watch.mjs — OpenTUI pin alignment check (CI + manual).
 *
 * The plugin pins @opentui/solid to the EXACT version of the OpenTUI stack the
 * host OpenCode ships: the host does not bridge @opentui/solid, so a version
 * skew between our compiled JSX runtime and the host renderer is a live-panel
 * risk. opencode bumps OpenTUI frequently (0.5.12 -> 0.5.14 -> 0.5.16 across
 * three releases), so the pin is re-aligned every release.
 *
 * Source of truth for "what the host ships": the RELEASED opencode CLI.
 *   1. npm registry: @opencode/cli latest version (no GitHub API, no auth,
 *      no shared-IP rate limits).
 *   2. Map to the release tag v<version>.
 *   3. Fetch that tag's root package.json -> workspaces.catalog.
 *   4. Compare @opentui/solid (runtime pin) and @opentui/core (dev pin used
 *      by the resolve gate) with this repo's values.
 *
 * Exit codes: 0 = aligned; 1 = drift OR source of truth unavailable
 * (fail-loud: a silent pass would defeat the whole point).
 *
 * Manual: node test/drift-watch.mjs   (also wired into CI after the gate)
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

const ours = {
  solid: pkg.dependencies?.["@opentui/solid"],
  core: pkg.devDependencies?.["@opentui/core"],
};

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
      if (res.ok) return res.json();
      lastErr = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status !== 404 && res.status < 500) break; // deterministic failure
    } catch (err) {
      lastErr = err;
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw lastErr;
}

function fail(msg) {
  console.error(`[drift-watch FAIL] ${msg}`);
  process.exit(1);
}

let hostVersion;
try {
  const cli = await fetchJson("https://registry.npmjs.org/@opencode/cli/latest");
  hostVersion = cli?.version;
  if (typeof hostVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(hostVersion)) {
    fail(`npm registry returned an unusable @opencode/cli version: ${JSON.stringify(hostVersion)}`);
  }
} catch (err) {
  fail(`cannot read the released opencode version from the npm registry: ${err?.message ?? err}`);
}

const tag = `v${hostVersion}`;
let catalog;
try {
  const root = await fetchJson(
    `https://raw.githubusercontent.com/anomalyco/opencode/${tag}/package.json`,
  );
  catalog = root?.workspaces?.catalog;
  if (!catalog || typeof catalog !== "object") {
    fail(`${tag}/package.json carries no workspaces.catalog`);
  }
} catch (err) {
  fail(
    `cannot read the OpenTUI catalog from ${tag} ` +
      `(npm latest may be ahead of the git tag - release in flight?): ${err?.message ?? err}`,
  );
}

const host = {
  solid: catalog["@opentui/solid"],
  core: catalog["@opentui/core"],
};

if (host.solid == null || host.core == null) {
  fail(`the ${tag} catalog has no @opentui entries - check the host layout`);
}

console.log(`host: opencode ${hostVersion} (${tag})`);
console.log(`catalog: @opentui/solid=${host.solid}  @opentui/core=${host.core}`);
console.log(`ours:   @opentui/solid=${ours.solid}  @opentui/core=${ours.core}`);
if (ours.solid !== host.solid || ours.core !== host.core) {
  console.error("");
  console.error("[drift-watch FAIL] OpenTUI pin drift detected.");
  console.error(`  Align this repo with the host before the next release:`);
  console.error(`    dependencies["@opentui/solid"]  ${ours.solid} -> ${host.solid}`);
  console.error(`    devDependencies["@opentui/core"] ${ours.core} -> ${host.core}`);
  console.error(`  then update the README/tui.tsx header mentions and re-run the gates.`);
  process.exit(1);
}

console.log("[drift-watch OK] OpenTUI pin aligned with the released host.");
