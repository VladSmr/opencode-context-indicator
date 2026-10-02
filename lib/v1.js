// lib/v1.js
//
// The V1 (opencode >= 1.18.29) entrypoint: makeV1(client) and every helper that
// belongs exclusively to the classic client-based path (message/system
// transforms, toast throttling and signals, the expensive session.messages
// fallback, subagent aggregation, and the live log assembly). Extracted 1:1
// (code + WHY comments) from index.js.

import { estJson, estimateTokens, fmt, tokenCountOf } from "./estimate.js";
import {
  BREAKDOWN_THROTTLE_MS,
  breakdownCache,
  clearSessionTracking,
  COMPACTED_TOAST_DEDUP_MS,
  ERROR_TOAST_DEDUP_MS,
  lastBdWrite,
  lastCompactedToast,
  lastErrorToast,
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
  lastShown,
  MAX_TRACKED_SESSIONS,
  msgFetchTimes,
  sessionParentCache,
  subagentCache,
  toolSchemaCache,
  TOOL_SCHEMA_TTL_MS,
} from "./cache.js";
import {
  ensureProviderLimits,
  getModelLimit,
  getUsableContext,
  modelKey,
  modelLimits,
  modelPrices,
} from "./limits.js";
import {
  debugEvent,
  logErr,
  pushFinalSummary,
  writeLog,
  writeStateFile,
} from "./state.js";
import { pruneMap } from "./dedup.js";

const THROTTLE_MS = 2500; // min gap between toasts
const MIN_GROWTH_TOKENS = 2048; // only re-toast if context grew by this many tokens

const MSG_FETCH_THROTTLE_MS = 30000; // min gap between fallback session.messages calls
const SUBAGENT_THROTTLE_MS = 30000; // min gap between subagent aggregations

const CRITICAL_RATIO = 0.9; // > this fill: bypass growth gate, shorter throttle
const CRITICAL_THROTTLE_MS = 10000; // min gap between critical (>90%) toasts

const TOAST_MS_ERROR = 8000; // duration for error / overflow toasts

// ---------------------------------------------------------------------------
// V1 breakdown estimation from messages (Array<{info, parts}>).
// ---------------------------------------------------------------------------

function estimateBreakdown(messages) {
  let userChars = 0;
  let assistantChars = 0;
  let reasoningTokens = 0;
  let reasoningChars = 0;
  let toolArgsChars = 0;

  for (const { info, parts } of messages || []) {
    const partsArr = parts || [];
    if (info?.role === "user") {
      for (const p of partsArr) {
        if (p?.type === "text") userChars += estimateTokens(p.text);
      }
    } else if (info?.role === "assistant") {
      // Exact reasoning token count straight from the message metadata.
      if (typeof info?.tokens?.reasoning === "number") {
        reasoningTokens += info.tokens.reasoning;
      }
      for (const p of partsArr) {
        if (p?.type === "text") {
          assistantChars += estimateTokens(p.text);
        } else if (p?.type === "reasoning") {
          reasoningChars += estimateTokens(p.text);
        } else if (p?.type === "tool") {
          // ONLY the call arguments (state.input). Deliberately NOT summing
          // state.output — in some sessions tool output reached ~29 MB of
          // chars, which a naive char-based estimate turns into "7 million tokens" and a
          // negative remainder. Tool output is not part of the sent prompt.
          toolArgsChars += estJson(p.state?.input);
        }
      }
    }
  }

  return {
    userChars,
    assistantChars,
    reasoningTokens,
    reasoningChars,
    toolArgsChars,
  };
}

// ---------------------------------------------------------------------------
// V1 tool schema estimate (cached per modelID).
// ---------------------------------------------------------------------------

