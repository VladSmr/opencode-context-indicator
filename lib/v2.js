// lib/v2.js
//
// The V2 (opencode >= 2.0.16 / Desktop) path: the context hook estimator and
// handler, the bounded session.context fallback, the event-driven subagent
// roll-up, the live log assembly, and handleV2Event. No toasts on this path
// (the Desktop exposes no TUI channel). Extracted 1:1 (code + WHY comments)
// from index.js.

import {
  breakdownCategories,
  computeReclaim,
  contentFingerprint,
  estJson,
  estimateTokens,
  extractToolTarget,
  fmt,
  isSafeSessionKey,
  oneLine,
  safeSaneOrNull,
  tokenCountOf,
  TOOL_OUT_MAX_KEYS,
  withTimeout,
} from "./estimate.js";
import {
  BREAKDOWN_THROTTLE_MS,
  breakdownCache,
  clearSessionTracking,
  ERROR_TOAST_DEDUP_MS,
  lastBdWrite,
  lastKnownCtx,
  lastKnownCtxCache,
  lastCompactionHookAt,
  lastKnownCacheRead,
  lastKnownCacheReadCache,
  lastKnownCacheWrite,
  lastKnownCacheWriteCache,
  lastKnownInput,
  lastKnownInputCache,
  lastKnownModel,
  lastKnownModelCache,
  lastKnownProvider,
  lastKnownProviderCache,
  lastKnownReasoning,
  lastKnownReasoningCache,
  MAX_TRACKED_SESSIONS,
  sessionAgentCache,
  sessionParentCache,
  sessionTotals,
  toolSchemasBySession,
  TOOL_SCHEMA_TTL_MS,
  v2ContextFetchTimes,
} from "./cache.js";
import {
  ensureModelLimits,
  getModelLimit,
  getUsableContext,
} from "./limits.js";
import {
  debugEvent,
  logErr,
  pushFinalSummary,
  writeLog,
  writeStateFile,
} from "./state.js";
import { pruneMap } from "./dedup.js";

const V2_CONTEXT_FETCH_THROTTLE_MS = 5000; // min gap between fallback fetches
// Background fallback requests are fire-and-forget (see the callers in the
// event handlers): cap each at 3s so a slow/hung client cannot pin resources.
const V2_FALLBACK_TIMEOUT_MS = 3000;

// Window within which a `session.compacted` EVENT is considered already handled
// by the preceding `compaction` HOOK: if the hook marked the entry recently, the
// event only logs + clears tracking instead of re-persisting the snapshot.
const COMPACTION_HOOK_FALLBACK_MS = 60000;

// Estimate the per-category breakdown directly from a V2 SessionContext.
// `context.messages` are @opencode/ai Message objects:
//   { role, content: [ {type:"text",text} | {type:"media"} |
//                      {type:"tool-call",input} | {type:"tool-result",result} |
//                      {type:"reasoning",text} | ... ] }
// `context.system` are SystemPart[] { type:"text", text }.
// `context.tools` is Record<name, { description, input: JsonSchema }>.
// Tool RESULTS are counted into the toolOut category (the payload the model
// sees back: webfetch pages, file reads, subagent reports); tool call ARGS are
// counted separately. Every returned *Chars value is a TOKEN estimate (unicode
// heuristic).
//
// `sessionID` is optional; when given, the tool-schema estimate is cached
// per-session (see toolSchemasBySession) and reused while the cheap fingerprint
// is unchanged and the TTL has not elapsed — so the expensive estJson pass over
// every schema does not run on every single model request.
// Cheap structural fingerprint of the tool schema map: count + total description
// length + number of schema property keys + two O(n) charCode checksums (mod
// 0xFFFFFF) over every description and over the PARAMETER names
// (input.properties keys). The checksums widen the fingerprint so two different
// schemas that happen to share the same length/key counts do not collide into a
// wrong cache hit — without paying for full JSON.stringify (the whole point of
// the cache).
function toolsFingerprint(tools) {
  if (!tools || typeof tools !== "object") return "none";
  let n = 0;
  let descLen = 0;
  let propKeys = 0;
  let descHash = 0;
  let keyHash = 0;
  for (const t of Object.values(tools)) {
    n++;
    const d = t?.description;
    if (typeof d === "string") {
      descLen += d.length;
      for (let i = 0; i < d.length; i++) {
        descHash = (descHash + d.charCodeAt(i)) & 0xffffff;
      }
    }
    const input = t?.input;
    if (input && typeof input === "object") {
      const props = input.properties;
      // Hash the PARAMETER names (input.properties keys) when present — a
      // property rename that keeps the same count/description must change the
      // fingerprint, or the TTL cache would serve a stale schema estimate.
      // Fall back to the top-level schema keys for schemas without `properties`.
      const nameSource =
        props && typeof props === "object"
          ? Object.keys(props)
          : Object.keys(input);
      propKeys += nameSource.length;
      for (const k of nameSource) {
        for (let i = 0; i < k.length; i++) {
          keyHash = (keyHash + k.charCodeAt(i)) & 0xffffff;
        }
      }
    }
  }
  return `${n}:${descLen}:${propKeys}:${descHash}:${keyHash}`;
}

