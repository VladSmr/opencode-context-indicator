// lib/commands.js
//
// The V2 slash command (/context-diff) and the family-report collection the
// Desktop GUI panel shares with it (lib/desktop.js): report collection from
// cache + state.json (plus a bounded live fallback), markdown rendering of the
// delta, and delivery via ctx.session.synthetic.
//
// Since 1.9.0 the full breakdown is NOT a slash command: the terminal TUI has
// the /cx panel and the Desktop has its own panel tab, both fed by the same
// collection below. /context and /context-breakdown were removed.

import {
  breakdownCategories,
  fmt,
  fmtCell,
  isHookMeasuredEntry,
  isHookSource,
  isSafeSessionKey,
  oneLine,
  safeCategories,
  safeCell,
  safeReclaim,
  safeSaneOrNull,
  safeSnapshot,
  safeToolOutByTool,
  sumCategories,
  withTimeout,
} from "./estimate.js";
import {
  breakdownForModel,
  lastKnownCacheRead,
  lastKnownCacheWrite,
  lastKnownCtx,
  lastKnownInput,
  lastKnownModel,
  lastKnownProvider,
  sessionAgentCache,
} from "./cache.js";
import { getModelLimit, getUsableContext } from "./limits.js";
import { locationDirectory } from "./config.js";
import {
  logErr,
  pushFinalSummary,
  readStateSnapshot,
} from "./state.js";
import {
  estimateBreakdownFromClientMessages,
  V2_FALLBACK_TIMEOUT_MS,
} from "./v2.js";

// ---------------------------------------------------------------------------
// V2 slash command: /context-diff
// ---------------------------------------------------------------------------
// /context-diff prints what changed since the PREVIOUS distinct measurement of
// the CURRENT session (cache + state.json, no subagents, no RPC) and delivers
// it via ctx.session.synthetic({sessionID, text, ...}) with resume:true, so the
// model renders it as a normal assistant message. Works in the Desktop app
// (which has no TUI slots, issue #49380) and in the TUI. Registered only on the
// V2 path.
//
// Session resolution cascade (per task): in-memory breakdownCache -> the
// state.json snapshot -> a throttled/3s ctx.session.context() fallback. The
// fallback cannot see the assembled system prompt or the tool schemas, so those
// two cells stay "n/a" and the row's source is labelled honestly.

// Cumulative wall-clock budget for one family collection (root + every
// descendant, fetched in PARALLEL). Each per-session live lookup is additionally
// capped at V2_FALLBACK_TIMEOUT_MS, so a collection costs about the per-session
// cap (not the sum) instead of N × 3s for N subagents. A session with no
// cached/snapshot categories whose bounded session.context lookup fails or never
// gets any budget is tagged "no-data": ctx/model/updatedAt still come from
// state.json / live, but the category cells stay n/a. Used by the Desktop panel
// RPC (lib/desktop.js) and by the unit harness.
const COMMAND_COLLECT_BUDGET_MS = 3500;

// Session ids for which this instance already tried a live enrichment and found
// nothing better than state.json. The Desktop panel polls collectFamilyReports
// (and therefore collectSessionReport) every 1.5 s; without this, a session
// whose state entry has no agent/model would issue session.get() on every poll,
// forever. Bounded: an instance only ever tracks the sessions it has seen.
const ENRICH_ATTEMPTED_MAX = 256;
const enrichAttempted = new Set();

function markEnrichAttempted(sessionID) {
  if (enrichAttempted.has(sessionID)) return;
  if (enrichAttempted.size >= ENRICH_ATTEMPTED_MAX) {
    const oldest = enrichAttempted.values().next().value;
    enrichAttempted.delete(oldest);
  }
  enrichAttempted.add(sessionID);
}

