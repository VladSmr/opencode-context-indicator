/**
 * context-indicator.js
 *
 * Context-size indicator + per-category breakdown for opencode.
 *
 * ---------------------------------------------------------------------------
 * TWO MODES (dual-format plugin)
 * ---------------------------------------------------------------------------
 *
 * V1 (opencode >= 1.18.29) — `server()` (preserved unchanged from the original
 * plugin; NOT active on Desktop v2, but kept so the classic runtime keeps
 * working):
 *   - throttled real-time TOAST after each assistant message:
 *
 *       ctx 12.3k / 131k (9%) · r 1.2k · c 3.4k
 *
 *     r = reasoning tokens, c = cache.read tokens (only when nonzero); cost is
 *     appended ONLY when the model config carries explicit pricing (custom
 *     providers usually omit it -> no cost noise). Metric = the native opencode
 *     overflow count: tokens.total when present, else input + output +
 *     cache.read + cache.write.
 *   - toast signals: session.error, session.compacted, message.part.updated
 *     (compaction / retry parts), assistant info.error;
 *   - [main]/[sub] attribution via Session.parentID;
 *   - subagent per-child ratios via client.session.children + messages;
 *   - model limits via client.config.providers(), fallback config() hook
 *     (every provider in the config: <providerID>.models[<modelID>].limit).
 *
 * V2 (opencode >= 2.0.16, OpenCode Desktop) — `setup(ctx)`:
 *   - NO TOASTS. The Desktop v2 plugin API exposes no TUI/toast channel
 *     (issue #49380); a Desktop-extension API that would enable toasts is
 *     still a PR (#47948). So the V2 path intentionally drops toast output
 *     and delivers the SAME information through the breakdown log below.
 *     TODO: restore the realtime toast once the Desktop-extension API ships.
 *   - the NICHE of the V2 path is the per-category context breakdown in
 *       %TEMP%\context-breakdown.log   (os.tmpdir()/context-breakdown.log)
 *     - live snapshot (rewritten, atomic temp+rename) and
 *     - final summaries on session.idle (in-memory bounded list, persisted by
 *       rewriting the file);
 *     categories: user / assistant / reasoning / tool(args only) / system
 *       prompt / tool schemas / other(= input - sum of estimates) + subagents.
 *
 *   V2 sources (verified against @opencode/plugin 2.0.16 / @opencode/schema):
 *     - ctx.session.hook("context", cb)
 *         SessionContext = { sessionID, model: {providerID,id,variant?},
 *           system: SystemPart[] (mut), messages: Message[] (mut),
 *           tools: Record<name,{description,input:JsonSchema}>, options,
 *           agent }. Fires right before a model request, carrying the FINAL
 *           messages + assembled system prompt + the tool schemas. We only
 *           READ it (never mutate). This is the 1:1 replacement of V1's
 *           experimental.chat.messages.transform + system.transform, and it
 *           even gives tool schemas explicitly (V1 had to call client.tool.list)
 *           — so the "tool schemas" category is more accurate here than in V1.
 *     - ctx.event.subscribe() -> session.created (data.parentID for [sub]
 *         tracking + data.model), session.idle / session.deleted /
 *         session.compacted (data.sessionID), session.step.ended
 *         (data.tokens {input,output,reasoning,cache:{read,write}}, data.cost,
 *         data.finish), session.step.failed / session.execution.failed /
 *         session.execution.interrupted (notes).
 *     - ctx.model.list() -> { data: ModelInfo[] } with limit.context per model
 *         (the V2 replacement for client.config.providers()).
 *
 *   V2 subagents: the V2 SessionDomain has NO children/messages API (only
 *   create/get/.../context). So child sessions are tracked from
 *   session.created (parentID) and their token totals accumulated from
 *   session.step.ended (keyed by the child's own sessionID). This is
 *   event-driven and does not need the removed API.
 *
 *   V2 slash commands (added 1.1.0, verified against the live Desktop 2.0.19
 *   plugin runtime). Two commands:
 *     - /context — a 3-line summary of THIS session only (model, tokens, %,
 *       updated + category line). Main only: NO subagent traversal and NO live
 *       RPC (cache + state.json only), so it is instant. Delivered as a
 *       resume:false notice; the chip label (`description`) is self-contained:
 *       "Context: 41.5k (25%) · Auto · 12:36".
 *     - /context-breakdown — the full markdown table (main + all subagent
 *       descendants), collected in parallel under one budget. Delivered with
 *       resume:true and a verbatim instruction prefix, so the agent echoes the
 *       table into the transcript as a normal message (rendered in full by the
 *       Desktop); resume:false remains a one-constant fallback.
 *     - ctx.command.transform(editor => editor.add({ name, description,
 *         execute })) — registers a slash command; `execute` receives the
 *       invocation { sessionID, prompt:{text,files,agents,skills}, delivery }.
 *     - ctx.session.synthetic({ sessionID, text, description?, resume? }) —
 *       durably ADMITS a synthetic message to the session INBOX. `resume` only
 *       gates whether the session is woken (Session.synthetic:
 *       `if (resume !== false) wake(session)`): resume:true starts an agent turn
 *       (grows session context), resume:false leaves a durable notice without
 *       running the agent loop. A synthetic message is always shown as a compact
 *       Notice chip whose label is `description ?? text` (client row-builder:
 *       `synthetic` -> Notice), which is exactly why /context-breakdown uses
 *       resume:true: the model answer, not the chip, carries the full table.
 *     - session list = the parentID chain persisted in state.json (BFS from the
 *       root; see collectDescendantSessionIDs). state.json is the ONLY source:
 *       every entry is keyed by its own sessionID and carries the parentID
 *       recorded at write time, so the chain is root-consistent — entries of
 *       OTHER roots are unreachable. Finished / deleted subagents stay listed
 *       while their state.json entry exists. Module-scope maps persist across
 *       requests for the lifetime of a plugin INSTANCE; PluginSupervisor
 *       (re)activates the plugin on start / config or file change / every 24h —
 *       NOT per request — so an in-memory index would be cold for sessions
 *       created before the current instance loaded, which is exactly why
 *       discovery uses the durable state.json instead.
 *     - All logic stays in module scope: the handlers need the in-memory maps.
 *       The V1 server() path is intentionally untouched (commands are V2-only).
 *
 * ---------------------------------------------------------------------------
 * TUI STATE BRIDGE (optional sidebar)
 * ---------------------------------------------------------------------------
 *
 *   Every live/final log write ALSO rewrites
 *     %TEMP%\opencode-context-indicator-state.json   (os.tmpdir())
 *   — a machine-readable { sessionID: { model, providerID, ctx, usable,
 *     limit, categories{...}, updatedAt } } snapshot consumed by the optional
 *   TUI sidebar in ./tui.tsx (package entry "./tui"). Written atomically
 *   (temp + rename), keyed by session, bounded to MAX_TRACKED_SESSIONS, and
 *   strictly additive: any failure is swallowed and never affects the log.
 *
 * ---------------------------------------------------------------------------
 * SHARED DESIGN
 * ---------------------------------------------------------------------------
 *
 *   - Metric: the native opencode overflow count — tokens.total when present,
 *     else input + output + cache.read + cache.write — compared against the
 *     model's usable window (limit.input − reserved, else limit.context −
 *     maxOutput). Percentages are NOT clamped at 100% — exceeding the window
 *     must stay visible.
 *   - Category estimates use a unicode-aware heuristic (see estimateTokens):
 *     Cyrillic ~2.5 chars/token, CJK ~1.5, latin/ASCII ~4. These are ESTIMATES,
 *     not a tokenizer; "other" is the residual input − sum of estimates.
 *   - Fault tolerant: ANY failure in breakdown/file/subagent code is caught and
 *     logged — it must never break the main path.
 *   - Does NOT touch opencode-token-monitor (token_stats / token_history /
 *     token_export keep working unchanged).
 *
 * Cross-instance behaviour: OpenCode loads one plugin instance per location and
 * mirrors the public event stream to every instance. The live snapshot is an
 * idempotent full-file rewrite (written atomically via temp+rename), so
 * concurrent writers cannot corrupt it. Final summaries, however, would be
 * emitted once per instance; they are therefore claimed exactly-once through
 * ./lib/dedup.js (claimOnce("final:<eventID>")). The MESSAGE transform hook /
 * context hook is per served request; breakdown estimates are process-local and
 * rebuilt on the next request.
 *
 * DEBUG_EVENTS: when true, every incoming event.type is appended to
 * %TEMP%\context-events.log (full JSON payload for session.error, sessionID
 * for session.compacted; file truncated at ~1MB). Flip to false to disable.
 */

