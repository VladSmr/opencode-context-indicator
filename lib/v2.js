// lib/v2.js
//
// The V2 (opencode >= 2.0.16 / Desktop) path: the context hook estimator and
// handler, the bounded session.context fallback, the event-driven subagent
// roll-up, the live log assembly, and handleV2Event. No toasts on this path
// (the Desktop exposes no TUI channel). Extracted 1:1 (code + WHY comments)
// from index.js.

import {
  estJson,
  estimateTokens,
  fmt,
  oneLine,
  tokenCountOf,
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

// Estimate the per-category breakdown directly from a V2 SessionContext.
// `context.messages` are @opencode/ai Message objects:
//   { role, content: [ {type:"text",text} | {type:"media"} |
//                      {type:"tool-call",input} | {type:"tool-result"} |
//                      {type:"reasoning",text} | ... ] }
// `context.system` are SystemPart[] { type:"text", text }.
// `context.tools` is Record<name, { description, input: JsonSchema }>.
// As in V1, tool RESULTS are deliberately not counted (only call args), and
// every returned *Chars value is a TOKEN estimate (unicode heuristic).
//
// `sessionID` is optional; when given, the tool-schema estimate is cached
// per-session (see toolSchemasBySession) and reused while the cheap fingerprint
// is unchanged and the TTL has not elapsed — so the expensive estJson pass over
// every schema does not run on every single model request.
// Cheap structural fingerprint of the tool schema map: count + total description
// length + number of schema property keys + two O(n) charCode checksums (mod
// 0xFFFFFF) over every description and over the top-level input keys. The
// checksums widen the fingerprint so two different schemas that happen to share
// the same length/key counts do not collide into a wrong cache hit — without
// paying for full JSON.stringify (the whole point of the cache).
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
      propKeys +=
        props && typeof props === "object"
          ? Object.keys(props).length
          : Object.keys(input).length;
      // Sum the top-level key names so property RENAMES that keep the same count
      // still change the fingerprint.
      const topKeys = Object.keys(input);
      for (const k of topKeys) {
        for (let i = 0; i < k.length; i++) {
          keyHash = (keyHash + k.charCodeAt(i)) & 0xffffff;
        }
      }
    }
  }
  return `${n}:${descLen}:${propKeys}:${descHash}:${keyHash}`;
}

function estimateBreakdownFromContext(context, sessionID) {
  let userChars = 0;
  let assistantChars = 0;
  let reasoningChars = 0;
  let toolArgsChars = 0;

  const messages = Array.isArray(context?.messages) ? context.messages : [];
  for (const msg of messages) {
    const parts = Array.isArray(msg?.content) ? msg.content : [];
    if (msg?.role === "user") {
      for (const p of parts) {
        if (p?.type === "text") userChars += estimateTokens(p.text);
      }
    } else if (msg?.role === "assistant") {
      for (const p of parts) {
        if (p?.type === "text") {
          assistantChars += estimateTokens(p.text);
        } else if (p?.type === "reasoning") {
          reasoningChars += estimateTokens(p.text);
        } else if (p?.type === "tool-call") {
          toolArgsChars += estJson(p.input);
        }
      }
    }
  }

  let systemChars = 0;
  const system = Array.isArray(context?.system) ? context.system : [];
  for (const s of system) systemChars += estimateTokens(s?.text);

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
    systemChars,
    toolSchemasChars,
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

// ---------------------------------------------------------------------------
// V2 fallback: derive the message-based categories from the session's persisted
// message list when the context hook did NOT populate the cache for this
// session. This happens when the request was served by a DIFFERENT plugin
// instance (the public event stream is mirrored to every instance, but the
// breakdown cache is process-local) or when the hook did not fire at all.
//
// Only user / assistant / reasoning / tool-args can be derived from the
// persisted SessionMessageInfo[]: the ASSEMBLED system prompt and the tool
// schemas are exclusive to the context hook, so they stay null ("n/a" in the
// sidebar) unless the hook ran. Tool RESULTS are deliberately not counted
// (only call args), exactly like the hook / V1 estimator.
function estimateBreakdownFromClientMessages(messages) {
  let userChars = 0;
  let assistantChars = 0;
  let reasoningChars = 0;
  let toolArgsChars = 0;
  for (const m of messages || []) {
    if (!m || typeof m !== "object") continue;
    if (m.type === "user") {
      userChars += estimateTokens(m.text);
    } else if (m.type === "assistant") {
      const parts = Array.isArray(m.content) ? m.content : [];
      for (const p of parts) {
        if (p?.type === "text") {
          assistantChars += estimateTokens(p.text);
        } else if (p?.type === "reasoning") {
          reasoningChars += estimateTokens(p.text);
        } else if (p?.type === "tool") {
          // state.input is a string while streaming; only count the resolved
          // object (running/completed/error) to avoid partial counts.
          const input = p?.state?.input;
          if (input && typeof input === "object") toolArgsChars += estJson(input);
        }
      }
    }
  }
  return {
    userChars,
    assistantChars,
    reasoningChars,
    toolArgsChars,
    systemChars: null,
    toolSchemasChars: null,
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

  const sumEstimates = (bd?.userChars || 0) +
    (bd?.assistantChars || 0) +
    (bd?.reasoningChars || 0) +
    (bd?.toolArgsChars || 0) +
    (bd?.systemChars || 0) +
    (bd?.toolSchemasChars || 0);
  const other = Math.max(0, inputTokens - sumEstimates);

  if (bd) {
    lines.push(`  user        ${fmt(bd.userChars || 0)} (est tokens)`);
    lines.push(`  assistant   ${fmt(bd.assistantChars || 0)} (est tokens)`);
    const reasoningNote = rt > 0 ? ` (exact ${fmt(rt)})` : "";
    lines.push(`  reasoning   ${fmt(bd.reasoningChars || 0)} (est tokens)${reasoningNote}`);
    lines.push(`  tool args   ${fmt(bd.toolArgsChars || 0)} (est tokens, input only)`);
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
    lines.push(`  system      n/a (hook did not run)`);
    lines.push(`  tool schemas n/a`);
  }
  lines.push(`  other       ${fmt(other)} (= input - sum of estimates)`);
  lines.push(`  source      ${source}`);

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
      writeStateFile(
        sid,
        lastKnownModel(sid),
        lastKnownProvider(sid),
        lastKnownInput(sid),
        lastKnownCtx(sid),
        lastKnownReasoning(sid),
      );
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

    lastKnownInputCache.set(sid, input);
    lastKnownCtxCache.set(sid, contextTokens);
    lastKnownReasoningCache.set(sid, reasoning);
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
  handleV2Event,
  estimateBreakdownFromClientMessages,
  V2_FALLBACK_TIMEOUT_MS,
};