// Token estimate for one ToolResultPart (@opencode/ai schema/messages.d.ts):
//   result: {type:"text",value} | {type:"json",value} | {type:"error",value}
//         | {type:"content",value:[{type:"text",text}|{type:"file",uri,mime}]}
// json / error payloads and non-string text values go through estJson; string
// values through the char estimator. `content` file items are URI references,
// not inline bytes — deliberately skipped (a data-URL base64 blob is consumed
// by the model as media tokens, not as text the char heuristic can price).
function toolResultChars(p) {
  const r = p?.result;
  if (!r || typeof r !== "object") return 0;
  if (r.type === "content" && Array.isArray(r.value)) {
    let n = 0;
    for (const item of r.value) {
      if (item?.type === "text") n += estimateTokens(item.text);
    }
    return n;
  }
  if (r.type === "text" && typeof r.value === "string") {
    return estimateTokens(r.value);
  }
  return estJson(r.value); // json | error | unexpected shapes
}

// Concatenated text of a ToolResultPart payload, for content FINGERPRINTING
// (bounded — the first ~4KB is enough to spot byte-identical outputs). Mirrors
// the shapes handled by toolResultChars; file items are URI references, skipped.
function toolResultText(p) {
  const r = p?.result;
  if (!r || typeof r !== "object") return "";
  if (r.type === "content" && Array.isArray(r.value)) {
    let out = "";
    for (const item of r.value) {
      if (item?.type === "text" && typeof item.text === "string") {
        out += item.text;
        if (out.length > 4096) break;
      }
    }
    return out;
  }
  if (r.type === "text" && typeof r.value === "string") return r.value;
  try {
    return JSON.stringify(r.value);
  } catch {
    return "";
  }
}

// Bound on tool-call instances tracked per request for waste detection (the
// message history is untrusted and a runaway session could be huge).
const MAX_WASTE_INSTANCES = 256;

// Accumulate the per-tool tool-result estimate. Tool names are untrusted
// (host tool ids, plugin-defined tools): unsafe names and any name beyond the
// cap fold into "other tools" so the bucket never becomes a prototype vector
// and the map stays bounded. The sum of the map mirrors the toolOut category.
// The cap is the SHARED TOOL_OUT_MAX_KEYS (lib/estimate.js) so the accumulation
// bound and the persisted/displayed bound can never drift apart.
function addToolOut(map, name, chars) {
  if (!(chars > 0)) return;
  const safe =
    isSafeSessionKey(name) && name.length <= 64 ? name : "other tools";
  if (
    safe !== "other tools" &&
    !Object.prototype.hasOwnProperty.call(map, safe) &&
    Object.keys(map).length >= TOOL_OUT_MAX_KEYS
  ) {
    map["other tools"] = (map["other tools"] || 0) + chars;
    return;
  }
  map[safe] = (map[safe] || 0) + chars;
}

// Bounded candidate list for the "top context consumers" section: the heaviest
// single units still in the assembled request (one tool output, one message,
// the system prompt, one tool-call's args). The list is capped: once full, a new
// item replaces the lightest candidate only when it is heavier, so a runaway
// session cannot grow the array without bound while the true top-N is kept.
const MAX_TOP_CANDIDATES = 256;
const TOP_N = 5;

function pushTopCandidate(list, kind, tokens, name, target) {
  const t = Math.round(tokens);
  if (!(t > 0)) return;
  const item = { kind, tokens: t };
  if (typeof name === "string" && name.length > 0) item.name = name;
  if (typeof target === "string" && target.length > 0) item.target = target;
  if (list.length < MAX_TOP_CANDIDATES) {
    list.push(item);
    return;
  }
  let min = 0;
  for (let i = 1; i < list.length; i++) {
    if (list[i].tokens < list[min].tokens) min = i;
  }
  if (t > list[min].tokens) list[min] = item;
}

function selectTopConsumers(list) {
  return list.slice().sort((a, b) => b.tokens - a.tokens).slice(0, TOP_N);
}