import { tmpdir } from "node:os";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { claimOnce, pruneMap } from "./lib/dedup.js";

const THROTTLE_MS = 2500; // min gap between toasts
const MIN_GROWTH_TOKENS = 2048; // only re-toast if context grew by this many tokens
const MAX_TRACKED_SESSIONS = 256; // LRU cap for maps
const BREAKDOWN_THROTTLE_MS = 7500; // min gap between live breakdown writes
const MSG_FETCH_THROTTLE_MS = 30000; // min gap between fallback session.messages calls
const SUBAGENT_THROTTLE_MS = 30000; // min gap between subagent aggregations
const TOOL_SCHEMA_TTL_MS = 3600 * 1000; // tool schemas rarely change
const MAX_FINAL_SUMMARIES = 50; // bound the in-memory final-summary log
// Token-estimate densities by script (unicode heuristic — estimate, not a
// tokenizer): Latin/ASCII ~4 chars/token, Cyrillic ~2.5, CJK ~1.5.
const CHARS_PER_TOKEN_OTHER = 4;
const CHARS_PER_TOKEN_CYRILLIC = 2.5;
const CHARS_PER_TOKEN_CJK = 1.5;
const CRITICAL_RATIO = 0.9; // > this fill: bypass growth gate, shorter throttle
const CRITICAL_THROTTLE_MS = 10000; // min gap between critical (>90%) toasts
const ERROR_TOAST_DEDUP_MS = 60000; // same error -> at most one toast / window
const COMPACTED_TOAST_DEDUP_MS = 60000; // compacted-toast dedup window
const PROVIDERS_TTL_MS = 5 * 60 * 1000; // providers()/model.list() cache TTL after SUCCESS
const PROVIDERS_FAIL_TTL_MS = 30 * 1000; // retry-no-sooner base after FAILURE (doubles per consecutive miss)
const V2_LIMITS_MAX_BACKOFF_MS = 5 * 60 * 1000; // cap for the model.list retry backoff
const PROVIDERS_FETCH_TIMEOUT_MS = 2000; // hard cap for one providers() call (V1)
const V2_MODEL_FETCH_TIMEOUT_MS = 8000; // hard cap for one ctx.model.list() call (V2)
const TOAST_MS_ERROR = 8000; // duration for error / overflow toasts

// --- DEBUG instrumentation (behaviour probing on Desktop) ---
// When true, every incoming event.type is appended to %TEMP%\context-events.log
// (full JSON payload for session.error, sessionID for session.compacted).
// The file is truncated once it exceeds ~1MB. Flip to false to disable.
const DEBUG_EVENTS = false;
const EVENT_LOG_MAX_BYTES = 1024 * 1024; // ~1MB truncate threshold

const LOG_FILE = join(tmpdir(), "context-breakdown.log");

// Machine-readable snapshot consumed by the optional TUI sidebar (./tui.tsx,
// package entry "./tui"). Written next to each log update — same moment, same
// data. See writeStateFile() below.
// State file path — overridable via env for test isolation.
// In production the env is never set, so behaviour is unchanged.
// In tests: export OPENCODE_CONTEXT_INDICATOR_STATE_FILE=/tmp/test-state.json
// and the harness writes a controlled seed; no live file is touched.
const STATE_FILE =
  process.env.OPENCODE_CONTEXT_INDICATOR_STATE_FILE ||
  join(tmpdir(), "opencode-context-indicator-state.json");

// Separate tap log for raw events (written only when DEBUG_EVENTS is true).
const EVENT_LOG_FILE = join(tmpdir(), "context-events.log");

