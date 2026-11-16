// lib/cache.js
//
// All per-instance in-memory state for the context-indicator plugin: the
// session/model tracking Maps, their recency (LRU) cap, the dedup/TTL tuning
// constants, the last-known-* accessors, and clearSessionTracking(). Kept in one
// module so every writer and reader shares exactly the same Map instances.
// Extracted from index.js (RecencyMap was added in 1.9.5, so this is no longer a
// line-for-line copy).

// Cap for the in-process session maps. pruneMap trims from the FRONT of the
// iteration order, and every capped map here is a RecencyMap (see below), so the
// eviction is LRU by last WRITE: a session that keeps reporting keeps its slot.
// This bounds RAM per plugin instance only - it is NOT the persisted state file
// (see STATE_MAX_ENTRIES below, which was the one real bug).
const MAP_MAX_ENTRIES = 256;
// Legacy name: every cache map in lib/v1.js / lib/v2.js imports it, and it must
// keep meaning "in-process map cap".
const MAX_TRACKED_SESSIONS = MAP_MAX_ENTRIES;

// Cap for the rows kept in the SHARED state.json. 256 was a blind FIFO slice:
// one measured family had 146 rows and the slice silently removed 7 of them. A
// missing intermediate row hides its whole subtree (the parentID chain is the
// only link), so rows are now evicted a whole FAMILY at a time (see
// selectStateSurvivors in lib/state.js). 1024 keeps ~7 families of that size.
const STATE_MAX_ENTRIES = 1024;
// Soft size cap for state.json (~1.1 KB per row, so 1024 rows is ~1.1 MB). A
// family is never split, so one oversized family may win over the row cap; this
// bounds the file instead. Kept small on purpose: the whole file is parsed and
// re-serialised under a cross-process lock on every write, and the TUI polls it
// every second.
const STATE_MAX_BYTES = 2 * 1024 * 1024;

const BREAKDOWN_THROTTLE_MS = 7500; // min gap between live breakdown writes

const TOOL_SCHEMA_TTL_MS = 3600 * 1000; // tool schemas rarely change

const ERROR_TOAST_DEDUP_MS = 60000; // same error -> at most one toast / window
const COMPACTED_TOAST_DEDUP_MS = 60000; // compacted-toast dedup window

// Recency-ordered Map used by EVERY capped in-process map below.
//
// WHY a subclass: Map#set() on an existing key keeps that key's ORIGINAL
// insertion position, so a plain Map + pruneMap() (which trims from the front)
// is FIFO - a session updated on every step could still be evicted ahead of an
// idle one just because it was seen earlier. Deleting before setting moves the
// key to the tail, which makes pruneMap() evict LRU (last WRITE).
//
// Why write-recency, not read-recency: these maps are read on every panel / TUI
// poll (once a second per instance), so touching on get() would rewrite the
// order continuously for no benefit. The damage FIFO caused was evicting an
// actively UPDATED session; a write is exactly that signal.
//
// Map semantics are unchanged (iteration, size, has, get, delete), and pruning
// stays one explicit pruneMap() call after the write.
class RecencyMap extends Map {
  set(key, value) {
    // has() before delete() keeps the first insert cheap and keeps the order
    // stable for keys that are only ever written once.
    if (this.has(key)) this.delete(key);
    return super.set(key, value);
  }
}

// sessionID -> { at, tokens }
const lastShown = new RecencyMap();
// sessionID -> captured breakdown from transform hooks / context hook / fallback
// { systemChars, userChars, assistantChars, reasoningTokens, reasoningChars,
//   toolArgsChars, toolOutChars, toolSchemasChars, capturedAt, source, model }
// NOTE: the *Chars fields are TOKEN estimates (unicode heuristic — see
// estimateTokens); the name is kept from the original plugin for 1:1 diffability.
// `model` (the modelID the payload was measured for) is what makes the entry
// model-scoped: after an in-session model switch the old split describes the old
// window, not the new one.
const breakdownCache = new RecencyMap();
// `<providerID>:<modelID>` -> { chars, at } - cached tool-schema estimate (V1 path)
const toolSchemaCache = new RecencyMap();

// sessionID -> { toolSchemasChars, toolsFingerprint, at } — per-session TTL cache
// for the V2 tool-schema token estimate. Tool schemas rarely change within a
// session, so re-running estJson over every schema on EVERY model request (the
// V2 context hook) is wasted work; the cheap fingerprint detects real changes.
const toolSchemasBySession = new RecencyMap();

// sessionID -> { count, input, output, reasoning, at } — subagent aggregation (V1)
const subagentCache = new RecencyMap();