function estimateBreakdownFromContext(context, sessionID) {
  let userChars = 0;
  let assistantChars = 0;
  let reasoningChars = 0;
  let toolArgsChars = 0;
  let toolOutChars = 0;
  const toolOutByTool = {};
  const topCandidates = [];

  const messages = Array.isArray(context?.messages) ? context.messages : [];
  // Waste detection: correlate tool-call (input -> target) with its tool-result
  // (-> tokens + content fingerprint) by call id, over the calls still present
  // in the assembled context.
  const callById = new Map();
  const instances = [];
  for (const msg of messages) {
    const parts = Array.isArray(msg?.content) ? msg.content : [];
    for (const p of parts) {
      // Tool results arrive in dedicated tool-result parts; the message ROLE
      // carrying them varies by host version (user, assistant, or the dedicated
      // "tool" role) — count them role-independently.
      if (p?.type === "tool-result") {
        const chars = toolResultChars(p);
        toolOutChars += chars;
        addToolOut(toolOutByTool, p?.name, chars);
        const call = p?.id != null ? callById.get(p.id) : null;
        const name = p?.name || call?.name || null;
        const target = extractToolTarget(name, call?.input);
        pushTopCandidate(topCandidates, "tool", chars, name, target);
        if (chars > 0 && instances.length < MAX_WASTE_INSTANCES) {
          instances.push({
            name,
            target,
            tokens: chars,
            fp: contentFingerprint(toolResultText(p)),
          });
        }
        continue;
      }
      if (msg?.role === "user") {
        if (p?.type === "text") {
          const t = estimateTokens(p.text);
          userChars += t;
          pushTopCandidate(topCandidates, "user", t);
        }
      } else if (msg?.role === "assistant") {
        if (p?.type === "text") {
          const t = estimateTokens(p.text);
          assistantChars += t;
          pushTopCandidate(topCandidates, "assistant", t);
        } else if (p?.type === "reasoning") {
          const t = estimateTokens(p.text);
          reasoningChars += t;
          pushTopCandidate(topCandidates, "reasoning", t);
        } else if (p?.type === "tool-call") {
          const t = estJson(p.input);
          toolArgsChars += t;
          pushTopCandidate(
            topCandidates,
            "args",
            t,
            p?.name,
            extractToolTarget(p?.name, p?.input),
          );
          if (p?.id != null && callById.size < MAX_WASTE_INSTANCES && !callById.has(p.id)) {
            callById.set(p.id, { name: p.name, input: p.input });
          }
        }
      }
    }
  }
  const reclaimRaw = instances.length > 0 ? computeReclaim(instances) : null;
  const reclaim = reclaimRaw && reclaimRaw.tokens > 0 ? reclaimRaw : null;

  let systemChars = 0;
  const system = Array.isArray(context?.system) ? context.system : [];
  for (const s of system) systemChars += estimateTokens(s?.text);
  pushTopCandidate(topCandidates, "system", systemChars);

  let toolSchemasChars = 0;
  const tools = context?.tools;
  if (tools && typeof tools === "object") {
    const fp = toolsFingerprint(tools);
    const cached = sessionID ? toolSchemasBySession.get(sessionID) : null;
    if (
      cached &&
      cached.toolsFingerprint === fp &&
      Date.now() - cached.at < TOOL_SCHEMA_TTL_MS
    ) {
      toolSchemasChars = cached.toolSchemasChars; // unchanged schemas -> reuse
    } else {
      for (const t of Object.values(tools)) {
        toolSchemasChars += estimateTokens(t?.description) + estJson(t?.input);
      }
      if (sessionID) {
        toolSchemasBySession.set(sessionID, {
          toolSchemasChars,
          toolsFingerprint: fp,
          at: Date.now(),
        });
        pruneMap(toolSchemasBySession, MAX_TRACKED_SESSIONS);
      }
    }
  }

  return {
    userChars,
    assistantChars,
    reasoningChars,
    toolArgsChars,
    toolOutChars,
    toolOutByTool,
    systemChars,
    toolSchemasChars,
    reclaim,
    top: selectTopConsumers(topCandidates),
  };
}

// V2 context hook handler: capture the final messages / system prompt / tool
// schemas + the request model. READ-ONLY — the context object is never mutated.
function onV2Context(context) {
  try {
    if (!context || typeof context !== "object") return;
    const sid = context.sessionID;
    if (!sid) return;

    const parts = estimateBreakdownFromContext(context, sid);
    breakdownCache.set(sid, {
      ...parts,
      capturedAt: Date.now(),
      source: "context-hook",
    });
    pruneMap(breakdownCache, MAX_TRACKED_SESSIONS);

    const model = context.model;
    if (model && typeof model === "object") {
      if (typeof model.id === "string") lastKnownModelCache.set(sid, model.id);
      if (typeof model.providerID === "string") {
        lastKnownProviderCache.set(sid, model.providerID);
      }
      pruneMap(lastKnownModelCache, MAX_TRACKED_SESSIONS);
      pruneMap(lastKnownProviderCache, MAX_TRACKED_SESSIONS);
    }
  } catch (err) {
    logErr("v2 context hook failed", err);
  }
}