async function getToolSchemas(client, providerID, modelID) {
  const key = modelKey(providerID, modelID);
  const cached = key ? toolSchemaCache.get(key) : null;
  if (cached && Date.now() - cached.at < TOOL_SCHEMA_TTL_MS) {
    return cached.chars;
  }
  let chars = 0;
  try {
    const res = await client.tool.list({ query: { provider: providerID, model: modelID } });
    const tools = Array.isArray(res) ? res : res?.data;
    if (Array.isArray(tools)) {
      for (const t of tools) {
        chars += estimateTokens(t?.description) + estJson(t?.parameters);
      }
    }
  } catch (err) {
    logErr(`tool.list failed for ${modelID}`, err);
  }
  if (key) {
    toolSchemaCache.set(key, { chars, at: Date.now() });
    pruneMap(toolSchemaCache, MAX_TRACKED_SESSIONS);
  }
  return chars;
}

// ---------------------------------------------------------------------------
// V1 subagent (child session) aggregation — throttled + cached.
// ---------------------------------------------------------------------------

async function aggregateSubagents(client, sessionID) {
  const now = Date.now();
  const cached = subagentCache.get(sessionID);
  if (cached && now - cached.at < SUBAGENT_THROTTLE_MS) {
    return cached;
  }
  const result = { count: 0, input: 0, output: 0, reasoning: 0, perChild: [], at: now };
  try {
    const res = await client.session.children({ path: { id: sessionID } });
    const children = Array.isArray(res) ? res : res?.data;
    if (Array.isArray(children)) {
      result.count = children.length;
      for (const child of children) {
        try {
          const msgsRes = await client.session.messages({ path: { id: child.id } });
          const msgs = Array.isArray(msgsRes) ? msgsRes : msgsRes?.data;
          let childInput = 0;
          let childModelID = null;
          let childProviderID = "";
          for (const { info } of msgs || []) {
            if (info?.role === "assistant" && info?.tokens) {
              result.input += info.tokens.input || 0;
              result.output += info.tokens.output || 0;
              result.reasoning += info.tokens.reasoning || 0;
              // Per-child fill: the LAST assistant message's native overflow
              // count (tokens.total, else input + output + cache.read +
              // cache.write, incl. legacy cacheRead/cacheWrite) + that child's
              // model — same formula as the main path, so cache-heavy children
              // are not under-reported and still get the ⚠ marker.
              if (typeof info.tokens.input === "number") {
                childInput = tokenCountOf(info.tokens);
                childModelID = info.modelID || childModelID;
                childProviderID = info.providerID || childProviderID;
              }
            }
          }
          const childLimit = getModelLimit(childProviderID, childModelID);
          result.perChild.push({
            id: child.id,
            input: childInput,
            limit: childLimit,
            ratio: childLimit ? childInput / childLimit : null,
          });
        } catch (err) {
          logErr(`subagent messages failed for ${child.id}`, err);
        }
      }
    }
  } catch (err) {
    logErr(`session.children failed for ${sessionID}`, err);
  }
  subagentCache.set(sessionID, result);
  pruneMap(subagentCache, MAX_TRACKED_SESSIONS);
  return result;
}

// ---------------------------------------------------------------------------
// V1 toast helpers: attribution, safe showing, error/overflow toasts.
// ---------------------------------------------------------------------------

// "[main]" / "[sub]" prefix from Session.parentID. Cached from
// session.created/updated; falls back to client.session.get once per session.
// Unknown attribution -> "" (never blocks the toast).
async function sessionPrefix(client, sessionID) {
  if (!sessionID) return "";
  try {
    if (!sessionParentCache.has(sessionID)) {
      const res = await client.session.get({ path: { id: sessionID } });
      const info = res?.data?.info ?? res?.data ?? res?.info ?? res;
      sessionParentCache.set(sessionID, info?.parentID || null);
      pruneMap(sessionParentCache, MAX_TRACKED_SESSIONS);
    }
    return sessionParentCache.get(sessionID) ? "[sub]" : "[main]";
  } catch (err) {
    logErr(`session.get failed for ${sessionID}`, err);
    return "";
  }
}