// True when a state.json entry carries no measured tokens at all: a session
// registered (session.created) but with no served step. `writeStateFile` always
// persists `categories` as an object, so the emptiness test must SUM those
// fields — a missing/`undefined` categories must not be the only trigger.
// Note: `system` / `toolSchemas` may legitimately be null (hook-only), so they
// are coerced with `|| 0`.
function isEmptyStateEntry(entry) {
  const sum = sumCategories(entry?.categories);
  return (
    sum === 0 &&
    (!entry?.ctx || entry.ctx === 0) &&
    (!entry?.input || entry.input === 0)
  );
}

// ALL descendant session IDs of `rootID` (breadth-first over the parentID chain
// in the state.json snapshot), de-duplicated. The snapshot is the ONLY source:
// each entry is keyed by its own sessionID and carries the parentID recorded
// when it was written, so the chain is root-consistent — entries of OTHER roots
// are unreachable from `rootID` (their parentID points at their own root). The
// earlier cross-root leakage came from the in-memory index, which is no longer
// consulted here.
//
// The BFS visits every level (subagents of subagents included). A phantom node
// (no tokens, see isEmptyStateEntry) is never emitted, but traversal still
// descends through it so real grandchildren behind a phantom parent are found.
// `seen` guards against cycles (parentID loops) and double-listing.
function collectDescendantSessionIDs(rootID, state) {
  const seen = new Set([rootID]);
  const out = [];
  const queue = [rootID];
  // Index the snapshot by parentID once (O(n)) instead of an O(n) scan per
  // visited node.
  const byParent = new Map();
  for (const [id, entry] of Object.entries(state || {})) {
    if (!isSafeSessionKey(id)) continue; // never index a poisoned key
    const pid = entry?.parentID;
    if (!pid) continue;
    let set = byParent.get(pid);
    if (!set) {
      set = new Set();
      byParent.set(pid, set);
    }
    set.add(id);
  }
  while (queue.length > 0) {
    const cur = queue.shift();
    const kids = byParent.get(cur);
    if (!kids) continue;
    for (const c of kids) {
      if (!c || seen.has(c)) continue; // cycle + dedup guard
      seen.add(c);
      if (!isEmptyStateEntry(state[c])) out.push(c);
      queue.push(c); // descend through phantom parents too
    }
  }
  return out;
}

// Normalise a breakdown record (cache or state entry) into the 8 categories.
// Moved to lib/estimate.js (shared with the V2 live log); re-used here so the
// residual computation has exactly one implementation.

function timeOnly(iso) {
  if (!iso) return "-";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toTimeString().slice(0, 8); // HH:MM:SS
  } catch {
    return "-";
  }
}