// V2 compaction hook handler: opencode dispatches `compaction` at the START of a
// compaction request with the SAME pre-compaction payload as the context hook
// (system / messages / tools / model). We use it to persist the TRUE
// pre-compaction breakdown instead of relying on the `session.compacted` event
// to re-persist whatever a previous request left behind.
//
// The entry is marked stale BY CONSTRUCTION (the context is about to be
// compacted, so the numbers change once the summary lands and the next context
// hook fires). Guard: the hook also fires for a NO-OP compaction ("Nothing to
// compact yet") on a session with no completed request — there is no measured
// context to mark, so we only cache and skip the state write (no fake stale
// badge).
function onV2Compaction(context) {
  try {
    if (!context || typeof context !== "object") return;
    const sid = context.sessionID;
    if (!sid) return;

    const parts = estimateBreakdownFromContext(context, sid);
    breakdownCache.set(sid, {
      ...parts,
      capturedAt: Date.now(),
      source: "compaction-hook",
    });
    pruneMap(breakdownCache, MAX_TRACKED_SESSIONS);

    const model = context.model;
    if (model && typeof model === "object") {
      if (typeof model.id === "string") lastKnownModelCache.set(sid, model.id);
      if (typeof model.providerID === "string") {
        lastKnownProviderCache.set(sid, model.providerID);
      }
      pruneMap(lastKnownModelCache, MAX_TRACKED_SESSIONS);
      pruneMap(lastKnownProviderCache, MAX_TRACKED_SESSIONS);
    }

    // Arm the fallback guard for the trailing `session.compacted` event.
    lastCompactionHookAt.set(sid, Date.now());
    pruneMap(lastCompactionHookAt, MAX_TRACKED_SESSIONS);

    const ctxTokens = lastKnownCtx(sid);
    if (ctxTokens > 0) {
      const lines = buildLiveLinesV2(
        sid,
        lastKnownModel(sid),
        lastKnownProvider(sid),
        lastKnownInput(sid),
        ctxTokens,
        lastKnownReasoning(sid),
      );
      writeStateFile(
        sid,
        lastKnownModel(sid),
        lastKnownProvider(sid),
        lastKnownInput(sid),
        ctxTokens,
        lastKnownReasoning(sid),
        {
          compacted: true,
          cacheRead: lastKnownCacheRead(sid),
          cacheWrite: lastKnownCacheWrite(sid),
        },
      );
      // Claim key derived from the PAYLOAD shape (message count + total
      // estimated chars): identical across plugin instances for the SAME
      // compaction (cross-instance dedup preserved) yet distinct per compaction
      // — a session-only key would log just the first compaction on a session.
      const messages = Array.isArray(context.messages) ? context.messages : [];
      const sig =
        `${messages.length}:` +
        (parts.userChars +
          parts.assistantChars +
          parts.reasoningChars +
          parts.toolArgsChars +
          parts.toolOutChars +
          (parts.systemChars || 0) +
          (parts.toolSchemasChars || 0));
      pushFinalSummary(`compaction-hook:${sid}:${sig}`, [
        `[${new Date().toISOString()}] COMPACTION (hook) session=${sid} — pre-compaction snapshot captured`,
        ...lines.slice(1),
      ]);
    }
  } catch (err) {
    logErr("v2 compaction hook failed", err);
  }
}

// ---------------------------------------------------------------------------
// V2 fallback: derive the message-based categories from the session's persisted
// message list when the context hook did NOT populate the cache for this
// session. This happens when the request was served by a DIFFERENT plugin
// instance (the public event stream is mirrored to every instance, but the
// breakdown cache is process-local) or when the hook did not fire at all.
//
// Only user / assistant / reasoning / tool-args / tool-OUT can be derived from
// the persisted SessionMessageInfo[]: the ASSEMBLED system prompt and the tool
// schemas are exclusive to the context hook, so they stay null ("n/a" in the
// sidebar) unless the hook ran. Tool RESULTS are counted from the resolved
// `state.content` (ToolContent[]) of completed / errored tool parts.
function estimateBreakdownFromClientMessages(messages) {
  let userChars = 0;
  let assistantChars = 0;
  let reasoningChars = 0;
  let toolArgsChars = 0;
  let toolOutChars = 0;
  const toolOutByTool = {};
  const instances = [];
  const topCandidates = [];
  for (const m of messages || []) {
    if (!m || typeof m !== "object") continue;
    if (m.type === "user") {
      const t = estimateTokens(m.text);
      userChars += t;
      pushTopCandidate(topCandidates, "user", t);
    } else if (m.type === "assistant") {
      const parts = Array.isArray(m.content) ? m.content : [];
      for (const p of parts) {
        if (p?.type === "text") {
          const t = estimateTokens(p.text);
          assistantChars += t;
          pushTopCandidate(topCandidates, "assistant", t);
        } else if (p?.type === "reasoning") {
          const t = estimateTokens(p.text);
          reasoningChars += t;
          pushTopCandidate(topCandidates, "reasoning", t);
        } else if (p?.type === "tool") {
          // state.input is a string while streaming; only count the resolved
          // object (running/completed/error) to avoid partial counts.
          const input = p?.state?.input;
          if (input && typeof input === "object") {
            const t = estJson(input);
            toolArgsChars += t;
            pushTopCandidate(
              topCandidates,
              "args",
              t,
              p?.name,
              extractToolTarget(p?.name, input),
            );
          }
          // Tool results: completed / errored states carry the payload in
          // state.content (ToolContent[]: {type:"text",text}|{type:"file"}) —
          // NOT state.output (that field does not exist on SessionMessageInfo).
          // Count text items; file items are URI references, skipped (same
          // policy as the hook path).
          const content = p?.state?.content;
          if (Array.isArray(content)) {
            let outChars = 0;
            let text = "";
            for (const item of content) {
              if (item?.type === "text" && typeof item.text === "string") {
                outChars += estimateTokens(item.text);
                if (text.length <= 4096) text += item.text;
              }
            }
            toolOutChars += outChars;
            // The persisted tool part carries its name on `p.name`
            // (SessionMessageAssistantTool.name) — same field as the hook path.
            addToolOut(toolOutByTool, p?.name, outChars);
            const target = extractToolTarget(p?.name, input);
            pushTopCandidate(topCandidates, "tool", outChars, p?.name, target);
            if (outChars > 0 && instances.length < MAX_WASTE_INSTANCES) {
              instances.push({
                name: p?.name || null,
                target,
                tokens: outChars,
                fp: contentFingerprint(text),
              });
            }
          }
        }
      }
    }
  }
  const reclaimRaw = instances.length > 0 ? computeReclaim(instances) : null;
  const reclaim = reclaimRaw && reclaimRaw.tokens > 0 ? reclaimRaw : null;
  return {
    userChars,
    assistantChars,
    reasoningChars,
    toolArgsChars,
    toolOutChars,
    toolOutByTool,
    systemChars: null,
    toolSchemasChars: null,
    reclaim,
    top: selectTopConsumers(topCandidates),
  };
}

