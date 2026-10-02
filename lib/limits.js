// lib/limits.js
//
// Model window/price registry: the modelLimits / modelPrices maps, their lookup
// helpers (modelKey, getModelLimit, getUsableContext, setModelLimit), and the
// two loaders that populate them (ensureProviderLimits for V1 via
// client.config.providers(), ensureModelLimits for V2 via ctx.model.list()).
// hydrateModelLimitsFromState() seeds the maps from the shared state.json
// snapshot via ./state.js. Extracted 1:1 (code + WHY comments) from index.js.

import { finitePos, withTimeout } from "./estimate.js";
import { logErr, readStateSnapshot } from "./state.js";

const PROVIDERS_TTL_MS = 5 * 60 * 1000; // providers()/model.list() cache TTL after SUCCESS
const PROVIDERS_FAIL_TTL_MS = 30 * 1000; // retry-no-sooner base after FAILURE (doubles per consecutive miss)
const V2_LIMITS_MAX_BACKOFF_MS = 5 * 60 * 1000; // cap for the model.list retry backoff
const PROVIDERS_FETCH_TIMEOUT_MS = 2000; // hard cap for one providers() call (V1)
const V2_MODEL_FETCH_TIMEOUT_MS = 8000; // hard cap for one ctx.model.list() call (V2)

// `<providerID>:<modelID>` -> { context, input, output, reserved } limit record,
// populated lazily from the merged config / providers() / model.list.
const modelLimits = new Map();

// `<providerID>:<modelID>` -> { input, output, cacheRead, cacheWrite } — ONLY
// when the model config carries explicit pricing (custom providers usually omit).
const modelPrices = new Map();

// Gating for client.config.providers() (V1) fetches:
//   providersLoadedAt — last SUCCESSFUL fetch (full PROVIDERS_TTL_MS cache);
//   providersFailAt   — last FAILED/timed-out fetch (short fail TTL, so a
//                       broken/hung client does not freeze limits for the
//                       full 5 minutes);
//   providersInFlight — in-flight fetch promise (dedups parallel callers).
let providersLoadedAt = 0;
let providersFailAt = 0;
let providersInFlight = null;

// Gating for ctx.model.list() (V2) — success TTL + in-flight dedup. Failures
// are retried after the short gate; limit lookups then simply fall back to
// absolute tokens (as in V1).
let v2LimitsLoadedAt = 0;
let v2LimitsFailAt = 0;
let v2LimitsFailCount = 0; // consecutive soft-failures -> exponential retry backoff
let v2LimitsInFlight = null;

// Stable lookup key for the model-keyed limit/price/schema maps. providerID may
// be unknown ("" ) — the result is still unique per modelID, but different
// providers never share a cache slot.
function modelKey(providerID, modelID) {
  if (typeof modelID !== "string" || modelID.length === 0) return null;
  const p = typeof providerID === "string" && providerID.length > 0 ? providerID : "";
  return `${p}:${modelID}`;
}

// Raw limit record for a model: { context, input, output, reserved } or null.
function getModelLimitRecord(providerID, modelID) {
  const key = modelKey(providerID, modelID);
  if (!key) return null;
  const v = modelLimits.get(key);
  return v && typeof v === "object" ? v : null;
}

// Context window for a model (null when unknown). Used for subagent ratios and
// as the degraded denominator when the native usable window is not derivable.
function getModelLimit(providerID, modelID) {
  const rec = getModelLimitRecord(providerID, modelID);
  if (!rec) return null;
  return typeof rec.context === "number" && rec.context > 0 ? rec.context : null;
}