// Resolve one session's report: totals, model, categories + honest source.
// `deadline` is the shared wall-clock budget for one family collection
// (see collectFamilyReports): the per-session live lookups are capped by
// whatever remains of it and skipped once it is exhausted. A session that ends
// up with no category data is tagged "no-data" (see the branch below).
async function collectSessionReport(ctx, sessionID, state, deadline) {
  // hasOwnProperty guard: a sessionID of "__proto__"/"constructor" must never
  // resolve to an inherited Object.prototype (state is untrusted input).
  const entry =
    state &&
    isSafeSessionKey(sessionID) &&
    Object.prototype.hasOwnProperty.call(state, sessionID)
      ? state[sessionID]
      : null;
  const cachedModel = lastKnownModel(sessionID);
  let bd = breakdownForModel(sessionID, cachedModel);
  // A state entry written for ANOTHER model is not this model's split: after an
  // in-session model switch its categories (and hook provenance) describe the
  // previous window and must not be reported under the new model name.
  //
  // "Unknown" on either side means "cannot tell" and keeps the entry: the reader
  // resolving the model later is the common case (a cold Desktop window polls
  // before its first request), and dropping the only data available would turn
  // the row into `no-data` on every poll. The clause is reachable via the
  // pre-await call below with a cold `cachedModel` while the entry knows its
  // model; the post-await call falls back to `entry.model` and never passes
  // "unknown" (kept for symmetry, not as the primary path).
  const entryModelFresh = (model) =>
    !entry?.model ||
    entry.model === "unknown" ||
    model === "unknown" ||
    entry.model === model;

  const remaining = Math.max(0, (deadline || 0) - Date.now());
  const budget = Math.min(V2_FALLBACK_TIMEOUT_MS, remaining);

  // The attribution/model caches survive across requests for the lifetime of a
  // plugin instance. When cold — and while budget remains — resolve the session
  // live so the [sub:<agent>] attribution and the model stay correct even if
  // state.json is stale. ParentID comes from state.json ONLY (entry?.parentID)
  // so the table is root-consistent; in-memory sessionParentCache is cross-session
  // and must NOT be used for attribution.
  //
  // A state.json entry that already carries the agent/model counts as warm, and
  // one live attempt per session is enough: this path is polled (the Desktop
  // panel calls it every 1.5 s) and a session this instance never observed live
  // would otherwise issue session.get() on every poll, for the root and every
  // descendant.
  const needEnrich =
    !enrichAttempted.has(sessionID) &&
    ((!sessionAgentCache.has(sessionID) && !entry?.agent) ||
      (lastKnownModel(sessionID) === "unknown" && !entry?.model));

  // Fallback categories only when neither the live cache nor a state snapshot
  // has them: derive user/assistant/reasoning/tool-args from the persisted
  // message list (system/tool-schemas stay null there).
  const needFallback = !bd && !(entryModelFresh(cachedModel) && entry?.categories);

  // Enrichment and the context fallback run CONCURRENTLY, both bounded by the
  // shared budget. Non-fatal: any failure resolves to null and keeps whatever
  // the cache / state.json already provides.
  if (needEnrich && budget > 0) markEnrichAttempted(sessionID);
  const [live, contextMsgs] = await Promise.all([
    needEnrich && budget > 0
      ? withTimeout(ctx.session.get({ sessionID }), budget, "session.get").then(
          (info) => info?.data ?? info ?? null,
          (err) => {
            logErr(`context-report: session.get enrichment failed for ${sessionID}`, err);
            return null;
          },
        )
      : null,
    needFallback && budget > 0
      ? withTimeout(ctx.session.context({ sessionID }), budget, "session.context").then(
          (res) => (Array.isArray(res) ? res : res?.data),
          (err) => {
            logErr(`context-report: session.context fallback failed for ${sessionID}`, err);
            return null;
          },
        )
      : null,
  ]);

  let categories = null;
  let source = "none";
  let fallbackParts = null;
  const liveModel =
    live?.model && typeof live.model === "object" ? live.model : null;
  // Re-read AFTER the awaits: a hook may have resolved the model (or switched
  // it) while the live lookups were in flight. A breakdown cached for the model
  // we assumed a moment ago must not be shown under the resolved one.
  const latestModel = lastKnownModel(sessionID);
  const modelID =
    latestModel !== "unknown"
      ? latestModel
      : liveModel?.id || entry?.model || "unknown";
  if (modelID !== cachedModel) bd = breakdownForModel(sessionID, modelID);
  // In-memory breakdown priority. Hook data (the full request payload: system
  // prompt AND tool schemas) wins outright. The client-context fallback only
  // fills a session that has no hook-measured categories: it is rebuilt from the
  // persisted messages, so it cannot see the system prompt or the tool schemas -
  // reporting them as 0 would push their whole mass into `other` and make a
  // second instance (the Desktop window's, which answered the RPC without ever
  // running the hook) show 0 / 0 / inflated-other for a session that state.json
  // measured correctly.
  //
  // A state entry is hook-measured when it carries a hook-family provenance
  // (`source`, see isHookSource: the V2 context / compaction hooks and the V1
  // transform hooks), or - for legacy entries without `source` - when
  // system/tool schemas are non-null (only a hook can estimate those). An entry
  // written by the fallback stays a fair game for a newer fallback: it is the
  // best data available for that session.
  const entryHookMeasured = entryModelFresh(modelID) && isHookMeasuredEntry(entry);
  const bdFromHook = !!bd && isHookSource(bd.source);
  const useBd = !!bd && (bdFromHook || !entryHookMeasured);
  if (useBd) {
    // Sanitise: every value reaches a markdown/log sink and must be a number.
    categories = safeCategories(
      breakdownCategories(bd, lastKnownInput(sessionID) || entry?.input || 0),
    );
    source = bd.source || "live";
  } else if (entryModelFresh(modelID) && entry?.categories) {
    // state.json is untrusted input: coerce the 7 fields to sane numbers.
    categories = safeCategories(entry.categories);
    source = "snapshot";
  } else if (Array.isArray(contextMsgs)) {
    fallbackParts = estimateBreakdownFromClientMessages(contextMsgs);
    categories = safeCategories(breakdownCategories(fallbackParts, 0));
    source = "client-context";
  } else {
    // No live cache, no usable state.json categories (missing, or measured for
    // another model), and the bounded session.context fallback produced no
    // usable messages (it failed or had no budget left): every branch above
    // leaves `categories` null here.
    // The category cells stay n/a; ctx/model/updatedAt still come from
    // state.json / the live lookup.
    source = "no-data";
  }

  const providerID =
    lastKnownProvider(sessionID) || liveModel?.providerID || entry?.providerID || "";
  const ctxTokens = lastKnownCtx(sessionID) || entry?.ctx || 0;
  const usableInfo = getUsableContext(providerID, modelID, undefined, locationDirectory(ctx));
  const usable =
    usableInfo?.usable ?? entry?.usable ?? getModelLimit(providerID, modelID) ?? null;
  const reserve =
    usableInfo?.reserved != null
      ? usableInfo.reserved
      : Number.isFinite(entry?.reserve) && entry.reserve > 0
        ? entry.reserve
        : null;
  const parentID = entry?.parentID ?? null;
  const updatedAt =
    entry?.updatedAt ||
    (bd?.capturedAt ? new Date(bd.capturedAt).toISOString() : null);
  const entryFresh = entryModelFresh(modelID);
  const toolOutByTool = useBd
    ? safeToolOutByTool(bd.toolOutByTool)
    : (entryFresh ? safeToolOutByTool(entry?.toolOutByTool) : null) ||
      safeToolOutByTool(bd?.toolOutByTool) ||
      safeToolOutByTool(fallbackParts?.toolOutByTool);
  const compactStale = entry?.compactStale === true;
  // Provider-reported prompt cache (exact; subset of input). Live cache first,
  // then the persisted snapshot.
  const cacheRead =
    safeSaneOrNull(lastKnownCacheRead(sessionID)) ??
    safeSaneOrNull(entry?.cacheRead);
  const cacheWrite =
    safeSaneOrNull(lastKnownCacheWrite(sessionID)) ??
    safeSaneOrNull(entry?.cacheWrite);
  // Redundant tool output. The live breakdown owns targets; the persisted entry
  // has them stripped (path-free) — sanitise both. The fallback-derived entry
  // loses to the persisted one, for the same reason as the categories above.
  const reclaim = useBd
    ? safeReclaim(bd.reclaim, true)
    : safeReclaim(entryFresh ? entry?.reclaim : null, false) ||
      safeReclaim(bd?.reclaim, false);
  // Previous distinct measurement (state.json only) for /context-diff.
  const previous = safeSnapshot(entry?.previous);
  return {
    sessionID,
    parentID,
    agent: sessionAgentCache.get(sessionID) || entry?.agent || null,
    modelID,
    providerID,
    ctxTokens,
    inputTokens: lastKnownInput(sessionID) || entry?.input || 0,
    usable,
    reserve,
    categories,
    previous,
    toolOutByTool,
    reclaim,
    cacheRead,
    cacheWrite,
    compactStale,
    source,
    updatedAt,
  };
}