// Fill breakdownCache for a session when the context hook has not already done
// so. Throttled, fault-tolerant, READ-ONLY. Hook data always wins.
async function ensureV2Breakdown(ctx, sessionID) {
  if (!sessionID) return;
  const cached = breakdownCache.get(sessionID);
  if (cached && cached.source === "context-hook") return; // hook data wins
  const now = Date.now();
  if (
    now - (v2ContextFetchTimes.get(sessionID) || 0) <
    V2_CONTEXT_FETCH_THROTTLE_MS
  ) {
    return;
  }
  v2ContextFetchTimes.set(sessionID, now);
  pruneMap(v2ContextFetchTimes, MAX_TRACKED_SESSIONS);
  try {
    const res = await withTimeout(
      ctx.session.context({ sessionID }),
      V2_FALLBACK_TIMEOUT_MS,
      "session.context",
    );
    const msgs = Array.isArray(res) ? res : res?.data;
    if (Array.isArray(msgs)) {
      // Re-check AFTER the await: the context hook may have populated the cache
      // while this fetch was in flight — hook data must win and must never be
      // overwritten by a late fallback.
      const latest = breakdownCache.get(sessionID);
      if (!latest || latest.source !== "context-hook") {
        breakdownCache.set(sessionID, {
          ...estimateBreakdownFromClientMessages(msgs),
          capturedAt: Date.now(),
          source: "client-context",
        });
        pruneMap(breakdownCache, MAX_TRACKED_SESSIONS);
      }
    }
  } catch (err) {
    logErr("v2 session.context fallback failed", err);
  }
  // Opportunistically resolve the model: Desktop selects it AFTER
  // session.created, so without this (or session.model.selected) a session can
  // stay "unknown" even though its limit is resolvable.
  if (
    !lastKnownModelCache.has(sessionID) ||
    !lastKnownProviderCache.has(sessionID)
  ) {
    try {
      const info = await withTimeout(
        ctx.session.get({ sessionID }),
        V2_FALLBACK_TIMEOUT_MS,
        "session.get",
      );
      const model = info?.model ?? info?.data?.model;
      if (model && typeof model === "object") {
        if (typeof model.id === "string") lastKnownModelCache.set(sessionID, model.id);
        if (typeof model.providerID === "string") {
          lastKnownProviderCache.set(sessionID, model.providerID);
        }
        pruneMap(lastKnownModelCache, MAX_TRACKED_SESSIONS);
        pruneMap(lastKnownProviderCache, MAX_TRACKED_SESSIONS);
      }
    } catch (err) {
      logErr("v2 session.get model fallback failed", err);
    }
  }
}

// V2 subagent aggregation: children are discovered from session.created
// (parentID), their totals accumulated from session.step.ended. No
// session.children/messages API needed. Synchronous (in-memory only).
function aggregateSubagentsV2(sessionID) {
  const result = { count: 0, input: 0, output: 0, reasoning: 0, perChild: [] };
  for (const [childID, parentID] of sessionParentCache) {
    if (parentID !== sessionID) continue;
    result.count++;
    const t = sessionTotals.get(childID);
    if (t) {
      result.input += t.input || 0;
      result.output += t.output || 0;
      result.reasoning += t.reasoning || 0;
      const lim = getModelLimit(t.providerID, t.modelID);
      const ctxTokens = typeof t.ctx === "number" ? t.ctx : 0;
      result.perChild.push({
        id: childID,
        input: ctxTokens,
        limit: lim,
        ratio: lim ? ctxTokens / lim : null,
      });
    } else {
      result.perChild.push({ id: childID, input: 0, limit: null, ratio: null });
    }
  }
  return result;
}