// Native opencode usable window (see packages/opencode/src/session/overflow.ts):
//   usable = limit.input ? limit.input − reserved : limit.context − maxOutput
//   reserved = compaction.reserved ?? min(20_000, maxOutput)
//   maxOutput = model.limit.output
// Returns { usable, limit, maxOutput, reserved } or null when not derivable
// (callers then degrade to count / limit.context, or to no percentage at all).
function getUsableContext(providerID, modelID) {
  const rec = getModelLimitRecord(providerID, modelID);
  if (!rec) return null;
  const context =
    typeof rec.context === "number" && rec.context > 0 ? rec.context : null;
  const input =
    typeof rec.input === "number" && rec.input > 0 ? rec.input : null;
  const maxOutput =
    typeof rec.output === "number" && rec.output > 0 ? rec.output : 0;
  if (input == null && context == null) return null;
  // Mirrors opencode overflow.ts: reserved = min(20000, maxOutput), i.e. 0 when
  // the model declares no output limit (NOT a 20000 default — that would
  // understate the usable window).
  const reserved =
    typeof rec.reserved === "number" && rec.reserved >= 0
      ? rec.reserved
      : Math.min(20000, maxOutput);
  const usable = input != null ? input - reserved : context - maxOutput;
  if (!(usable > 0)) return null;
  return { usable, limit: context, maxOutput, reserved };
}

// Store a model limit record under `<providerID>:<modelID>`. Written by
// `ensureModelLimits` (V2: ctx.model.list()) and `ensureProviderLimits` (V1:
// client.config.providers()), both carrying the effective merged config.
function setModelLimit(providerID, modelID, rec) {
  const key = modelKey(providerID, modelID);
  if (!key) return false;
  modelLimits.set(key, rec);
  return true;
}

// ---------------------------------------------------------------------------
// V1 model limits: effective values from client.config.providers(), cached.
// ---------------------------------------------------------------------------

// Load effective limits for ALL providers from the server config. Preferred
// over the config() hook snapshot because it reflects live overrides.
// Gating: a SUCCESSFUL fetch is cached for PROVIDERS_TTL_MS; a failed or
// timed-out attempt only blocks retries for PROVIDERS_FAIL_TTL_MS, so limits
// recover quickly instead of staying stale for the full 5 minutes. All
// failures are caught here — the function never rejects; callers fall back to
// whatever the config() hook loaded.
async function ensureProviderLimits(client) {
  const now = Date.now();
  if (now - providersLoadedAt < PROVIDERS_TTL_MS) return; // fresh success
  if (now - providersFailAt < PROVIDERS_FAIL_TTL_MS) return; // recent failure
  if (providersInFlight) return providersInFlight; // dedup parallel callers
  providersInFlight = (async () => {
    try {
      const res = await withTimeout(
        client.config.providers(),
        PROVIDERS_FETCH_TIMEOUT_MS,
        "config.providers",
      );
      const providers = Array.isArray(res)
        ? res
        : res?.data?.providers ?? res?.providers ?? res?.data;
      if (!Array.isArray(providers)) {
        providersFailAt = Date.now(); // malformed payload -> retry soon
        return;
      }
      for (const p of providers) {
        const models = p?.models;
        if (!models || typeof models !== "object") continue;
        // providerID is on the top level of each provider entry (fall back to
        // `id`; both are accepted across builds).
        const providerID =
          typeof p?.providerID === "string" && p.providerID
            ? p.providerID
            : typeof p?.id === "string"
              ? p.id
              : "";
        for (const [modelID, def] of Object.entries(models)) {
          const key = modelKey(providerID, modelID);
          if (!key) continue;
          const lim = def?.limit;
          if (!lim || typeof lim !== "object") continue;
          const context =
            typeof lim.context === "number" && lim.context > 0 ? lim.context : null;
          const input =
            typeof lim.input === "number" && lim.input > 0 ? lim.input : null;
          const output =
            typeof lim.output === "number" && lim.output > 0 ? lim.output : null;
          if (context == null && input == null) continue;
          const prevRec = modelLimits.get(key);
          setModelLimit(providerID, modelID, {
            context,
            input,
            output,
            reserved:
              typeof def?.compaction?.reserved === "number"
                ? def.compaction.reserved
                : (prevRec?.reserved ?? null),
          });
        }
      }
      providersLoadedAt = Date.now(); // set ONLY on success
    } catch (err) {
      providersFailAt = Date.now(); // failed attempt -> short retry gate
      logErr("config.providers failed", err);
    } finally {
      providersInFlight = null;
    }
  })();
  return providersInFlight;
}