// Root report plus the reports of every descendant that has a measurement,
// collected in parallel under one shared wall-clock budget. Shared by the
// Desktop RPC (lib/desktop.js) and the unit harness, so it exists once.
async function collectFamilyReports(ctx, sessionID, budgetMs) {
  const state = readStateSnapshot();
  const childIDs = collectDescendantSessionIDs(sessionID, state);
  const deadline = Date.now() + (budgetMs || COMMAND_COLLECT_BUDGET_MS);
  const [root, ...children] = await Promise.all([
    collectSessionReport(ctx, sessionID, state, deadline),
    ...childIDs.map((cid) => collectSessionReport(ctx, cid, state, deadline)),
  ]);
  return { root, children };
}

// Signed token delta ("+1.2k" / "-340" / "0").
function fmtDelta(n) {
  if (!Number.isFinite(n) || n === 0) return "0";
  return `${n > 0 ? "+" : "-"}${fmt(Math.abs(n))}`;
}

// /context-diff body: the previous distinct measurement vs the current one.
// Compares ctx (the whole prompt) plus every category; rows whose value did not
// change are omitted to keep the answer short.
const DIFF_CATEGORIES = [
  "user",
  "assistant",
  "reasoning",
  "toolArgs",
  "toolOut",
  "system",
  "toolSchemas",
  "other",
];