// V2: assemble the live breakdown lines (no client, no fallback fetch —
// the context hook fills breakdownCache on every request).
function buildLiveLinesV2(sessionID, modelID, providerID, inputTokens, ctxTokens, reasoningTokens) {
  const lines = [];
  const ts = new Date().toISOString();
  const limit = getModelLimit(providerID, modelID);
  const usableInfo = getUsableContext(providerID, modelID);
  const total = typeof ctxTokens === "number" && ctxTokens > 0 ? ctxTokens : inputTokens;
  const denom =
    usableInfo != null
      ? usableInfo.usable
      : limit != null && limit > 0
        ? limit
        : null;
  const pct =
    denom != null ? ` (${((total / denom) * 100).toFixed(1)}%)` : "";

  lines.push(
    `[${ts}] session=${sessionID} model=${modelID} ctx=${fmt(total)}/${denom != null ? fmt(denom) : "?"}${pct} count=${fmt(total)} usable=${usableInfo != null ? fmt(usableInfo.usable) : "?"} limit=${limit != null ? fmt(limit) : "?"} maxOutput=${usableInfo != null ? fmt(usableInfo.maxOutput) : "?"} reserved=${usableInfo != null ? fmt(usableInfo.reserved) : "?"} input=${fmt(inputTokens)}`,
  );

  const bd = breakdownCache.get(sessionID);
  const source = bd?.source || "none";
  const rt = typeof reasoningTokens === "number" ? reasoningTokens : 0;

  // Residual = input minus every measured category (shared normaliser; `bd`
  // may be absent -> everything 0 and the residual is the whole input).
  const other = breakdownCategories(bd, inputTokens).other;

  if (bd) {
    lines.push(`  user        ${fmt(bd.userChars || 0)} (est tokens)`);
    lines.push(`  assistant   ${fmt(bd.assistantChars || 0)} (est tokens)`);
    const reasoningNote = rt > 0 ? ` (exact ${fmt(rt)})` : "";
    lines.push(`  reasoning   ${fmt(bd.reasoningChars || 0)} (est tokens)${reasoningNote}`);
    lines.push(`  tool args   ${fmt(bd.toolArgsChars || 0)} (est tokens, input only)`);
    lines.push(
      `  tool results ${fmt(bd.toolOutChars || 0)} (est tokens, outputs fed back)`,
    );
    lines.push(
      bd.systemChars != null
        ? `  system      ${fmt(bd.systemChars)} (est tokens)`
        : `  system      n/a (hook did not run)`,
    );
    lines.push(
      bd.toolSchemasChars != null
        ? `  tool schemas ${fmt(bd.toolSchemasChars)} (est tokens)`
        : `  tool schemas n/a`,
    );
  } else {
    lines.push(`  user        n/a (no breakdown captured yet)`);
    lines.push(`  assistant   n/a`);
    lines.push(`  reasoning   n/a`);
    lines.push(`  tool args   n/a`);
    lines.push(`  tool results n/a`);
    lines.push(`  system      n/a (hook did not run)`);
    lines.push(`  tool schemas n/a`);
  }
  lines.push(`  other       ${fmt(other)} (= input - sum of estimates)`);
  lines.push(`  source      ${source}`);

  // Provider-reported prompt cache (EXACT, not an estimate; a subset of input —
  // never folded into the category sum). Absent when the provider stays silent.
  const cr = lastKnownCacheRead(sessionID);
  const cw = lastKnownCacheWrite(sessionID);
  lines.push(
    cr == null && cw == null
      ? `  prompt cache n/a (provider reported no cache tokens)`
      : `  prompt cache read=${fmt(cr || 0)} write=${fmt(cw || 0)} (provider-reported; subset of input)`,
  );

  // Redundant tool output already in context (repeated target / identical
  // output). An estimate of what trimming/compaction could reclaim.
  const rcl = bd?.reclaim || null;
  if (rcl && rcl.tokens > 0) {
    lines.push(
      `  reclaim     ~${fmt(rcl.tokens)} redundant tool output (${rcl.count} duplicate(s) — estimate)`,
    );
  }

  try {
    const sub = aggregateSubagentsV2(sessionID);
    if (sub.count > 0) {
      const ratios = (sub.perChild || [])
        .map((c) => c?.ratio)
        .filter((r) => typeof r === "number");
      const worst =
        ratios.length > 0
          ? ` worst=${(Math.max(...ratios) * 100).toFixed(0)}%`
          : "";
      lines.push(
        `  subagents   ${sub.count} session(s): in=${fmt(sub.input)} out=${fmt(sub.output)} r=${fmt(sub.reasoning)}${worst}`,
      );
    } else {
      lines.push(`  subagents   0`);
    }
  } catch (err) {
    logErr("v2 subagent aggregation failed", err);
    lines.push(`  subagents   n/a`);
  }

  return lines;
}

