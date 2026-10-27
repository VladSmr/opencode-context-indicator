// lib/cache.js
//
// All per-instance in-memory state for the context-indicator plugin: the
// session/model tracking Maps, their FIFO cap, the dedup/TTL tuning constants,
// the last-known-* accessors, and clearSessionTracking(). Kept in one module so
// every writer and reader shares exactly the same Map instances. Extracted 1:1
// (code + WHY comments) from index.js.

// Cap for the in-process session maps. pruneMap trims in INSERTION order (FIFO):
// keys are never re-ordered on set, so a re-written key keeps its original slot.
const MAX_TRACKED_SESSIONS = 256; // FIFO cap for maps

const BREAKDOWN_THROTTLE_MS = 7500; // min gap between live breakdown writes

const TOOL_SCHEMA_TTL_MS = 3600 * 1000; // tool schemas rarely change

const ERROR_TOAST_DEDUP_MS = 60000; // same error -> at most one toast / window
const COMPACTED_TOAST_DEDUP_MS = 60000; // compacted-toast dedup window

// sessionID -> { at, tokens }
const lastShown = new Map();

// sessionID -> captured breakdown from transform hooks / context hook / fallback
// { systemChars, userChars, assistantChars, reasoningTokens, reasoningChars,
//   toolArgsChars, toolOutChars, toolSchemasChars, capturedAt, source }
// NOTE: the *Chars fields are TOKEN estimates (unicode heuristic — see
// estimateTokens); the name is kept from the original plugin for 1:1 diffability.
const breakdownCache = new Map();

// `<providerID>:<modelID>` -> { chars, at } — cached tool-schema estimate (V1 path)
const toolSchemaCache = new Map();

// sessionID -> { toolSchemasChars, toolsFingerprint, at } — per-session TTL cache
// for the V2 tool-schema token estimate. Tool schemas rarely change within a
// session, so re-running estJson over every schema on EVERY model request (the
// V2 context hook) is wasted work; the cheap fingerprint detects real changes.
const toolSchemasBySession = new Map();

// sessionID -> { count, input, output, reasoning, at } — subagent aggregation (V1)
const subagentCache = new Map();

// sessionID -> last time we called the expensive session.messages fallback
const msgFetchTimes = new Map();

// sessionID -> last modelID / providerID / input tokens / reasoning seen.
// The modelID/providerID pair is turned into a `<providerID>:<modelID>` limit
// lookup key at every modelLimits/modelPrices access site (the maps themselves
// are model-keyed, these caches are session-keyed by design).
const lastKnownModelCache = new Map();
const lastKnownProviderCache = new Map();
const lastKnownInputCache = new Map();
const lastKnownReasoningCache = new Map();
// sessionID -> last native opencode overflow count (tokens.total, else
// input + output + cache.read + cache.write)
const lastKnownCtxCache = new Map();
// sessionID -> last provider-reported prompt-cache figures from
// session.step.ended (`tokens.cache.read` / `tokens.cache.write`). These are
// EXACT provider numbers (not estimates) and are a subset of `input`, so they
// are shown as a separate metric and never folded into the category sum.
const lastKnownCacheReadCache = new Map();
const lastKnownCacheWriteCache = new Map();

// sessionID -> last time we wrote a live breakdown snapshot
const lastBdWrite = new Map();

// sessionID -> { sig, at } — dedup for session.error / info.error toasts
const lastErrorToast = new Map();

// sessionID -> timestamp — dedup for session.compacted toasts
const lastCompactedToast = new Map();

// sessionID -> timestamp — when the `compaction` HOOK last fired for a session.
// The hook is dispatched at the START of a compaction request (before the model
// summarises), carrying the exact pre-compaction context, so it lets us persist
// the TRUE pre-compaction breakdown. It also tells the later `session.compacted`
// EVENT that the hook already marked the entry (the event stays a fallback).
const lastCompactionHookAt = new Map();

// sessionID -> parentID (null = main session) — [main]/[sub] attribution cache
const sessionParentCache = new Map();

// V2: sessionID -> { input, output, reasoning, ctx, modelID, at } accumulated
// from session.step.ended, used to fold child-session totals into the parent.
const sessionTotals = new Map();

// V2: sessionID -> agent name (session.created data.agent). Used only as the
// role label ("sub:<agent>") in the /context-breakdown table.
const sessionAgentCache = new Map();

// sessionID -> last time we hit the client session.context() fallback.
const v2ContextFetchTimes = new Map();