function renderContextDiff(r) {
  const model = safeCell(
    r?.modelID && r.modelID !== "unknown" ? r.modelID : "unknown model",
  );
  const lines = [`**Context diff** — ${model}`];
  const prev = r?.previous || null;
  if (!prev) {
    lines.push("_No previous measurement yet — the next write will produce one._");
    const pct =
      r?.usable && r.usable > 0
        ? ` (${((r.ctxTokens / r.usable) * 100).toFixed(0)}%)`
        : "";
    lines.push(`now ${fmt(r?.ctxTokens || 0)}${pct}`);
    return lines.join("\n");
  }
  const ctxDelta = (r.ctxTokens || 0) - prev.ctx;
  const ctxPct =
    prev.ctx > 0
      ? ` (${fmtDelta(ctxDelta)} tokens, ${ctxDelta > 0 ? "+" : ""}${((ctxDelta / prev.ctx) * 100).toFixed(0)}%)`
      : ` (${fmtDelta(ctxDelta)} tokens)`;
  lines.push(`total ${fmt(prev.ctx)} -> ${fmt(r.ctxTokens || 0)}${ctxPct}`);
  const modelChanged = prev.model !== (r.modelID || "unknown");
  if (modelChanged) {
    lines.push(`model ${safeCell(prev.model)} -> ${model}`);
  }
  // Category cells are model-dependent (system prompt, tool schemas and even
  // the tokeniser change with the model). A previous FROM A DIFFERENT MODEL is
  // not a comparable baseline, so print the window change only instead of
  // fake per-category deltas.
  const rows = [];
  for (const key of modelChanged ? [] : DIFF_CATEGORIES) {
    const before = prev.categories ? prev.categories[key] : null;
    const now = r.categories ? r.categories[key] : null;
    if (before == null && now == null) continue;
    // A null on either side means "not measured then" (legacy entry, or the
    // hook-only system/toolSchemas cells). Do NOT read it as 0 — that would
    // turn the first measurement into a fake gain.
    const bothKnown = before != null && now != null;
    const delta = bothKnown ? now - before : null;
    if (bothKnown && delta === 0) continue;
    rows.push(
      `| ${key} | ${fmtCell(before)} | ${fmtCell(now)} | ${delta == null ? "n/a" : fmtDelta(delta)} |`,
    );
  }
  if (modelChanged) {
    lines.push("");
    lines.push(
      "_Categories are not comparable across models; showing the window change only._",
    );
  } else if (rows.length > 0) {
    lines.push("");
    lines.push("| category | previous | now | delta |");
    lines.push("| --- | --- | --- | --- |");
    lines.push(...rows);
  } else {
    lines.push("");
    lines.push("_No category change._");
  }
  lines.push("");
  lines.push(
    `_previous ${timeOnly(prev.updatedAt)} · current ${timeOnly(r.updatedAt)} · tokens are estimates._`,
  );
  return lines.join("\n");
}