// Show a toast; on failure retry once with the "warning" variant (in case the
// build rejects "error"). Never throws.
async function showToastSafe(client, message, variant, duration) {
  try {
    await client.tui.showToast({ body: { message, variant, duration } });
  } catch (err) {
    if (variant !== "warning") {
      try {
        await client.tui.showToast({ body: { message, variant: "warning", duration } });
        return;
      } catch (err2) {
        logErr(`toast fallback failed (variant ${variant})`, err2);
        return;
      }
    }
    logErr("toast error", err);
  }
}

function truncate(text, max) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Short session id for toasts (last 6 chars).
function shortID(sessionID) {
  if (!sessionID) return "";
  const s = String(sessionID);
  return s.length > 8 ? `…${s.slice(-6)}` : s;
}

// Best-effort message extraction from an arbitrary error payload.
function errMessageOf(err) {
  if (!err) return "";
  if (typeof err === "string") return err;
  return err?.data?.message || err.message || "";
}

// Dedup for error-ish toasts: identical signature for the same session is
// suppressed within ERROR_TOAST_DEDUP_MS. Returns true when allowed.
function errorToastDedup(sessionID, sig) {
  const key = sessionID || "__unknown__";
  const now = Date.now();
  const prev = lastErrorToast.get(key);
  if (prev && prev.sig === sig && now - prev.at < ERROR_TOAST_DEDUP_MS) {
    return false;
  }
  lastErrorToast.set(key, { sig, at: now });
  pruneMap(lastErrorToast, MAX_TRACKED_SESSIONS);
  return true;
}

// session.error payload: { sessionID?, error?: { name, data: { message,
// statusCode?, isRetryable? } } } — sessionID is optional, handle undefined.
async function toastSessionError(client, event) {
  const props = event.properties || {};
  const sessionID =
    typeof props.sessionID === "string" ? props.sessionID : undefined;
  const error = props.error || {};
  const name = error.name || error?.data?.name || "session error";
  const detail = errMessageOf(error);
  const status = error?.data?.statusCode;
  const sig = `${name}|${status ?? ""}|${String(detail).slice(0, 120)}`;
  if (!errorToastDedup(sessionID, sig)) return;

  let text = name;
  try {
    const prefix = await sessionPrefix(client, sessionID);
    if (prefix) text = `${prefix} ${text}`;
    if (status != null) text += ` (HTTP ${status})`;
    if (detail) text += `: ${truncate(detail, 160)}`;
    if (sessionID) text += ` · ${shortID(sessionID)}`;
  } catch (err) {
    logErr("session.error message build failed", err);
  }
  await showToastSafe(client, text.trim(), "error", TOAST_MS_ERROR);
}

// Assistant message with info.error: force a warning toast bypassing the
// throttle gates (same dedup as session.error).
async function toastMessageError(client, sessionID, error) {
  const name = (error && (error.name || error?.data?.name)) || "model error";
  const detail = errMessageOf(error);
  const sig = `msg|${name}|${String(detail).slice(0, 120)}`;
  if (!errorToastDedup(sessionID, sig)) return;

  let text = name;
  try {
    const prefix = await sessionPrefix(client, sessionID);
    if (prefix) text = `${prefix} ${text}`;
  } catch (err) {
    logErr("message.error prefix failed", err);
  }
  if (detail) text += `: ${truncate(detail, 160)}`;
  await showToastSafe(client, text.trim(), "warning", TOAST_MS_ERROR);
}

// session.compacted (and compaction parts): auto-compaction usually means the
// context window was exceeded. MUST run BEFORE clearSessionTracking — it reads
// the last known input/model, which are wiped right after.
async function toastCompactedSignal(client, sessionID) {
  if (!sessionID) return;
  const now = Date.now();
  const prev = lastCompactedToast.get(sessionID);
  if (prev && now - prev < COMPACTED_TOAST_DEDUP_MS) return;
  lastCompactedToast.set(sessionID, now);
  pruneMap(lastCompactedToast, MAX_TRACKED_SESSIONS);

  let text = "session compacted (auto) — the context may have overflowed";
  try {
    const prefix = await sessionPrefix(client, sessionID);
    const ctx = lastKnownCtx(sessionID) || lastKnownInput(sessionID);
    const limit = getModelLimit(lastKnownProvider(sessionID), lastKnownModel(sessionID));
    if (ctx > 0) text += ` (ctx ${fmt(ctx)}${limit ? ` / ${fmt(limit)}` : ""})`;
    if (prefix) text = `${prefix} ${text}`;
  } catch (err) {
    logErr("compacted message build failed", err);
  }
  await showToastSafe(client, text.trim(), "warning", TOAST_MS_ERROR);
}