// Cross-instance dedup markers for the context-indicator (see ./lib/dedup.js).
// Used for final summaries / compacted / error notes: the live snapshot itself
// is an idempotent rewrite and needs no claim.
const DEDUP_DIR = join(tmpdir(), "context-indicator.dedup");

// sessionID -> { at, tokens }
const lastShown = new Map();

// `<providerID>:<modelID>` -> { context, input, output, reserved } limit record,
// populated lazily from the merged config / providers() / model.list.
const modelLimits = new Map();

// `<providerID>:<modelID>` -> { input, output, cacheRead, cacheWrite } — ONLY
// when the model config carries explicit pricing (custom providers usually omit).
const modelPrices = new Map();

// sessionID -> captured breakdown from transform hooks / context hook / fallback
// { systemChars, userChars, assistantChars, reasoningTokens, reasoningChars,
//   toolArgsChars, toolSchemasChars, capturedAt, source }
// NOTE: the *Chars fields are TOKEN estimates (unicode heuristic — see
// estimateTokens); the name is kept from the original plugin for 1:1 diffability.
const breakdownCache = new Map();

// `<providerID>:<modelID>` -> { chars, at } — cached tool-schema estimate (V1 path)
const toolSchemaCache = new Map();

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

// sessionID -> last time we wrote a live breakdown snapshot
const lastBdWrite = new Map();

// sessionID -> { sig, at } — dedup for session.error / info.error toasts
const lastErrorToast = new Map();

// sessionID -> timestamp — dedup for session.compacted toasts
const lastCompactedToast = new Map();

// sessionID -> parentID (null = main session) — [main]/[sub] attribution cache
const sessionParentCache = new Map();

// V2: sessionID -> { input, output, reasoning, ctx, modelID, at } accumulated
// from session.step.ended, used to fold child-session totals into the parent.
const sessionTotals = new Map();

// V2: sessionID -> agent name (session.created data.agent). Used only as the
// role label ("sub:<agent>") in the /context-breakdown table.
const sessionAgentCache = new Map();

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

// Bounded list of final summaries written on session.idle
const finalSummaries = [];