// V2 model limits: effective values from ctx.model.list(), cached + gated.
// { data: ModelInfo[] } where ModelInfo = { modelID, providerID, limit:{context} }.
async function ensureModelLimits(ctx) {
  const now = Date.now();
  if (now - v2LimitsLoadedAt < PROVIDERS_TTL_MS) return; // fresh success
  // Recent failure: back off exponentially (30s, 60s, 120s … capped at 5 min)
  // so a registry that is slow to expose the provider is retried without
  // hammering it, while a one-off blip still recovers quickly.
  const failBackoff = Math.min(
    PROVIDERS_FAIL_TTL_MS * Math.pow(2, Math.max(0, v2LimitsFailCount - 1)),
    V2_LIMITS_MAX_BACKOFF_MS,
  );
  if (now - v2LimitsFailAt < failBackoff) return; // recent failure
  if (v2LimitsInFlight) return v2LimitsInFlight; // dedup parallel callers
  v2LimitsInFlight = (async () => {
    try {
      const res = await withTimeout(
        ctx.model.list(),
        V2_MODEL_FETCH_TIMEOUT_MS,
        "model.list",
      );
      const models = Array.isArray(res) ? res : res?.data;
      if (!Array.isArray(models)) {
        v2LimitsFailCount++;
        v2LimitsFailAt = Date.now(); // malformed payload -> retry soon
        const seeded = hydrateModelLimitsFromState();
        logErr(
          "model.list returned no model array — limits unavailable, will retry",
          { payloadType: typeof res, hydratedFromState: seeded },
        );
        return;
      }
      let found = 0;
      for (const m of models) {
        const modelID = m?.modelID ?? m?.id;
        const providerID =
          typeof m?.providerID === "string" && m.providerID
            ? m.providerID
            : typeof m?.provider?.id === "string"
              ? m.provider.id
              : "";
        const key = modelKey(providerID, modelID);
        const lim = m?.limit;
        if (!key || !lim || typeof lim !== "object") continue;
        const context =
          typeof lim.context === "number" && lim.context > 0 ? lim.context : null;
        const input =
          typeof lim.input === "number" && lim.input > 0 ? lim.input : null;
        const output =
          typeof lim.output === "number" && lim.output > 0 ? lim.output : null;
        if (context == null && input == null) continue;
        const prevRec = modelLimits.get(key);
        setModelLimit(providerID, modelID, {
          context,
          input,
          output,
          reserved:
            typeof m?.compaction?.reserved === "number"
              ? m.compaction.reserved
              : (prevRec?.reserved ?? null),
        });
        found++;
      }
      // An empty / limit-less payload right after boot (registry not ready yet)
      // must NOT be cached as success, or limits would stay unknown for the
      // full TTL — treat it as a soft failure and retry after the fail gate.
      if (found > 0) {
        v2LimitsLoadedAt = Date.now();
        v2LimitsFailCount = 0; // recovered
      } else {
        // Soft failure: the registry answered but carried no usable limit for
        // any model (provider not registered yet, or `limit` absent). Log WHY
        // once per backoff window, and fall back to the shared snapshot so
        // denominators do not vanish meanwhile.
        const withLimit = models.filter(
          (m) => m?.limit && typeof m.limit === "object",
        ).length;
        const withProvider = models.filter(
          (m) => m?.providerID || m?.provider?.id,
        ).length;
        const seeded = hydrateModelLimitsFromState();
        v2LimitsFailCount++;
        v2LimitsFailAt = Date.now();
        logErr(
          "model.list yielded 0 usable limits — retrying",
          { models: models.length, withLimit, withProvider, hydratedFromState: seeded },
        );
      }
    } catch (err) {
      v2LimitsFailCount++;
      v2LimitsFailAt = Date.now(); // failed attempt -> backoff gate
      const seeded = hydrateModelLimitsFromState();
      logErr(
        `model.list failed (hydrated ${seeded} limit(s) from state.json)`,
        err,
      );
    } finally {
      v2LimitsInFlight = null;
    }
  })();
  return v2LimitsInFlight;
}