// Best-effort mid-turn hints from message.part.updated: compaction parts
// mirror session.compacted; retry parts surface provider errors when they
// carry one. Never blocks the main path.
async function maybeToastPartSignal(client, event) {
  const part = event.properties?.part;
  if (!part || !part.type) return;
  const sessionID = part.sessionID || event.properties?.sessionID || undefined;
  if (!sessionID) return;

  if (part.type === "compaction") {
    try {
      await toastCompactedSignal(client, sessionID); // shared dedup window
    } catch (err) {
      logErr("compaction part toast failed", err);
    }
    return;
  }

  if (part.type !== "retry") return;
  const err = part.error ?? part.state?.error;
  const detail = errMessageOf(err);
  if (!detail) return;
  const name = (err && (err.name || err?.data?.name)) || "retry";
  const sig = `part|${name}|${String(detail).slice(0, 120)}`;
  if (!errorToastDedup(sessionID, sig)) return;
  let text = `${name}: ${truncate(detail, 160)}`;
  try {
    const prefix = await sessionPrefix(client, sessionID);
    if (prefix) text = `${prefix} ${text}`;
  } catch {
    // attribution is optional here
  }
  await showToastSafe(client, text.trim(), "warning", TOAST_MS_ERROR);
}

// ---------------------------------------------------------------------------
// V1 fallback: fetch messages via client.session.messages (expensive, throttled).
// ---------------------------------------------------------------------------