function fmt(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// Unicode-aware TOKEN estimate (heuristic, NOT a tokenizer). The string is
// scanned ONCE by code point and split into three density buckets:
//   - Cyrillic (U+0400–U+04FF + supplements/extensions): ~2.5 chars/token
//   - CJK / Japanese / Korean (U+4E00–U+9FFF, U+3040–U+30FF, …): ~1.5
//   - everything else (latin/ASCII/digits/punct): ~4
// tokens = cyr/2.5 + cjk/1.5 + other/4. Single O(n) pass, no intermediate
// arrays (these strings can be 100k+ chars). Guards against absurd input.
function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === "string" ? text : String(text);
  const len = s.length;
  if (len === 0) return 0;
  let other = 0;
  let cyr = 0;
  let cjk = 0;
  for (let i = 0; i < len; i++) {
    const cp = s.codePointAt(i);
    if (cp > 0xffff) i++; // astral pair — consume the low surrogate
    if (cp < 0x80) {
      other++;
    } else if (
      (cp >= 0x0400 && cp <= 0x04ff) || // Cyrillic
      (cp >= 0x0500 && cp <= 0x052f) || // Cyrillic Supplement
      (cp >= 0x2de0 && cp <= 0x2dff) || // Cyrillic Extended-A
      (cp >= 0xa640 && cp <= 0xa69f) || // Cyrillic Extended-B
      (cp >= 0x1c80 && cp <= 0x1c8f) // Cyrillic Extended-C
    ) {
      cyr++;
    } else if (
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
      (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
      (cp >= 0xac00 && cp <= 0xd7af) || // Hangul Syllables
      (cp >= 0x3000 && cp <= 0x303f) || // CJK Symbols and Punctuation
      (cp >= 0xff00 && cp <= 0xffef) // Halfwidth/Fullwidth Forms
    ) {
      cjk++;
    } else {
      other++;
    }
  }
  return Math.round(
    other / CHARS_PER_TOKEN_OTHER +
      cyr / CHARS_PER_TOKEN_CYRILLIC +
      cjk / CHARS_PER_TOKEN_CJK,
  );
}

// Token estimate from a serializable value (tool args / params).
function estJson(value) {
  if (value == null) return 0;
  try {
    return estimateTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

// Native opencode overflow count for a tokens object:
//   count = tokens.total || input + output + cache.read + cache.write
// (with legacy flat cacheRead/cacheWrite fallbacks) — the exact value opencode
// compares against the model's usable window in its overflow check.
function tokenCountOf(tokens) {
  if (!tokens) return 0;
  if (typeof tokens.total === "number" && tokens.total > 0) return tokens.total;
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
  return (tokens.input || 0) + (tokens.output || 0) + cacheRead + cacheWrite;
}

// ---------------------------------------------------------------------------
// Logging helpers (all fault-tolerant; never throw into the caller).
// ---------------------------------------------------------------------------

function logErr(msg, err) {
  try {
    console.error(`[context-indicator] ${msg}:`, err);
  } catch {
    /* ignore */
  }
}

// Build the full file content: header + live snapshot + final summaries.
function renderFile(liveLines) {
  const lines = [];
  lines.push(
    "# context-breakdown.log",
    `# generated ${new Date().toISOString()} by context-indicator plugin`,
    "# estimates: unicode heuristic (cyrillic 2.5, CJK 1.5, other 4 chars/token) — estimate, not a tokenizer",
    "# live snapshot is rewritten; final summaries are preserved (bounded)",
    "",
    "## live snapshot",
    ...liveLines,
    "",
    "## final summaries",
  );
  if (finalSummaries.length === 0) {
    lines.push("(none yet)");
  } else {
    for (const s of finalSummaries) lines.push(s);
  }
  return lines.join("\n") + "\n";
}

// Atomically rewrite the whole log file (bounded by design). The temp+rename
// makes concurrent writers from multiple plugin instances safe: a reader sees
// either the previous or the new file, never a half-written one.
function writeLog(liveLines) {
  try {
    const content = renderFile(liveLines);
    const tmp = `${LOG_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, LOG_FILE);
  } catch (err) {
    logErr("writeLog failed", err);
  }
}

// Append a single line to the file (used for final summaries / notes).
function appendLogLine(line) {
  try {
    appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch (err) {
    logErr("appendLogLine failed", err);
  }
}

// ---------------------------------------------------------------------------
// TUI state bridge (opencode-context-indicator)
// ---------------------------------------------------------------------------
// Persist a tiny machine-readable snapshot of the CURRENT breakdown for one
// session so the optional TUI sidebar (./tui.tsx, package entry "./tui") can
// render it without talking to the server. The file is one JSON object keyed by
// sessionID, rewritten atomically (temp + rename) at every log write — same
// moment, same data. Strictly additive: any failure is swallowed and must never
// affect the log / toast / event paths.
function writeStateFile(
  sessionID,
  modelID,
  providerID,
  inputTokens,
  ctxTokens,
  reasoningTokens,
) {
  try {
    if (!sessionID) return;
    const bd = breakdownCache.get(sessionID) || null;
    const limit = getModelLimit(providerID, modelID);
    const usableInfo = getUsableContext(providerID, modelID);
    const denom =
      usableInfo != null
        ? usableInfo.usable
        : limit != null && limit > 0
          ? limit
          : null;
    const total =
      typeof ctxTokens === "number" && ctxTokens > 0
        ? ctxTokens
        : inputTokens || 0;

    // Read the existing file FIRST: when THIS instance has no fresh breakdown
    // (the context hook did not fire here — e.g. the request was served by
    // another plugin instance whose event stream is mirrored to us), keep the
    // values already persisted instead of clobbering them with nulls/zeros.
    let all = {};
    try {
      all = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    } catch {
      all = {}; // missing / empty / corrupt -> start fresh
    }
    if (!all || typeof all !== "object" || Array.isArray(all)) all = {};
    const prevEntry = all[sessionID] || null;
    const pc = all[sessionID]?.categories || null;

    // Same model AND provider? Only then is a previously persisted denominator
    // meaningful — a session that switched model (or provider, even with the
    // same modelID) must not inherit the old window.
    const sameModelAsPrev =
      prevEntry != null &&
      prevEntry.model === (modelID || "unknown") &&
      (prevEntry.providerID || "") === (providerID || "");

    const catUser = bd ? bd.userChars || 0 : pc?.user ?? 0;
    const catAssistant = bd ? bd.assistantChars || 0 : pc?.assistant ?? 0;
    const catReasoning = bd ? bd.reasoningChars || 0 : pc?.reasoning ?? 0;
    const catToolArgs = bd ? bd.toolArgsChars || 0 : pc?.toolArgs ?? 0;
    // system / tool schemas are hook-only; a fallback breakdown has them null
    // and must not erase a value the hook already persisted.
    const catSystem =
      bd && bd.systemChars != null ? bd.systemChars : pc?.system ?? null;
    const catToolSchemas =
      bd && bd.toolSchemasChars != null
        ? bd.toolSchemasChars
        : pc?.toolSchemas ?? null;

    const sumEstimates =
      catUser +
      catAssistant +
      catReasoning +
      catToolArgs +
      (catSystem || 0) +
      (catToolSchemas || 0);
    const other = Math.max(0, (inputTokens || 0) - sumEstimates);
    // Parent link for the /context-breakdown command. Prefer the live cache;
    // fall back to the previously persisted value (backward compatible with
    // snapshots written before parentID existed -> null). role mirrors it.
    const parentID =
      sessionParentCache.has(sessionID)
        ? sessionParentCache.get(sessionID) ?? null
        : prevEntry?.parentID ?? null;
    const entry = {
      sessionID,
      parentID,
      role: parentID ? "sub" : "main",
      agent: sessionAgentCache.get(sessionID) || prevEntry?.agent || null,
      model: modelID || "unknown",
      providerID: providerID || "",
      ctx: total,
      input: inputTokens || 0,
      // Do NOT clobber a known denominator with null: multiple plugin instances
      // share this file and one of them may lack modelLimits (its ctx.model.list
      // returned nothing). Keep the previous model's known value when the live
      // lookup came back empty, so a transient miss never becomes permanent.
      usable:
        denom != null ? denom : sameModelAsPrev ? prevEntry.usable ?? null : null,
      limit:
        limit != null
          ? limit
          : sameModelAsPrev && typeof prevEntry.limit === "number"
            ? prevEntry.limit
            : null,
      reasoning: typeof reasoningTokens === "number" ? reasoningTokens : 0,
      categories: {
        user: catUser,
        assistant: catAssistant,
        reasoning: catReasoning,
        toolArgs: catToolArgs,
        system: catSystem,
        toolSchemas: catToolSchemas,
        other,
      },
      updatedAt: new Date().toISOString(),
    };
    all[sessionID] = entry;
    // Bound the file: keep the most recently updated MAX_TRACKED_SESSIONS.
    const keys = Object.keys(all);
    if (keys.length > MAX_TRACKED_SESSIONS) {
      keys
        .sort((a, b) =>
          String(all[b]?.updatedAt || "").localeCompare(
            String(all[a]?.updatedAt || ""),
          ),
        )
        .slice(MAX_TRACKED_SESSIONS)
        .forEach((k) => delete all[k]);
    }
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), "utf8");
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    logErr("writeStateFile failed", err);
  }
}

// ---------------------------------------------------------------------------
// DEBUG event tap (DEBUG_EVENTS only; fully fault-tolerant — any failure here
// is swallowed and must never affect the main path).
// ---------------------------------------------------------------------------

// Append one line to the event log, truncating it when it grows past ~1MB.
function appendEventLog(line) {
  try {
    try {
      const st = statSync(EVENT_LOG_FILE);
      if (st.size > EVENT_LOG_MAX_BYTES) {
        writeFileSync(EVENT_LOG_FILE, "", "utf8"); // truncate, keep it bounded
      }
    } catch {
      // file does not exist yet — nothing to truncate
    }
    appendFileSync(EVENT_LOG_FILE, line + "\n", "utf8");
  } catch (err) {
    logErr("appendEventLog failed", err);
  }
}

// Tap every incoming event: timestamp + type. session.error gets the full
// JSON payload, session.compacted gets the sessionID. Never throws.
function debugEvent(event) {
  if (!DEBUG_EVENTS || !event) return;
  try {
    let line = `[${new Date().toISOString()}] ${event.type}`;
    if (event.type === "session.error") {
      try {
        line += ` ${JSON.stringify(event.properties ?? event.data ?? {})}`.slice(
          0,
          4000,
        );
      } catch {
        line += " <unserializable payload>";
      }
    } else if (event.type === "session.compacted") {
      const sid =
        event.properties?.sessionID ?? event.data?.sessionID ?? "?";
      line += ` sessionID=${sid}`;
    }
    appendEventLog(line);
  } catch (err) {
    logErr("debugEvent failed", err);
  }
}

// Reject when `promise` has not settled within `ms`. The underlying promise
// is not cancellable in JS — its late result is simply discarded. The timer
// is always cleared; never leaves a dangling timeout.
function withTimeout(promise, ms, label) {
  let timer;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: no response within ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

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

  let text = "session compacted (auto) — возможно, контекст был переполнен";
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
// Clear per-session tracking. Full wipe on session.idle / session.deleted;
// on session.compacted (keepToastDedup=true) the toast-dedup entries survive
// the cleanup so consecutive compacted events still dedup.
// ---------------------------------------------------------------------------

function clearSessionTracking(sessionID, keepToastDedup = false) {
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
  sessionParentCache.delete(sessionID);
  // Idle-summary caches were previously left dirty — clean them too.
  lastKnownModelCache.delete(sessionID);
  lastKnownProviderCache.delete(sessionID);
  lastKnownInputCache.delete(sessionID);
  lastKnownReasoningCache.delete(sessionID);
  lastKnownCtxCache.delete(sessionID);
  lastBdWrite.delete(sessionID);
  // V2 subagent accumulation for this session.
  sessionTotals.delete(sessionID);
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
        : `  system      n/a (hook не сработал)`,
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
    lines.push(`  system      n/a (hook не сработал)`);
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

// ---------------------------------------------------------------------------
// V2 (OpenCode >= 2.0.16) — context hook + event stream, no toasts.
// ---------------------------------------------------------------------------

// Estimate the per-category breakdown directly from a V2 SessionContext.
// `context.messages` are @opencode/ai Message objects:
//   { role, content: [ {type:"text",text} | {type:"media"} |
//                      {type:"tool-call",input} | {type:"tool-result"} |
//                      {type:"reasoning",text} | ... ] }
// `context.system` are SystemPart[] { type:"text", text }.
// `context.tools` is Record<name, { description, input: JsonSchema }>.
// As in V1, tool RESULTS are deliberately not counted (only call args), and
// every returned *Chars value is a TOKEN estimate (unicode heuristic).
function estimateBreakdownFromContext(context) {
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
    for (const t of Object.values(tools)) {
      toolSchemasChars += estimateTokens(t?.description) + estJson(t?.input);
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

    const parts = estimateBreakdownFromContext(context);
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

// sessionID -> last time we hit the client session.context() fallback.
const v2ContextFetchTimes = new Map();
const V2_CONTEXT_FETCH_THROTTLE_MS = 5000; // min gap between fallback fetches
// Background fallback requests are fire-and-forget (see the callers in the
// event handlers): cap each at 3s so a slow/hung client cannot pin resources.
const V2_FALLBACK_TIMEOUT_MS = 3000;

// Cumulative wall-clock budget for one /context-breakdown collection (root +
// every descendant, fetched in PARALLEL). Each per-session live lookup is
// additionally capped at V2_FALLBACK_TIMEOUT_MS, so the command costs about the
// per-session cap (not the sum) instead of N × 3s for N subagents. A session
// with no cached/snapshot categories whose bounded session.context lookup fails
// or never gets any budget is tagged "no-data": ctx/model/updatedAt still come
// from state.json / live, but the category cells stay n/a.
const COMMAND_COLLECT_BUDGET_MS = 3500;

// `resume` for the full /context-breakdown command. resume:true admits the
// payload to the transcript AND wakes the session, so the agent echoes the table
// as a normal message that the Desktop renders in full (the notice chip only
// shows `description`). Set to false to fall back to a plain inbox notice if a
// given runtime renders the model answer worse than the notice.
const CONTEXT_BREAKDOWN_RESUME = true;

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
        : `  system      n/a (hook не сработал)`,
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
    lines.push(`  system      n/a (hook не сработал)`);
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

// Append a note to the persisted final-summaries section (claimed once across
// instances). Never throws.
function pushFinalSummary(claimKey, summaryLines) {
  try {
    if (!claimOnce(claimKey, DEDUP_DIR)) return;
    finalSummaries.push(summaryLines.join("\n"));
    if (finalSummaries.length > MAX_FINAL_SUMMARIES) {
      finalSummaries.splice(0, finalSummaries.length - MAX_FINAL_SUMMARIES);
    }
    writeLog([]); // persist final summaries
  } catch (err) {
    logErr("pushFinalSummary failed", err);
  }
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
          `[${new Date().toISOString()}] COMPACTED session=${sid} (auto — возможно, контекст был переполнен)`,
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
    const sid = data.sessionID || "?";
    const interrupted = event.type === "session.execution.interrupted";
    const err = data.error || {};
    const name = interrupted
      ? "Interrupted"
      : typeof err.type === "string"
        ? err.type
        : "session error";
    const detail = String(err.message || data.reason || "").slice(0, 200);
    const bucket = Math.floor(Date.now() / ERROR_TOAST_DEDUP_MS);
    pushFinalSummary(`err:${sid}:${name}:${bucket}`, [
      `[${new Date().toISOString()}] ERROR session=${sid} ${name}${detail ? `: ${detail}` : ""}`,
    ]);
  }
}

// ---------------------------------------------------------------------------
// V2 slash commands: /context and /context-breakdown
// ---------------------------------------------------------------------------
// /context prints a 3-line summary of the CURRENT session only (cache +
// state.json, no subagents, no RPC); /context-breakdown prints a compact
// markdown table for the CURRENT session plus EVERY descendant (subagent)
// session. Both deliver via ctx.session.synthetic({sessionID, text, ...}):
// resume:true -> wake / agent turn (the model renders the table);
// resume:false -> a durable notice, no LLM call. Works in the Desktop v2 app
// (which has no TUI slots, issue #49380) and in the TUI. Registered only on
// the V2 path.
//
// Session resolution cascade (per task): in-memory breakdownCache -> the
// state.json snapshot -> a throttled/3s ctx.session.context() fallback. The
// fallback cannot see the assembled system prompt or the tool schemas, so those
// two cells stay "n/a" and the row's source is labelled honestly.

// Read the whole state.json snapshot ({ sessionID: entry }) or {} on any error.
function readStateSnapshot() {
  try {
    const all = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
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
      const usable =
        typeof entry?.usable === "number" && entry.usable > 0
          ? entry.usable
          : null;
      const limit =
        typeof entry?.limit === "number" && entry.limit > 0 ? entry.limit : null;
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

// True when a state.json entry carries no measured tokens at all: a session
// registered (session.created) but with no served step. `writeStateFile` always
// persists `categories` as an object, so the emptiness test must SUM those
// fields — a missing/`undefined` categories must not be the only trigger.
// Note: `system` / `toolSchemas` may legitimately be null (hook-only), so they
// are coerced with `|| 0`.
function isEmptyStateEntry(entry) {
  const c = entry?.categories || {};
  const sum =
    (c.user || 0) +
    (c.assistant || 0) +
    (c.reasoning || 0) +
    (c.toolArgs || 0) +
    (c.system || 0) +
    (c.toolSchemas || 0) +
    (c.other || 0);
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

// Normalise a breakdown record (cache or state entry) into the 7 categories.
// `inputTokens` is used only for the residual "other".
function breakdownCategories(rec, inputTokens) {
  const user = rec?.userChars ?? rec?.user ?? 0;
  const assistant = rec?.assistantChars ?? rec?.assistant ?? 0;
  const reasoning = rec?.reasoningChars ?? rec?.reasoning ?? 0;
  const toolArgs = rec?.toolArgsChars ?? rec?.toolArgs ?? 0;
  const system = rec?.systemChars !== undefined ? rec.systemChars : rec?.system ?? null;
  const toolSchemas =
    rec?.toolSchemasChars !== undefined ? rec.toolSchemasChars : rec?.toolSchemas ?? null;
  const sum =
    user + assistant + reasoning + toolArgs + (system || 0) + (toolSchemas || 0);
  const other = Math.max(0, (inputTokens || 0) - sum);
  return { user, assistant, reasoning, toolArgs, system, toolSchemas, other };
}

// Short source tag for the table (kept tiny on purpose).
function sourceTag(source) {
  switch (source) {
    case "context-hook":
      return "live";
    case "client-context":
      return "fallback";
    case "snapshot":
      return "snap";
    case "no-data":
      return "no-data";
    default:
      return source || "none";
  }
}

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
// `deadline` is the shared wall-clock budget for the whole command collection
// (see commandContextBreakdown): the per-session live lookups are capped by
// whatever remains of it and skipped once it is exhausted. A session that ends
// up with no category data is tagged "no-data" (see the branch below).
async function collectSessionReport(ctx, sessionID, state, deadline) {
  const entry = state?.[sessionID] || null;
  const bd = breakdownCache.get(sessionID) || null;

  const remaining = Math.max(0, (deadline || 0) - Date.now());
  const budget = Math.min(V2_FALLBACK_TIMEOUT_MS, remaining);

  // The attribution/model caches survive across requests for the lifetime of a
  // plugin instance. When cold — and while budget remains — resolve the session
  // live so the [sub:<agent>] attribution and the model stay correct even if
  // state.json is stale. ParentID comes from state.json ONLY (entry?.parentID)
  // so the table is root-consistent; in-memory sessionParentCache is cross-session
  // and must NOT be used for attribution.
  const needEnrich =
    !sessionAgentCache.has(sessionID) ||
    lastKnownModel(sessionID) === "unknown";

  // Fallback categories only when neither the live cache nor a state snapshot
  // has them: derive user/assistant/reasoning/tool-args from the persisted
  // message list (system/tool-schemas stay null there).
  const needFallback = !bd && !entry?.categories;

  // Enrichment and the context fallback run CONCURRENTLY, both bounded by the
  // shared budget. Non-fatal: any failure resolves to null and keeps whatever
  // the cache / state.json already provides.
  const [live, contextMsgs] = await Promise.all([
    needEnrich && budget > 0
      ? withTimeout(ctx.session.get({ sessionID }), budget, "session.get").then(
          (info) => info?.data ?? info ?? null,
          (err) => {
            logErr(`context-breakdown: session.get enrichment failed for ${sessionID}`, err);
            return null;
          },
        )
      : null,
    needFallback && budget > 0
      ? withTimeout(ctx.session.context({ sessionID }), budget, "session.context").then(
          (res) => (Array.isArray(res) ? res : res?.data),
          (err) => {
            logErr(`context-breakdown: session.context fallback failed for ${sessionID}`, err);
            return null;
          },
        )
      : null,
  ]);

  let categories = null;
  let source = "none";
  if (bd) {
    categories = breakdownCategories(bd, lastKnownInput(sessionID) || entry?.input || 0);
    source = bd.source || "live";
  } else if (entry?.categories) {
    categories = entry.categories;
    source = "snapshot";
  } else if (Array.isArray(contextMsgs)) {
    categories = breakdownCategories(
      estimateBreakdownFromClientMessages(contextMsgs),
      0,
    );
    source = "client-context";
  } else if (needFallback) {
    // No live cache, no state.json categories, and the bounded session.context
    // fallback produced no usable messages (it failed or had no budget left).
    // The category cells stay n/a; ctx/model/updatedAt still come from
    // state.json / the live lookup.
    source = "no-data";
  }

  const liveModel =
    live?.model && typeof live.model === "object" ? live.model : null;
  const cachedModel = lastKnownModel(sessionID);
  const modelID =
    cachedModel !== "unknown"
      ? cachedModel
      : liveModel?.id || entry?.model || "unknown";
  const providerID =
    lastKnownProvider(sessionID) || liveModel?.providerID || entry?.providerID || "";
  const ctxTokens = lastKnownCtx(sessionID) || entry?.ctx || 0;
  const usableInfo = getUsableContext(providerID, modelID);
  const usable =
    usableInfo?.usable ?? entry?.usable ?? getModelLimit(providerID, modelID) ?? null;
  const parentID = entry?.parentID ?? null;
  const updatedAt =
    entry?.updatedAt ||
    (bd?.capturedAt ? new Date(bd.capturedAt).toISOString() : null);
  return {
    sessionID,
    parentID,
    agent: sessionAgentCache.get(sessionID) || entry?.agent || null,
    modelID,
    providerID,
    ctxTokens,
    usable,
    categories,
    source,
    updatedAt,
  };
}

function fmtCell(n) {
  return n == null ? "n/a" : fmt(n);
}

// One markdown table row. Categories sit in columns (short headers) to keep the
// table compact; the ctx column already carries the percentage.
function renderSessionRow(r, isMain) {
  const c = r.categories || {};
  const role = isMain ? "main" : r.agent ? `sub:${r.agent}` : "sub";
  const pct =
    r.usable && r.usable > 0
      ? ` (${((r.ctxTokens / r.usable) * 100).toFixed(0)}%)`
      : "";
  const ctx = `${fmt(r.ctxTokens)}${pct}`;
  const upd = `${timeOnly(r.updatedAt)} ${sourceTag(r.source)}`;
  return `| ${role} | ${r.modelID} | ${ctx} | ${fmtCell(c.user)} | ${fmtCell(c.assistant)} | ${fmtCell(c.reasoning)} | ${fmtCell(c.toolArgs)} | ${fmtCell(c.system)} | ${fmtCell(c.toolSchemas)} | ${fmtCell(c.other)} | ${upd} |`;
}

function renderBreakdownTable(rows, childCount) {
  const lines = [];
  lines.push("### Context breakdown");
  lines.push("");
  lines.push(
    "| role | model | ctx | usr | asst | rsn | tool | sys | schm | oth | updated (src) |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of rows) lines.push(row);
  lines.push("");
  lines.push(
    `_${childCount} subagent session(s). Tokens are estimates (unicode heuristic). ` +
      `usr=user, asst=assistant, rsn=reasoning, tool=tool args, sys=system prompt, ` +
      `schm=tool schemas, oth=residual input. src: live=context hook, snap=state.json, ` +
      `fallback=session.context (no system/schemas → n/a), no-data=categories unavailable._`,
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

// ---- /context : quick summary of THIS session only (no subagents, no RPC) ----

// The one-line description is what the Desktop notice chip shows, so it must be
// self-contained (model + tokens + % + time).
function shortSummaryDescription(r) {
  const pct =
    r.usable && r.usable > 0
      ? ` (${((r.ctxTokens / r.usable) * 100).toFixed(0)}%)`
      : "";
  const hhmm = timeOnly(r.updatedAt).slice(0, 5);
  const model = r.modelID && r.modelID !== "unknown" ? r.modelID : "model?";
  return `Context: ${fmt(r.ctxTokens)}${pct} · ${model} · ${hhmm}`;
}

// Three short lines, built from cache/state only (see commandContextSummary).
function shortSummaryText(r) {
  const model =
    r.modelID && r.modelID !== "unknown" ? r.modelID : "unknown model";
  const total =
    r.usable && r.usable > 0
      ? ` / ${fmt(r.usable)} (${((r.ctxTokens / r.usable) * 100).toFixed(0)}%)`
      : "";
  const lines = [`**Context** — ${model} · ${fmt(r.ctxTokens)}${total}`];
  const c = r.categories;
  if (c) {
    lines.push(
      `usr ${fmtCell(c.user)} · asst ${fmtCell(c.assistant)} · rsn ${fmtCell(c.reasoning)} · ` +
        `tool ${fmtCell(c.toolArgs)} · sys ${fmtCell(c.system)} · schm ${fmtCell(c.toolSchemas)} · ` +
        `oth ${fmtCell(c.other)}`,
    );
  } else {
    lines.push("_category breakdown unavailable (no cache/state entry yet)_");
  }
  lines.push(`updated ${timeOnly(r.updatedAt)} (${sourceTag(r.source)})`);
  return lines.join("\n");
}

// /context handler: main session only, cache + state.json only (NO enrichment,
// NO child traversal) -> instant. Delivered as resume:true so the model
// renders the 3-line summary as a normal assistant message (the Desktop
// notice chip only shows `description`).
async function commandContextSummary(ctx, invocation, opts) {
  const name = opts?.name || "context";
  const sid = invocation?.sessionID || invocation?.session?.id;
  if (!sid) {
    logErr("context: invocation carried no sessionID");
    return;
  }
  try {
    const state = readStateSnapshot();
    // Deadline in the past => collectSessionReport performs no live RPC at all
    // (cache + state.json only), which keeps this command instant.
    const report = await collectSessionReport(ctx, sid, state, 0);
    const body = shortSummaryText(report);
    // Reproduce verbatim so the model echoes the 3 lines as the assistant
    // answer; the Desktop renders that answer in full (the notice chip only
    // shows `description`).
    const text = `${BREAKDOWN_MODEL_INSTRUCTION}\n\n${body}`;
    const description = shortSummaryDescription(report);
    const delivered = await deliverSynthetic(ctx, sid, text, description, true);
    pushFinalSummary(`cmd:${sid}:${Date.now()}`, [
      `[${new Date().toISOString()}] COMMAND ${name} session=${sid} delivered=${delivered}`,
      ...text.split("\n"),
    ]);
  } catch (err) {
    logErr("context command failed", err);
  }
}

// ---- /context-breakdown : full table (main + subagents), model-rendered ----

// Prefixed to the table for resume:true so the agent echoes it verbatim into the
// transcript (the Desktop renders the model's answer as a normal message).
const BREAKDOWN_MODEL_INSTRUCTION =
  "Reproduce the markdown table below exactly, verbatim, with no changes and no commentary:";

// Command handler shared by both slash commands. Registered via
// ctx.command.transform in setup(); invoked by opencode with
// { sessionID, prompt:{text,...}, delivery }. `opts` = { resume, name }.
async function commandContextBreakdown(ctx, invocation, opts) {
  const resume = !!opts?.resume;
  const name = opts?.name || "context-breakdown";
  const sid = invocation?.sessionID || invocation?.session?.id;
  if (!sid) {
    logErr("context-breakdown: invocation carried no sessionID");
    return;
  }
  try {
    // state.json is read immediately and synchronously; the root and every
    // descendant are then collected IN PARALLEL under one cumulative budget, so
    // the command costs ~budget regardless of the subagent count (not N × 3s).
    const state = readStateSnapshot();
    const childIDs = collectDescendantSessionIDs(sid, state);
    const deadline = Date.now() + COMMAND_COLLECT_BUDGET_MS;
    const [root, ...children] = await Promise.all([
      collectSessionReport(ctx, sid, state, deadline),
      ...childIDs.map((cid) => collectSessionReport(ctx, cid, state, deadline)),
    ]);
    const rows = [renderSessionRow(root, true)];
    for (const rep of children) rows.push(renderSessionRow(rep, false));
    const table = renderBreakdownTable(rows, childIDs.length);
    const payload = resume ? `${BREAKDOWN_MODEL_INSTRUCTION}\n\n${table}` : table;
    const description = `Full context breakdown — ${1 + childIDs.length} session(s)`;

    const delivered = await deliverSynthetic(ctx, sid, payload, description, resume);

    // Persist the table itself (not the instruction) to the human-readable log
    // (survives rewrites, bounded) so it is always recoverable.
    pushFinalSummary(`cmd:${sid}:${Date.now()}`, [
      `[${new Date().toISOString()}] COMMAND ${name} session=${sid} delivered=${delivered}`,
      ...table.split("\n"),
    ]);
  } catch (err) {
    logErr("context-breakdown command failed", err);
  }
}

// ---------------------------------------------------------------------------
// Named exports for the prepublish unit harness (test/prepublish.mjs).
// These are module-level const variables that the harness needs to mutate
// (modelLimits, sessionAgentCache, etc.) and functions it needs to call
// directly (hydrateModelLimitsFromState, writeStateFile, etc.).
// The plugin itself works without any of these — they are additive.
// ---------------------------------------------------------------------------
export {
  modelLimits,
  sessionAgentCache,
  sessionParentCache,
  writeStateFile,
  hydrateModelLimitsFromState,
  getUsableContext,
  getModelLimit,
  collectSessionReport,
  renderSessionRow,
  shortSummaryText,
  shortSummaryDescription,
  ensureModelLimits,
  readStateSnapshot,
};

// ---------------------------------------------------------------------------
// Entrypoints
// ---------------------------------------------------------------------------

export default {
  // V2 definition (equivalent to Plugin.define({ id, setup }) — `define` is
  // an identity helper, so it is inlined to avoid a package dependency).
  id: "context-indicator",
  async setup(ctx) {
    const registrations = [];
    try {
      registrations.push(
        await ctx.session.hook("context", (context) => onV2Context(context)),
      );
    } catch (err) {
      logErr("v2 context hook registration failed", err);
    }

    // The model registry is captured asynchronously through ensureModelLimits
    // (ctx.model.list(), rank 3) — the authoritative source that carries the
    // user's merged config overrides. ctx.model.transform fires synchronously
    // on every catalog rebuild BEFORE ctx.model.list completes and carries the
    // generic Model.Info defaults (context:200000, output:32000) for provider-
    // declared models before overrides are applied; writing it to modelLimits
    // would flip the denominator from the configured window to the generic
    // default on every catalog rebuild (observed: a configured window flipping
    // to the generic 200k default), so the transform is not used for limit
    // population.

    // Seed limits from the shared snapshot FIRST: another instance may already
    // have resolved them, so a cold start never shows "?" denominators.
    hydrateModelLimitsFromState();

    // Fire-and-forget prefetch of effective model limits.
    ensureModelLimits(ctx).catch((err) =>
      logErr("model limits prefetch failed", err),
    );

    // Two V2 slash commands (V2 only): /context (instant per-session summary)
    // and /context-breakdown (full table, main + all subagent descendants).
    // Guarded: older 2.0.x builds may lack ctx.command / ctx.session.synthetic —
    // registering a command whose handler cannot deliver would fail silently.
    try {
      const canCommand =
        ctx.command && typeof ctx.command.transform === "function";
      const canSynthetic =
        !!ctx.session && typeof ctx.session.synthetic === "function";
      if (canCommand && canSynthetic) {
        registrations.push(
          await ctx.command.transform((editor) => {
            try {
              editor.add({
                name: "context",
                description:
                  "Quick context summary for the current session (compact notice)",
                execute: (invocation) =>
                  commandContextSummary(ctx, invocation, { name: "context" }),
              });
              editor.add({
                name: "context-breakdown",
                description:
                  "Full per-session context breakdown table (main + subagents), rendered by the model",
                execute: (invocation) =>
                  commandContextBreakdown(ctx, invocation, {
                    resume: CONTEXT_BREAKDOWN_RESUME,
                    name: "context-breakdown",
                  }),
              });
            } catch (err) {
              logErr("v2 command transform failed", err);
            }
          }),
        );
      } else {
        logErr(
          `context commands not registered (command=${canCommand}, synthetic=${canSynthetic})`,
        );
      }
    } catch (err) {
      logErr("v2 command transform registration failed", err);
    }

    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          signal: controller.signal,
        })) {
          try {
            await handleV2Event(ctx, event);
          } catch (err) {
            logErr("v2 event handler failed", err);
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          logErr("v2 event stream failed", err);
        }
      }
    })();

    return () => {
      controller.abort();
      for (const r of registrations) {
        try {
          r?.dispose?.();
        } catch {
          /* ignore */
        }
      }
    };
  },

  // V1 entrypoint retained for OpenCode >= 1.18.29.
  async server({ client }) {
    return makeV1(client);
  },
};