// Seed `modelLimits` from previously persisted state.json entries. state.json is
// a SHARED cross-instance snapshot rewritten at every live step, so it carries a
// model's window even when THIS instance's ctx.model.list() came back empty (a
// cold instance, or one whose model registry did not expose the provider).
// Without this, a transient list miss degraded every denominator to "?" — and
// because writeStateFile used to rewrite usable/limit from the (empty) in-memory
// map, the degradation became permanent.
//
// The snapshot also holds history: during an earlier outage some instances wrote
// a WRONG usable window (e.g. 168000 instead of 1015808). A naive
// first-match seed would then re-inject that stale garbage. Therefore, per
// `<provider>:<model>`:
//   * candidates are sanity-filtered (drop `usable >= limit`, `usable <= 0`);
//   * when any candidate carries a precise `usable`, only those are considered;
//   * the FRESHEST (max `updatedAt`) candidate wins;
//   * a divergent spread (max > 3× min usable) is logged for diagnosis.
// Strictly additive: real in-memory records always win (never overwritten).
// Returns the number of records seeded.
function hydrateModelLimitsFromState() {
  try {
    const all = readStateSnapshot();
    // Group candidate entries by key first, so "freshest" is decided against
    // ALL records of that model — not the first one encountered.
    const byKey = new Map(); // key -> [ { usable, limit, updatedAt } ]
    for (const entry of Object.values(all)) {
      const providerID =
        typeof entry?.providerID === "string" ? entry.providerID : "";
      const modelID = entry?.model;
      const key = modelKey(providerID, modelID);
      if (!key || !modelID || modelID === "unknown") continue;
      if (modelLimits.has(key)) continue; // a real in-memory record always wins
      // finitePos rejects NaN/Infinity/absurd windows (e.g. a poisoned 1e15).
      const usable = finitePos(entry?.usable) ? entry.usable : null;
      const limit = finitePos(entry?.limit) ? entry.limit : null;
      if (usable == null && limit == null) continue;
      let arr = byKey.get(key);
      if (!arr) {
        arr = [];
        byKey.set(key, arr);
      }
      arr.push({
        usable,
        limit,
        updatedAt: typeof entry?.updatedAt === "string" ? entry.updatedAt : "",
      });
    }

    let added = 0;
    for (const [key, candidates] of byKey) {
      // (b) Sanity: drop impossible records (usable >= limit, usable <= 0).
      // Candidates without a usable (context-only) are kept as-is.
      const sane = candidates.filter(
        (c) =>
          c.usable == null ||
          (c.usable > 0 && (c.limit == null || c.usable <= c.limit)),
      );
      if (sane.length === 0) continue; // every record was impossible -> skip

      // (a) Prefer the precise variant (a recorded usable) when any exists.
      const precise = sane.filter((c) => c.usable != null);
      const pool = precise.length > 0 ? precise : sane;

      // (1) Freshest wins (ISO timestamps compare lexicographically).
      let best = pool[0];
      for (const c of pool) {
        if (String(c.updatedAt) > String(best.updatedAt)) best = c;
      }

      // (c) Diagnostic: a >3× spread means the snapshot is polluted by a
      // limited/fallback instance — log the numbers once for this model.
      const usables = pool.map((c) => c.usable).filter((u) => u != null);
      if (usables.length > 1) {
        const max = Math.max(...usables);
        const min = Math.min(...usables);
        if (min > 0 && max / min > 3) {
          logErr(
            `limit seed spread for ${key} — using freshest`,
            { min, max, candidates: pool.length, chosen: best.usable ?? best.limit },
          );
        }
      }

      // Build the record: precise usable-as-input when known (so getUsableContext
      // re-derives EXACTLY the persisted window), else the raw context window.
      let rec = null;
      if (best.usable != null) {
        rec = { context: best.limit, input: best.usable, output: null, reserved: 0 };
      } else if (best.limit != null) {
        rec = { context: best.limit, input: null, output: null, reserved: null };
      }
      if (rec == null) continue;
      modelLimits.set(key, rec);
      added++;
      // (3) One seed line per model: chosen value + provenance.
      console.log(
        `[context-indicator] limit seed ${key} -> usable=${
          best.usable != null ? best.usable : best.limit
        } (from ${best.updatedAt || "unknown"}, ${pool.length} candidates)`,
      );
    }
    return added;
  } catch {
    return 0;
  }
}

export {
  modelLimits,
  modelPrices,
  modelKey,
  getModelLimit,
  getUsableContext,
  setModelLimit,
  ensureProviderLimits,
  ensureModelLimits,
  hydrateModelLimitsFromState,
};