// Shared delivery via ctx.session.synthetic — a synthetic message ALWAYS enters
// the session inbox; `resume` only gates whether the session is woken:
//   resume:false -> durable notice, session NOT woken (LLM context unchanged);
//   resume:true  -> same inbox item PLUS a wake, i.e. an agent turn runs and the
//                   session context grows (a real LLM request is issued).
// Returns true on success. On failure the user sees nothing, so we log a loud,
// actionable error; the payload is still written to the human-readable log by the
// caller (there is no other verified delivery channel: no noReply/prompt option
// exists in this runtime).
async function deliverSynthetic(ctx, sid, text, description, resume) {
  try {
    await ctx.session.synthetic({ sessionID: sid, text, description, resume });
    return true;
  } catch (err) {
    logErr(
      `context command: session.synthetic FAILED (session=${sid}, ` +
        `resume=${resume}) — no message delivered; payload preserved in the context log`,
      err,
    );
    return false;
  }
}

// PAYLOAD SHAPE for the model-rendered command: data FIRST, one short
// imperative LAST.
//
// The previous shape opened with "Output the content between the tags below
// exactly, verbatim ..." and models regularly echoed that sentence (or added a
// preamble) into the assistant message. Leading with the payload leaves nothing
// to quote before it, and the trailing line is the last thing the model reads -
// the position it follows most reliably. The tags stay: they mark the payload
// boundary and let a model that does echo the wrapper be trimmed downstream.
//
// The tail is now ONE short clause. The earlier four-clause version ("... no
// tags, no preamble, no commentary, and do not repeat this line") gave the model
// more text to paraphrase back; there is no way to remove the echo entirely -
// a visible table requires a model turn (a `resume:false` notice renders only
// the description chip, see README), so the tail is kept minimal on purpose.
const REPLY_ONLY = "Reply with only the content above.";

function taggedPayload(tag, body) {
  return `<${tag}>\n${body}\n</${tag}>\n\n${REPLY_ONLY}`;
}

// ---- /context-diff : what changed since the previous measurement ----

// Main session only, cache + state.json only: the previous and current
// measurements already live in the shared snapshot, so no RPC is needed.
async function commandContextDiff(ctx, invocation, opts) {
  const name = opts?.name || "context-diff";
  const sid = invocation?.sessionID || invocation?.session?.id;
  if (!sid) {
    logErr("context-diff: invocation carried no sessionID");
    return;
  }
  try {
    const state = readStateSnapshot();
    const report = await collectSessionReport(ctx, sid, state, 0);
    const body = renderContextDiff(report);
    const text = taggedPayload("context-diff", body);
    const prev = report.previous;
    const description = prev
      ? `Context diff: ${fmt(prev.ctx)} -> ${fmt(report.ctxTokens)} (${fmtDelta(report.ctxTokens - prev.ctx)})`
      : "Context diff: no previous measurement yet";
    const delivered = await deliverSynthetic(ctx, sid, text, description, true);
    const sidLog = oneLine(sid);
    pushFinalSummary(`cmd:${sidLog}:${Date.now()}`, [
      `[${new Date().toISOString()}] COMMAND ${name} session=${sidLog} delivered=${delivered}`,
      ...body.split("\n"),
    ]);
  } catch (err) {
    logErr("context-diff command failed", err);
  }
}

export {
  commandContextDiff,
  REPLY_ONLY,
  taggedPayload,
  collectFamilyReports,
  collectSessionReport,
  renderContextDiff,
};