async function fetchBreakdownFallback(client, sessionID) {
  const now = Date.now();
  const last = msgFetchTimes.get(sessionID) || 0;
  if (now - last < MSG_FETCH_THROTTLE_MS) return null; // too soon -> skip
  msgFetchTimes.set(sessionID, now);
  pruneMap(msgFetchTimes, MAX_TRACKED_SESSIONS);

  try {
    const res = await client.session.messages({ path: { id: sessionID } });
    const msgs = Array.isArray(res) ? res : res?.data;
    const estParts = estimateBreakdown(msgs);
    return { ...estParts, capturedAt: now, source: "fallback" };
  } catch (err) {
    logErr(`session.messages fallback failed for ${sessionID}`, err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// V1: assemble the live breakdown lines for the log file.
// ---------------------------------------------------------------------------

async function buildLiveLines(client, sessionID, modelID, providerID, inputTokens, ctxTokens) {
  const lines = [];
  const ts = new Date().toISOString();
  const limit = getModelLimit(providerID, modelID);
  const usableInfo = getUsableContext(providerID, modelID);
  // Total context = native overflow count (tokens.total, else input + output +
  // cache.read + cache.write); pct has NO upper clamp — exceeding the window
  // must stay visible in the log too. Denominator is the native usable window
  // when derivable, else the raw context window.
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

  // --- breakdown from cache (transform hooks) or fallback fetch ---
  let bd = breakdownCache.get(sessionID);
  let source = bd?.source || "none";

  if (!bd || Date.now() - bd.capturedAt > MSG_FETCH_THROTTLE_MS) {
    // Try to refresh via fallback if we have nothing fresh.
    const fb = await fetchBreakdownFallback(client, sessionID);
    if (fb) {
      bd = fb;
      source = fb.source;
      breakdownCache.set(sessionID, fb);
      pruneMap(breakdownCache, MAX_TRACKED_SESSIONS);
    }
  }

  // Tool schemas: cached per modelID (rarely change). Stored into the session
  // breakdown so the estimate is stable across writes.
  let toolSchemasChars = bd?.toolSchemasChars;
  if (toolSchemasChars == null) {
    try {
      toolSchemasChars = await getToolSchemas(client, providerID, modelID);
      if (bd) {
        bd.toolSchemasChars = toolSchemasChars;
        breakdownCache.set(sessionID, bd);
      }
    } catch (err) {
      logErr("tool schema estimate failed", err);
      toolSchemasChars = null;
    }
  }

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
    const reasoningNote =
      bd.reasoningTokens > 0
        ? ` (exact ${fmt(bd.reasoningTokens)})`
        : "";
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

  // --- subagent aggregation (informational only, own context window) ---
  try {
    const sub = await aggregateSubagents(client, sessionID);
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
    logErr("subagent aggregation failed", err);
    lines.push(`  subagents   n/a`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// V1 entrypoint (event handler + hooks), preserved unchanged.
// ---------------------------------------------------------------------------

function makeV1(client) {
  // Fire-and-forget prefetch of effective model limits (fault-tolerant; the
  // config() hook below stays as the fallback source).
  ensureProviderLimits(client).catch((err) =>
    logErr("provider limits prefetch failed", err),
  );

  return {
    config(cfg) {
      try {
        // Provider-agnostic: iterate EVERY provider in the config, regardless
        // of name. V1 configs expose `provider`; some shapes use `providers`.
        const buckets = [cfg?.provider, cfg?.providers].filter(
          (b) => b && typeof b === "object",
        );
        if (buckets.length === 0) return;
        for (const bucket of buckets) {
          for (const [providerID, pdef] of Object.entries(bucket)) {
            const models = pdef?.models;
            if (!models || typeof models !== "object") continue;
            for (const [modelID, def] of Object.entries(models)) {
              const key = modelKey(providerID, modelID);
              if (!key) continue;
              const lim = def?.limit;
              const context =
                typeof lim?.context === "number" && lim.context > 0 ? lim.context : null;
              const input =
                typeof lim?.input === "number" && lim.input > 0 ? lim.input : null;
              const output =
                typeof lim?.output === "number" && lim.output > 0 ? lim.output : null;
              if (context != null || input != null) {
                const prevRec = modelLimits.get(key);
                modelLimits.set(key, {
                  context,
                  input,
                  output,
                  reserved:
                    typeof def?.compaction?.reserved === "number"
                      ? def.compaction.reserved
                      : (prevRec?.reserved ?? null),
                });
              }
              // Capture explicit pricing ONLY when present (custom providers
              // usually omit it).
              const c = def?.cost;
              if (
                c &&
                typeof c === "object" &&
                (typeof c.input === "number" || typeof c.output === "number")
              ) {
                modelPrices.set(key, {
                  input: typeof c.input === "number" ? c.input : 0,
                  output: typeof c.output === "number" ? c.output : 0,
                  cacheRead: typeof c?.cache?.read === "number" ? c.cache.read : 0,
                  cacheWrite: typeof c?.cache?.write === "number" ? c.cache.write : 0,
                });
              }
            }
          }
        }
      } catch {
        // keep whatever we already have
      }
    },

    // Capture the final messages right before they are sent to the LLM.
    // We only READ here — never mutate the outgoing messages.
    "experimental.chat.messages.transform"(_input, { messages }) {
      try {
        if (!Array.isArray(messages) || messages.length === 0) return;
        const sid = messages[0]?.info?.sessionID;
        if (!sid) return;
        const estParts = estimateBreakdown(messages);
        const prev = breakdownCache.get(sid) || {};
        breakdownCache.set(sid, {
          ...prev,
          ...estParts,
          capturedAt: Date.now(),
          source: "transform",
        });
        pruneMap(breakdownCache, MAX_TRACKED_SESSIONS);
      } catch (err) {
        logErr("messages.transform failed", err);
      }
    },

    // Capture the assembled system prompt (string[]) before send.
    "experimental.chat.system.transform"({ sessionID }, { system }) {
      try {
        const sid = sessionID;
        if (!sid) return;
        let systemChars = 0;
        if (Array.isArray(system)) {
          for (const s of system) systemChars += estimateTokens(s);
        }
        const prev = breakdownCache.get(sid) || {};
        breakdownCache.set(sid, {
          ...prev,
          systemChars,
          capturedAt: Date.now(),
          source: prev.source || "system-transform",
        });
        pruneMap(breakdownCache, MAX_TRACKED_SESSIONS);
      } catch (err) {
        logErr("system.transform failed", err);
      }
    },

    async event({ event }) {
      if (!event) return;

      // DEBUG: log every incoming event type (fault-tolerant, off via flag).
      debugEvent(event);

      // Cache parent links for [main]/[sub] attribution from lifecycle events
      // (properties.info carries parentID when present).
      if (
        event.type === "session.created" ||
        event.type === "session.updated"
      ) {
        try {
          const sinfo = event.properties?.info;
          if (sinfo?.id && sinfo.parentID) {
            sessionParentCache.set(sinfo.id, sinfo.parentID);
            pruneMap(sessionParentCache, MAX_TRACKED_SESSIONS);
          }
        } catch (err) {
          logErr("session parent tracking failed", err);
        }
        return;
      }

      // Cleanup tracked sessions when they end / are deleted / are compacted.
      if (
        event.type === "session.idle" ||
        event.type === "session.deleted" ||
        event.type === "session.compacted"
      ) {
        // session.idle / session.compacted -> properties.sessionID;
        // session.deleted -> properties.info.id
        const sid =
          event.properties?.sessionID ?? event.properties?.info?.id;
        if (!sid) return;

        // session.compacted: toast BEFORE clearing tracking — it needs the
        // last known input/model, which clearSessionTracking wipes below.
        if (event.type === "session.compacted") {
          try {
            await toastCompactedSignal(client, sid);
          } catch (err) {
            logErr("session.compacted toast failed", err);
          }
        }

        if (event.type === "session.idle") {
          // Final summary to the log (best effort; never breaks anything).
          // Timestamp captured BEFORE the async build so the cross-instance
          // dedup key is stable across plugin instances.
          const idleAt = Date.now();
          try {
            const modelID = lastKnownModel(sid);
            const providerID = lastKnownProvider(sid);
            const inputTokens = lastKnownInput(sid);
            const lines = await buildLiveLines(
              client,
              sid,
              modelID,
              providerID,
              inputTokens,
              lastKnownCtx(sid),
            );
            writeStateFile(
              sid,
              modelID,
              providerID,
              inputTokens,
              lastKnownCtx(sid),
              lastKnownReasoning(sid),
            );
            // Claim once across instances: without this, every plugin instance
            // appends its own FINAL line. V1 events carry no `id`, so fall back
            // to a short time bucket (same strategy as the error-toast dedup).
            const eventKey = event.id ?? event.properties?.id;
            const claimKey = eventKey
              ? `final:${eventKey}`
              : `final:${sid}:${Math.floor(idleAt / 5000)}`;
            pushFinalSummary(claimKey, [
              `[${new Date().toISOString()}] FINAL session=${sid}`,
              ...lines.slice(1),
            ]);
          } catch (err) {
            logErr("final summary on idle failed", err);
          }
        }

        // session.compacted keeps the toast-dedup entries: two consecutive
        // session.compacted events must not produce two toasts (60s window).
        clearSessionTracking(sid, event.type === "session.compacted");
        return;
      }

      // Session-level errors (provider failures etc.). sessionID is optional
      // in the payload — handled gracefully inside.
      if (event.type === "session.error") {
        try {
          await toastSessionError(client, event);
        } catch (err) {
          logErr("session.error handling failed", err);
        }
        return;
      }

      // Mid-turn overflow / retry hints from compaction & retry parts.
      if (event.type === "message.part.updated") {
        try {
          await maybeToastPartSignal(client, event);
        } catch (err) {
          logErr("message.part.updated signal failed", err);
        }
        return;
      }

      if (event.type !== "message.updated") return;

      const info = event?.properties?.info;
      if (!info || info.role !== "assistant") return;

      const sessionID = info.sessionID;

      // Assistant message carrying an error (when present in this build):
      // force a warning toast, bypassing the throttle gates. Same dedup as
      // session.error.
      if (info.error) {
        try {
          await toastMessageError(client, sessionID, info.error);
        } catch (err) {
          logErr("info.error toast failed", err);
        }
        return;
      }

      const tokens = info.tokens;
      if (!tokens || typeof tokens.input !== "number") return;

      // Context size components. The "how full is the window" metric is the
      // native opencode overflow count: tokens.total when present, else
      // input + output + cache.read + cache.write (cache tokens included).
      const cacheRead =
        typeof tokens.cache?.read === "number"
          ? tokens.cache.read
          : typeof tokens.cacheRead === "number"
            ? tokens.cacheRead
            : 0;
      const cacheWrite =
        typeof tokens.cache?.write === "number"
          ? tokens.cache.write
          : typeof tokens.cacheWrite === "number"
            ? tokens.cacheWrite
            : 0;
      const contextTokens = tokenCountOf(tokens);

      // Remember last known model/provider/input for the idle final summary.
      if (info.modelID) lastKnownModelCache.set(sessionID, info.modelID);
      if (info.providerID) lastKnownProviderCache.set(sessionID, info.providerID);
      lastKnownInputCache.set(sessionID, tokens.input);
      if (typeof tokens.reasoning === "number") {
        lastKnownReasoningCache.set(sessionID, tokens.reasoning);
      }
      lastKnownCtxCache.set(sessionID, contextTokens);
      pruneMap(lastKnownModelCache, MAX_TRACKED_SESSIONS);
      pruneMap(lastKnownProviderCache, MAX_TRACKED_SESSIONS);
      pruneMap(lastKnownInputCache, MAX_TRACKED_SESSIONS);
      pruneMap(lastKnownReasoningCache, MAX_TRACKED_SESSIONS);
      pruneMap(lastKnownCtxCache, MAX_TRACKED_SESSIONS);

      // Resolve the limit for THIS message's model, keyed by
      // providerID:modelID. Prefer the effective limits from
      // client.config.providers(); the config() hook remains the fallback.
      const mkey = modelKey(info.providerID, info.modelID);
      let limit = getModelLimit(info.providerID, info.modelID);
      let usableInfo = getUsableContext(info.providerID, info.modelID);
      if (limit == null && usableInfo == null) {
        try {
          await ensureProviderLimits(client);
        } catch {
          // ignore — fall back to whatever the config() hook provided
        }
        limit = getModelLimit(info.providerID, info.modelID);
        usableInfo = getUsableContext(info.providerID, info.modelID);
      }

      const now = Date.now();
      const prev = lastShown.get(sessionID);
      // Native usable window when derivable; else the raw context window; else
      // no percentage at all (legacy behaviour).
      const denom =
        usableInfo != null
          ? usableInfo.usable
          : limit != null && limit > 0
            ? limit
            : null;
      const ratio = denom != null ? contextTokens / denom : 0;
      const critical = ratio > CRITICAL_RATIO;
      // Throttle: suppress if NOT enough time has passed OR growth is small.
      // Critical (>90%) toasts skip the growth gate and use a shorter gap so
      // threshold crossings are not silenced by MIN_GROWTH_TOKENS.
      if (
        prev &&
        (now - prev.at < (critical ? CRITICAL_THROTTLE_MS : THROTTLE_MS) ||
          (!critical && contextTokens - prev.tokens < MIN_GROWTH_TOKENS))
      ) {
        return;
      }

      lastShown.set(sessionID, { at: now, tokens: contextTokens });
      pruneMap(lastShown, MAX_TRACKED_SESSIONS);

      let message;
      let variant = "info";
      if (denom != null) {
        // No upper clamp: exceeding the window must stay visible (>100%).
        const pct = ((contextTokens / denom) * 100).toFixed(1);
        message = `ctx ${fmt(contextTokens)} / ${fmt(denom)} (${pct}%)`;
        if (ratio > 0.75) variant = "warning";
      } else {
        message = `ctx ${fmt(contextTokens)}`;
      }

      // F2: extend the toast with reasoning / cache.read when nonzero
      // (raw reported values, unchanged).
      const extras = [];
      const reasoning = typeof tokens.reasoning === "number" ? tokens.reasoning : 0;
      if (reasoning > 0) extras.push(`r ${fmt(reasoning)}`);
      if (cacheRead > 0) extras.push(`c ${fmt(cacheRead)}`);

      // Cost: only when the model config carries explicit pricing. Each token
      // class is priced with its OWN rate; reasoning is already counted inside
      // `output` (opencode reports output inclusive of reasoning), so it is NOT
      // added separately. Absent rates are simply skipped.
      const price = mkey ? modelPrices.get(mkey) : null;
      if (price) {
        const inputTok = typeof tokens.input === "number" ? tokens.input : 0;
        const outputTok = typeof tokens.output === "number" ? tokens.output : 0;
        const cost =
          (inputTok / 1000) * (price.input || 0) +
          (outputTok / 1000) * (price.output || 0) +
          (cacheRead / 1000) * (price.cacheRead || 0) +
          (cacheWrite / 1000) * (price.cacheWrite || 0);
        if (cost > 0) extras.push(`${cost.toFixed(4)}$`);
      }
      if (extras.length > 0) {
        message = `${message} · ${extras.join(" · ")}`;
      }

      // F3: compact subagent info in the toast (fresh cached value only).
      // Per-child ratios come from the cached aggregation — no extra calls.
      try {
        const sub = subagentCache.get(sessionID);
        if (sub && sub.count > 0 && now - sub.at < SUBAGENT_THROTTLE_MS) {
          const perChild = Array.isArray(sub.perChild) ? sub.perChild : [];
          const ratios = perChild
            .map((c) => c?.ratio)
            .filter((r) => typeof r === "number");
          if (ratios.length > 0) {
            const worst = Math.max(...ratios);
            const worstPct = `${(worst * 100).toFixed(0)}%`;
            const hot = perChild.filter(
              (c) => typeof c?.ratio === "number" && c.ratio > CRITICAL_RATIO,
            ).length;
            message = hot > 0
              ? `${message} · sub ${sub.count}, ${hot}⚠ (${worstPct})`
              : `${message} · sub ${sub.count}, worst ${worstPct}`;
          } else {
            // No known limits for the children -> legacy cumulative total.
            const subTotal = sub.input + sub.output + sub.reasoning;
            message = `${message} · sub ${fmt(subTotal)}`;
          }
        }
      } catch (err) {
        logErr("toast subagent suffix failed", err);
      }

      // Attribution: [main]/[sub] by Session.parentID (cached; faults ignored).
      try {
        const prefix = await sessionPrefix(client, sessionID);
        if (prefix) message = `${prefix} ${message}`;
      } catch (err) {
        logErr("attribution prefix failed", err);
      }

      try {
        await showToastSafe(client, message, variant, 3500);
      } catch (err) {
        logErr("toast error", err);
      }

      // F1: live breakdown to the log (throttled separately, fault-tolerant).
      // Writes whenever enough wall-clock time has passed since the last write;
      // the breakdown cache itself may be fresh (from transform hooks) or stale
      // (then buildLiveLines refreshes it via the fallback fetch).
      try {
        const lastWrite = lastBdWrite.get(sessionID) || 0;
        if (now - lastWrite >= BREAKDOWN_THROTTLE_MS) {
          lastBdWrite.set(sessionID, now);
          pruneMap(lastBdWrite, MAX_TRACKED_SESSIONS);
          const lines = await buildLiveLines(
            client,
            sessionID,
            info.modelID,
            info.providerID,
            tokens.input,
            contextTokens,
          );
          writeStateFile(
            sessionID,
            info.modelID,
            info.providerID,
            tokens.input,
            contextTokens,
            reasoning,
          );
          writeLog(lines);
        }
      } catch (err) {
        logErr("live breakdown write failed", err);
      }
    },
  };
}

export { makeV1 };