// V2 event handler. `event` is a V2Event ({ type, data, ... }).
async function handleV2Event(ctx, event) {
  if (!event || typeof event.type !== "string") return;

  // DEBUG tap (fault-tolerant, off via flag).
  debugEvent(event);

  // --- session lifecycle: parent links + model hints ---
  if (event.type === "session.created") {
    const data = event.data || {};
    const sid = data.sessionID;
    if (!sid) return;
    const parentID = data.parentID || null;
    // sessionParentCache is the durable parent link used when WRITING the
    // state.json entry (writeStateFile); discovery itself reads the persisted
    // parentID chain — see collectDescendantSessionIDs.
    sessionParentCache.set(sid, parentID);
    pruneMap(sessionParentCache, MAX_TRACKED_SESSIONS);
    if (typeof data.agent === "string" && data.agent) {
      sessionAgentCache.set(sid, data.agent);
      pruneMap(sessionAgentCache, MAX_TRACKED_SESSIONS);
    }
    if (data.model && typeof data.model === "object") {
      if (typeof data.model.id === "string") lastKnownModelCache.set(sid, data.model.id);
      if (typeof data.model.providerID === "string") {
        lastKnownProviderCache.set(sid, data.model.providerID);
      }
      pruneMap(lastKnownModelCache, MAX_TRACKED_SESSIONS);
      pruneMap(lastKnownProviderCache, MAX_TRACKED_SESSIONS);
    }
    return;
  }

  // Model chosen after session creation (the normal Desktop flow: the user
  // picks the model in the UI). Without this the session stays "unknown"
  // because session.created carries no model and session.step.ended has no
  // model field.
  if (event.type === "session.model.selected") {
    const d = event.data || {};
    const sid = d.sessionID;
    if (!sid) return;
    if (d.model && typeof d.model === "object") {
      if (typeof d.model.id === "string") lastKnownModelCache.set(sid, d.model.id);
      if (typeof d.model.providerID === "string") {
        lastKnownProviderCache.set(sid, d.model.providerID);
      }
      pruneMap(lastKnownModelCache, MAX_TRACKED_SESSIONS);
      pruneMap(lastKnownProviderCache, MAX_TRACKED_SESSIONS);
    }
    return;
  }

  if (event.type === "session.deleted") {
    const sid = event.data?.sessionID;
    if (!sid) return;
    // Discovery reads the persisted parentID chain, so a deleted session drops
    // out of the table as soon as its state.json entry is gone (or, while the
    // stale entry lingers, via the phantom filter — a deleted session has no
    // step). No dedicated in-memory index to clean up.
    clearSessionTracking(sid);
    return;
  }

  if (event.type === "session.compacted") {
    const sid = event.data?.sessionID;
    if (!sid) return;
    try {
      const lines = buildLiveLinesV2(
        sid,
        lastKnownModel(sid),
        lastKnownProvider(sid),
        lastKnownInput(sid),
        lastKnownCtx(sid),
        lastKnownReasoning(sid),
      );
      // The `compaction` HOOK already captured + persisted the exact
      // pre-compaction snapshot and marked the entry stale. This event is now a
      // FALLBACK: it re-persists only when the hook did NOT fire recently (host
      // gap, mirror instance, or a compaction path that bypassed the hook).
      // Either way the write re-persists the PRE-compaction numbers and marks
      // the entry stale, so the UI shows them as pre-compaction until the next
      // model request refreshes them.
      const hookAt = lastCompactionHookAt.get(sid) || 0;
      const handledByHook = Date.now() - hookAt < COMPACTION_HOOK_FALLBACK_MS;
      if (!handledByHook) {
        writeStateFile(
          sid,
          lastKnownModel(sid),
          lastKnownProvider(sid),
          lastKnownInput(sid),
          lastKnownCtx(sid),
          lastKnownReasoning(sid),
          {
            compacted: true,
            cacheRead: lastKnownCacheRead(sid),
            cacheWrite: lastKnownCacheWrite(sid),
          },
        );
      }
      pushFinalSummary(
        `compacted:${event.id ?? sid}`,
        [
          `[${new Date().toISOString()}] COMPACTED session=${sid} (auto — the context may have overflowed)`,
          ...lines.slice(1),
        ],
      );
    } catch (err) {
      logErr("v2 session.compacted handling failed", err);
    }
    clearSessionTracking(sid, true);
    return;
  }

  if (event.type === "session.idle") {
    const sid = event.data?.sessionID;
    if (!sid) return;
    try {
      // Fire-and-forget: the client-API fallback must NOT block this
      // instance's event loop (it would delay every other session's events).
      // The result is picked up by a later state write; the 5s throttle bounds
      // the cost. Never rejects.
      void ensureV2Breakdown(ctx, sid).catch(() => {});
      const lines = buildLiveLinesV2(
        sid,
        lastKnownModel(sid),
        lastKnownProvider(sid),
        lastKnownInput(sid),
        lastKnownCtx(sid),
        lastKnownReasoning(sid),
      );
      writeStateFile(
        sid,
        lastKnownModel(sid),
        lastKnownProvider(sid),
        lastKnownInput(sid),
        lastKnownCtx(sid),
        lastKnownReasoning(sid),
        {
          cacheRead: lastKnownCacheRead(sid),
          cacheWrite: lastKnownCacheWrite(sid),
        },
      );
      pushFinalSummary(`final:${event.id ?? sid}`, [
        `[${new Date().toISOString()}] FINAL session=${sid}`,
        ...lines.slice(1),
      ]);
    } catch (err) {
      logErr("v2 final summary on idle failed", err);
    }
    clearSessionTracking(sid);
    return;
  }

  // --- finished LLM step: tokens + live breakdown snapshot ---
  if (event.type === "session.step.ended") {
    const data = event.data || {};
    const sid = data.sessionID;
    if (!sid) return;
    const t = data.tokens || {};
    const input = typeof t.input === "number" ? t.input : 0;
    const output = typeof t.output === "number" ? t.output : 0;
    const reasoning = typeof t.reasoning === "number" ? t.reasoning : 0;
    const contextTokens = tokenCountOf(t);
    // Provider-reported prompt-cache figures (exact): a subset of `input`.
    // Sanitised — a NaN/negative/absurd provider value must never be persisted.
    const cacheRead = safeSaneOrNull(t.cache?.read ?? t.cacheRead);
    const cacheWrite = safeSaneOrNull(t.cache?.write ?? t.cacheWrite);

    lastKnownInputCache.set(sid, input);
    lastKnownCtxCache.set(sid, contextTokens);
    lastKnownReasoningCache.set(sid, reasoning);
    if (cacheRead != null) lastKnownCacheReadCache.set(sid, cacheRead);
    if (cacheWrite != null) lastKnownCacheWriteCache.set(sid, cacheWrite);
    if (!lastKnownModelCache.has(sid) && data.model) {
      // Some builds put the model on the step payload; harmless when absent.
      if (typeof data.model.id === "string") lastKnownModelCache.set(sid, data.model.id);
      if (typeof data.model.providerID === "string") {
        lastKnownProviderCache.set(sid, data.model.providerID);
      }
    }
    pruneMap(lastKnownInputCache, MAX_TRACKED_SESSIONS);
    pruneMap(lastKnownCtxCache, MAX_TRACKED_SESSIONS);
    pruneMap(lastKnownReasoningCache, MAX_TRACKED_SESSIONS);
    pruneMap(lastKnownCacheReadCache, MAX_TRACKED_SESSIONS);
    pruneMap(lastKnownCacheWriteCache, MAX_TRACKED_SESSIONS);
    pruneMap(lastKnownModelCache, MAX_TRACKED_SESSIONS);
    pruneMap(lastKnownProviderCache, MAX_TRACKED_SESSIONS);

    // Accumulate per-session totals for parent subagent roll-up.
    const tot = sessionTotals.get(sid) || {
      input: 0,
      output: 0,
      reasoning: 0,
      ctx: 0,
      modelID: null,
      providerID: "",
      at: 0,
    };
    tot.input += input;
    tot.output += output;
    tot.reasoning += reasoning;
    tot.ctx = contextTokens;
    tot.modelID = lastKnownModel(sid);
    tot.providerID = lastKnownProvider(sid);
    tot.at = Date.now();
    sessionTotals.set(sid, tot);
    pruneMap(sessionTotals, MAX_TRACKED_SESSIONS);

    // Ensure limits are available (fault-tolerant; await is cheap after warm).
    try {
      await ensureModelLimits(ctx);
    } catch {
      // ignore — absolute token figures only
    }

    // Make sure a breakdown exists for this session even if the context hook
    // did not fire here (cross-instance mirror / hook gap). Fire-and-forget on
    // purpose: awaiting it would serialize this instance's event handling
    // behind up to the full client timeout. The cached result is written on the
    // NEXT event; the 5s throttle bounds the cost. Never rejects.
    void ensureV2Breakdown(ctx, sid).catch(() => {});

    const now = Date.now();
    const lastWrite = lastBdWrite.get(sid) || 0;
    if (now - lastWrite >= BREAKDOWN_THROTTLE_MS) {
      lastBdWrite.set(sid, now);
      pruneMap(lastBdWrite, MAX_TRACKED_SESSIONS);
      try {
        const lines = buildLiveLinesV2(
          sid,
          lastKnownModel(sid),
          lastKnownProvider(sid),
          input,
          contextTokens,
          reasoning,
        );
        writeStateFile(
          sid,
          lastKnownModel(sid),
          lastKnownProvider(sid),
          input,
          contextTokens,
          reasoning,
          {
            cacheRead: lastKnownCacheRead(sid),
            cacheWrite: lastKnownCacheWrite(sid),
          },
        );
        writeLog(lines);
      } catch (err) {
        logErr("v2 live breakdown write failed", err);
      }
    }
    return;
  }

  // --- failed step / execution: persist a claimed one-line note ---
  if (
    event.type === "session.step.failed" ||
    event.type === "session.execution.failed" ||
    event.type === "session.execution.interrupted"
  ) {
    const data = event.data || {};
    // sid / error text come from the event payload (untrusted): collapse newlines
    // so they cannot forge extra rows in the human-readable log (CWE-117).
    const sid = oneLine(data.sessionID || "?");
    const interrupted = event.type === "session.execution.interrupted";
    const err = data.error || {};
    const name = interrupted
      ? "Interrupted"
      : typeof err.type === "string"
        ? oneLine(err.type)
        : "session error";
    const detail = oneLine(err.message || data.reason || "").slice(0, 200);
    const bucket = Math.floor(Date.now() / ERROR_TOAST_DEDUP_MS);
    pushFinalSummary(`err:${sid}:${name}:${bucket}`, [
      `[${new Date().toISOString()}] ERROR session=${sid} ${name}${detail ? `: ${detail}` : ""}`,
    ]);
  }
}

export {
  onV2Context,
  onV2Compaction,
  handleV2Event,
  estimateBreakdownFromContext,
  estimateBreakdownFromClientMessages,
  V2_FALLBACK_TIMEOUT_MS,
};