function lastKnownModel(sessionID) {
  return lastKnownModelCache.get(sessionID) || "unknown";
}
function lastKnownProvider(sessionID) {
  return lastKnownProviderCache.get(sessionID) || "";
}
function lastKnownInput(sessionID) {
  return lastKnownInputCache.get(sessionID) || 0;
}
function lastKnownReasoning(sessionID) {
  return lastKnownReasoningCache.get(sessionID) || 0;
}
function lastKnownCtx(sessionID) {
  return lastKnownCtxCache.get(sessionID) || 0;
}
// Provider-reported prompt-cache figures; null when the provider never reported
// them (a plain "n/a" rather than a misleading 0).
function lastKnownCacheRead(sessionID) {
  const v = lastKnownCacheReadCache.get(sessionID);
  return typeof v === "number" ? v : null;
}
function lastKnownCacheWrite(sessionID) {
  const v = lastKnownCacheWriteCache.get(sessionID);
  return typeof v === "number" ? v : null;
}

// ---------------------------------------------------------------------------
// Clear per-session tracking. Full wipe on session.idle / session.deleted;
// on session.compacted (keepToastDedup=true) the toast-dedup entries survive
// the cleanup so consecutive compacted events still dedup.
//
// `keepSubagentRollup` preserves THIS session's parent attribution and token
// totals. A finished subagent goes idle while its parent is still running; the
// parent's live roll-up must keep counting that child, so the V2 idle handler
// passes `true` for children and lets the parent's own idle/deleted wipe them
// (see clearChildSubagentTracking).
// ---------------------------------------------------------------------------

function clearSessionTracking(sessionID, keepToastDedup = false, keepSubagentRollup = false) {
  if (!sessionID) return;
  lastShown.delete(sessionID);
  breakdownCache.delete(sessionID);
  subagentCache.delete(sessionID);
  msgFetchTimes.delete(sessionID);
  // Error/overflow + compacted toast dedup entries.
  if (!keepToastDedup) {
    lastErrorToast.delete(sessionID);
    lastCompactedToast.delete(sessionID);
  }
  // Attribution cache (re-resolved on the next toast if needed).
  if (!keepSubagentRollup) sessionParentCache.delete(sessionID);
  // Idle-summary caches were previously left dirty — clean them too.
  lastKnownModelCache.delete(sessionID);
  lastKnownProviderCache.delete(sessionID);
  lastKnownInputCache.delete(sessionID);
  lastKnownReasoningCache.delete(sessionID);
  lastKnownCtxCache.delete(sessionID);
  lastKnownCacheReadCache.delete(sessionID);
  lastKnownCacheWriteCache.delete(sessionID);
  lastBdWrite.delete(sessionID);
  // V2 subagent accumulation for this session.
  if (!keepSubagentRollup) sessionTotals.delete(sessionID);
  // V2 agent label + context-fallback throttle (previously left dirty).
  sessionAgentCache.delete(sessionID);
  v2ContextFetchTimes.delete(sessionID);
  // Per-session tool-schema TTL cache (see estimateBreakdownFromContext).
  toolSchemasBySession.delete(sessionID);
  // Compaction-hook marker (re-armed by the next compaction on this session).
  lastCompactionHookAt.delete(sessionID);
}

// Drop the roll-up entries of every descendant of `rootID` (attribution plus
// accumulated totals). Called when a session itself goes idle or is deleted:
// until then, finished children stay in the cache so the live roll-up keeps
// reporting them instead of collapsing to "0 session(s)" the moment a child
// finishes. Breadth-first, because a sub-subagent hangs off a child and a
// single-level sweep would leave it as a permanent orphan. Deletion during Map
// iteration is well-defined in JS.
function clearChildSubagentTracking(rootID) {
  if (!rootID) return;
  const queue = [rootID];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const [childID, parentID] of sessionParentCache) {
      if (parentID !== parent) continue;
      // Full per-session wipe, not just the two roll-up maps: the child's
      // lastKnown*/breakdown/tool-schema caches would otherwise linger until
      // FIFO eviction and never be updated again.
      clearSessionTracking(childID);
      if (!seen.has(childID)) {
        seen.add(childID);
        queue.push(childID);
      }
    }
  }
}

export {
  MAX_TRACKED_SESSIONS,
  BREAKDOWN_THROTTLE_MS,
  TOOL_SCHEMA_TTL_MS,
  ERROR_TOAST_DEDUP_MS,
  COMPACTED_TOAST_DEDUP_MS,
  lastShown,
  breakdownCache,
  toolSchemaCache,
  toolSchemasBySession,
  subagentCache,
  msgFetchTimes,
  lastKnownModelCache,
  lastKnownProviderCache,
  lastKnownInputCache,
  lastKnownReasoningCache,
  lastKnownCtxCache,
  lastKnownCacheReadCache,
  lastKnownCacheWriteCache,
  lastBdWrite,
  lastErrorToast,
  lastCompactedToast,
  lastCompactionHookAt,
  sessionParentCache,
  sessionTotals,
  sessionAgentCache,
  v2ContextFetchTimes,
  lastKnownModel,
  lastKnownProvider,
  lastKnownInput,
  lastKnownReasoning,
  lastKnownCtx,
  lastKnownCacheRead,
  lastKnownCacheWrite,
  clearSessionTracking,
  clearChildSubagentTracking,
};