// sessionID -> last time we called the expensive session.messages fallback
const msgFetchTimes = new RecencyMap();

// sessionID -> last modelID / providerID / input tokens / reasoning seen.
// The modelID/providerID pair is turned into a `<providerID>:<modelID>` limit
// lookup key at every modelLimits/modelPrices access site (the maps themselves
// are model-keyed, these caches are session-keyed by design).
const lastKnownModelCache = new RecencyMap();
const lastKnownProviderCache = new RecencyMap();
const lastKnownInputCache = new RecencyMap();
const lastKnownReasoningCache = new RecencyMap();
// sessionID -> last native opencode overflow count (tokens.total, else
// input + output + cache.read + cache.write)
const lastKnownCtxCache = new RecencyMap();
// sessionID -> last provider-reported prompt-cache figures from
// session.step.ended (`tokens.cache.read` / `tokens.cache.write`). These are
// EXACT provider numbers (not estimates) and are a subset of `input`, so they
// are shown as a separate metric and never folded into the category sum.
const lastKnownCacheReadCache = new RecencyMap();
const lastKnownCacheWriteCache = new RecencyMap();

// sessionID -> last time we wrote a live breakdown snapshot
const lastBdWrite = new RecencyMap();

// sessionID -> { sig, at } — dedup for session.error / info.error toasts
const lastErrorToast = new RecencyMap();

// sessionID -> timestamp — dedup for session.compacted toasts
const lastCompactedToast = new RecencyMap();

// sessionID -> timestamp — when the `compaction` HOOK last fired for a session.
// The hook is dispatched at the START of a compaction request (before the model
// summarises), carrying the exact pre-compaction context, so it lets us persist
// the TRUE pre-compaction breakdown. It also tells the later `session.compacted`
// EVENT that the hook already marked the entry (the event stays a fallback).
const lastCompactionHookAt = new RecencyMap();

// sessionID -> parentID (null = main session) — [main]/[sub] attribution cache
const sessionParentCache = new RecencyMap();

// Refresh the recency slot of a session whose parent attribution was captured
// ONCE (session.created). Without this the map would behave like FIFO for a
// long-lived root: it is inserted first, so with 256 live sessions the cap would
// drop the root's attribution first and a later report would treat its children
// as orphan roots. Called from the per-step hot path (already in memory, no RPC).
// A missing key is left missing on purpose: V1 re-resolves it on the next toast
// (`sessionPrefix` does a session.get when absent), while V2 has no re-resolve at
// all - so this touch is V2's only protection.
function touchSessionParent(sessionID) {
  if (!sessionID || !sessionParentCache.has(sessionID)) return;
  sessionParentCache.set(sessionID, sessionParentCache.get(sessionID));
}

// V2: sessionID -> { input, output, reasoning, ctx, modelID, at } accumulated
// from session.step.ended, used to fold child-session totals into the parent.
const sessionTotals = new RecencyMap();

// V2: sessionID -> agent name (session.created data.agent). Used as the role
// label ("sub:<agent>") in the TUI /cx panel and the Desktop panel rows.
const sessionAgentCache = new RecencyMap();

// sessionID -> last time we hit the client session.context() fallback.
const v2ContextFetchTimes = new RecencyMap();

function lastKnownModel(sessionID) {
  return lastKnownModelCache.get(sessionID) || "unknown";
}

// Model-scoped read of the live breakdown. A cache entry measured for a
// DIFFERENT model describes the payload that model received (same session, other
// window / other tool share), so it must not be reported as this model's split.
// Unknown on EITHER side is tolerated: entries written before the `model` tag
// existed carry none, and a mirror instance may not know the model yet.
function breakdownForModel(sessionID, modelID) {
  const bd = breakdownCache.get(sessionID) || null;
  if (!bd) return null;
  const tagged = typeof bd.model === "string" ? bd.model : "unknown";
  if (tagged === "unknown" || !modelID || modelID === "unknown") return bd;
  return tagged === modelID ? bd : null;
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
      // cap eviction and never be updated again.
      clearSessionTracking(childID);
      if (!seen.has(childID)) {
        seen.add(childID);
        queue.push(childID);
      }
    }
  }
}

export {
  RecencyMap,
  MAP_MAX_ENTRIES,
  MAX_TRACKED_SESSIONS,
  STATE_MAX_ENTRIES,
  STATE_MAX_BYTES,
  BREAKDOWN_THROTTLE_MS,
  TOOL_SCHEMA_TTL_MS,
  ERROR_TOAST_DEDUP_MS,
  COMPACTED_TOAST_DEDUP_MS,
  lastShown,
  breakdownCache,
  breakdownForModel,
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
  touchSessionParent,
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
