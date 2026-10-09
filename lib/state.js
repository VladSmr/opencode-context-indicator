// lib/state.js
//
// Filesystem layer for the context-indicator plugin: the log / state / event /
// dedup paths, the best-effort state lock, the atomic temp+rename writers, the
// TUI state bridge (writeStateFile), the state.json reader, and the claimed
// final-summary log. It reads the in-memory caches from ./cache.js and the model
// limits from ./limits.js (a call-time-only import cycle). Extracted 1:1 (code
// + WHY comments) from index.js.

import {
  appendFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimOnce } from "./dedup.js";
import {
  finitePos,
  isSafeSessionKey,
  oneLine,
  safeCount,
  safeCountOrNull,
} from "./estimate.js";
import {
  breakdownCache,
  MAX_TRACKED_SESSIONS,
  sessionAgentCache,
  sessionParentCache,
} from "./cache.js";
import { getModelLimit, getUsableContext } from "./limits.js";

const MAX_FINAL_SUMMARIES = 50; // bound the in-memory final-summary log

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

// ---------------------------------------------------------------------------
// State-file locking (best-effort) + atomic rename.
// ---------------------------------------------------------------------------
// The state file is a SHARED read-merge-write target: Desktop, the TUI sidebar
// and every loaded plugin instance may write it concurrently. A temp+rename is
// atomic, but it does NOT prevent lost updates between the read and the write.
// A short-lived exclusive lock file (`<STATE_FILE>.lock`) serialises the
// read-merge-write critical section. This is best-effort by design: if the lock
// cannot be taken, the write is SKIPPED (the caller keeps its value in memory and
// it lands on the next cycle) rather than risking a torn merge.
//
// Lock ownership: each acquisition writes a random token INTO the lock file and
// only releases while the file still holds that token, so a late release can
// never unlink a lock another instance has since taken. Reclaim of an abandoned
// lock uses an atomic rename, not unlink, so two waiters racing on a stale lock
// cannot delete each other's freshly re-created lock.
//
// Retry budget is deliberately small: this blocks the event loop synchronously
// (Atomics.wait), contention is rare, and 6 x 20 ms caps the worst-case stall at
// ~120 ms — a reasonable trade-off between surviving a transient holder and not
// freezing a plugin tick.
const STATE_LOCK_FILE = `${STATE_FILE}.lock`;
const LOCK_MAX_ATTEMPTS = 6;
const LOCK_RETRY_MS = 20;
const LOCK_STALE_MS = 5000; // a lock older than this is presumed abandoned

// Bounded list of final summaries written on session.idle
const finalSummaries = [];

// ---------------------------------------------------------------------------
// Logging helpers (all fault-tolerant; never throw into the caller).
// ---------------------------------------------------------------------------

function logErr(msg, err) {
  try {
    // Bound/sanitise the message (untrusted values are interpolated into it);
    // keep structured objects untouched so their diagnostics survive.
    const detail =
      err === undefined || err === null
        ? ""
        : err instanceof Error
          ? oneLine(err.message)
          : typeof err === "string"
            ? oneLine(err)
            : err;
    console.error(`[context-indicator] ${oneLine(msg)}:`, detail);
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
    // Random temp suffix + exclusive create ("wx"): a predictable name could be
    // pre-created as a symlink for us to follow (CWE-377). "wx" fails instead.
    const tmp = `${LOG_FILE}.${randomBytes(6).toString("hex")}.tmp`;
    // Create BEFORE the finally-guarded section (mirrors writeStateFile): on an
    // (astronomically unlikely) EEXIST collision with a peer's temp, THEIR file
    // must not be cleaned up by us — the write fails and is logged instead.
    writeFileSync(tmp, content, { encoding: "utf8", flag: "wx" });
    try {
      renameWithRetry(tmp, LOG_FILE);
    } finally {
      // Same hygiene as writeStateFile: a failed rename must not litter %TEMP%
      // with stale `<hex>.tmp` files.
      try {
        if (existsSync(tmp)) unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    logErr("writeLog failed", err);
  }
}

// Append a single line to the file (used for final summaries / notes).
function appendLogLine(line) {
  try {
    ensureRegularFile(LOG_FILE); // refuse to follow a symlink planted at the path
    appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch (err) {
    logErr("appendLogLine failed", err);
  }
}

// Synchronous sleep for the lock retry loop. Atomics.wait is the documented
// non-busy way to block this thread; fall back to a bounded spin if unavailable.
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* bounded spin fallback */
    }
  }
}

// Best-effort: if `path` exists but is NOT a regular file (symlink / FIFO /
// device), remove it so the following create writes a real file instead of
// following the link (CWE-377 / symlink redirection). Never throws.
//
// Residual TOCTOU (lstat here vs. the caller's append/create): accepted. This is
// a defence-in-depth guard, not a sandbox — a local attacker able to write into
// %TEMP% already holds broader powers (they can swap any path this process
// touches). Closing the race would need O_NOFOLLOW-style semantics that the
// callers' appendFileSync/writeFileSync API cannot express, for no real gain.
function ensureRegularFile(path) {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) unlinkSync(path);
  } catch {
    /* missing -> the following create makes a fresh regular file */
  }
}

// True when the lock file exists and looks abandoned (older than LOCK_STALE_MS).
// Callers wrap it in try/catch: ENOENT (lock vanished) lands there and retries.
function isStaleLock() {
  return Date.now() - statSync(STATE_LOCK_FILE).mtimeMs > LOCK_STALE_MS;
}

// Returns `{ ok: true, token }` when the lock was taken (caller MUST release with
// that token), `{ ok: false, token: null }` when it is busy (skip the write), or
// `null` on an unexpected error — fail-open: the caller writes WITHOUT the lock
// and must NOT release (nothing was acquired).
function acquireStateLock() {
  const token = randomBytes(8).toString("hex"); // 16 hex chars, per acquisition
  for (let i = 0; i < LOCK_MAX_ATTEMPTS; i++) {
    try {
      // "wx" = exclusive create; fails EEXIST if held, and creates+writes the
      // token in ONE atomic step (no empty-file-then-write gap to race).
      writeFileSync(STATE_LOCK_FILE, token, { flag: "wx" });
      return { ok: true, token };
    } catch (err) {
      if (err && err.code === "EEXIST") {
        // Held by someone. Reclaim it if it looks abandoned (holder crashed);
        // otherwise wait a little and retry.
        try {
          // Stale check TWICE: a peer may reclaim the stale lock and yet another
          // process re-create a fresh one between our first stat and the rename
          // — renaming then steals a FRESH lock (two holders, torn merge). Two
          // consecutive checks narrow the window to the stat->rename gap
          // (microseconds); the lock stays best-effort: the worst case is a
          // stale single-session entry, self-healed on the next write.
          if (isStaleLock() && isStaleLock()) {
            // Atomic reclaim: only ONE waiter can rename the stale file away;
            // the loser gets ENOENT and keeps waiting — neither can unlink a
            // lock a peer just re-created.
            const stale = `${STATE_LOCK_FILE}.stale.${randomBytes(4).toString("hex")}`;
            renameSync(STATE_LOCK_FILE, stale);
            unlinkSync(stale);
            continue; // retry immediately to claim the now-free lock
          }
        } catch {
          /* vanished / already reclaimed by a peer -> just retry */
        }
        sleepSync(LOCK_RETRY_MS);
      } else {
        // Unexpected error (permissions, tmpdir issue): do not block forever —
        // fail-open so the state file still gets written.
        logErr("state lock acquire error (proceeding unlocked)", err);
        return null;
      }
    }
  }
  return { ok: false, token: null }; // busy: could not acquire in the budget
}

// Ownership-safe release: unlink ONLY while the lock still holds OUR token. A
// peer that reclaimed an abandoned lock (or a later acquisition) is left alone.
function releaseStateLock(token) {
  try {
    if (readFileSync(STATE_LOCK_FILE, "utf8") === token) {
      unlinkSync(STATE_LOCK_FILE);
    }
  } catch {
    /* already gone / never created -> nothing to release */
  }
}

// Rename with a couple of retries: on Windows renameSync can throw EPERM/EBUSY
// while a reader (the TUI polls every second) or an AV scanner holds the
// destination open. A short backoff lets the handle close.
function renameWithRetry(from, to, attempts = 3, delayMs = 50) {
  for (let i = 0; i < attempts; i++) {
    try {
      renameSync(from, to);
      return true;
    } catch (err) {
      if (i === attempts - 1) {
        logErr(`rename failed after ${attempts} attempts (${to})`, err);
        return false;
      }
      sleepSync(delayMs);
    }
  }
  return false;
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
// Tombstone window: state.json entries untouched for longer than this are
// pruned during the next write (deleted / abandoned sessions used to linger
// until the LRU cap evicted them). Conservative: consumers are family-scoped,
// so this is file hygiene, not correctness. Entries with an unparsable
// updatedAt are kept.
const PRUNE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

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
    // A poisoned/odd sessionID ("__proto__", "constructor", …) must never be
    // used as an object key: plain assignment through it would mutate the
    // prototype instead of adding an entry (CWE-1321).
    if (!isSafeSessionKey(sessionID)) {
      logErr(`writeStateFile skipped unsafe session key ${oneLine(sessionID)}`);
      return;
    }
    const lock = acquireStateLock();
    // {ok:false} => busy: skip (value stays in memory, lands next cycle), as
    // before. null => unexpected error: fail-open, write WITHOUT the lock and do
    // NOT release (nothing was acquired — releasing could nuke a peer's lock).
    if (lock && !lock.ok) {
      logErr(
        `writeStateFile skipped (state lock busy) session=${oneLine(sessionID)}`,
      );
      return;
    }
    try {
      const bd = breakdownCache.get(sessionID) || null;
      const usableInfo = getUsableContext(providerID, modelID);
      // Persist the EFFECTIVE window (limit.input || limit.context — the same
      // window the ceiling was derived from), not the raw context window: on a
      // cold instance hydrateModelLimitsFromState seeds context = limit, so a
      // mismatched limit would re-derive a WRONG (too large) ceiling for models
      // where limit.input < limit.context.
      const limit =
        usableInfo != null && usableInfo.limit != null
          ? usableInfo.limit
          : getModelLimit(providerID, modelID);
      const denom =
        usableInfo != null
          ? usableInfo.usable
          : limit != null && limit > 0
            ? limit
            : null;
      const reserve = usableInfo != null ? usableInfo.reserved : null;
      const total =
        typeof ctxTokens === "number" && ctxTokens > 0
          ? ctxTokens
          : inputTokens || 0;

      // Read the existing file FIRST: when THIS instance has no fresh breakdown
      // (the context hook did not fire here — e.g. the request was served by
      // another plugin instance whose event stream is mirrored to us), keep the
      // values already persisted instead of clobbering them with nulls/zeros.
      let rawAll = {};
      try {
        rawAll = JSON.parse(readFileSync(STATE_FILE, "utf8"));
      } catch {
        rawAll = {}; // missing / empty / corrupt -> start fresh
      }
      if (!rawAll || typeof rawAll !== "object" || Array.isArray(rawAll)) {
        rawAll = {};
      }
      // Drop prototype-pollution keys from the shared file so a poisoned
      // snapshot is neither consulted via the prototype chain nor re-persisted.
      let all = {};
      for (const [k, v] of Object.entries(rawAll)) {
        if (isSafeSessionKey(k)) all[k] = v;
      }
      // Tombstone prune: entries untouched for PRUNE_AFTER_MS drop out of the
      // shared file (deleted / abandoned sessions used to linger until the LRU
      // cap). Edge case: resuming a 30+-day-stale session prunes its own old
      // entry once, losing the inherited usable/agent/parentID for the first
      // write — it self-heals on the next event. Unparsable updatedAt -> keep.
      {
        const nowMs = Date.now();
        for (const k of Object.keys(all)) {
          const ts = Date.parse(all[k]?.updatedAt);
          if (Number.isFinite(ts) && nowMs - ts > PRUNE_AFTER_MS) delete all[k];
        }
      }
      const prevEntry = Object.prototype.hasOwnProperty.call(all, sessionID)
        ? all[sessionID]
        : null;
      const pc = prevEntry?.categories || null;

      // Same model AND provider? Only then is a previously persisted denominator
      // meaningful — a session that switched model (or provider, even with the
      // same modelID) must not inherit the old window.
      const sameModelAsPrev =
        prevEntry != null &&
        prevEntry.model === (modelID || "unknown") &&
        (prevEntry.providerID || "") === (providerID || "");

      // Coerce every persisted category through the safe numeric helpers: the
      // snapshot is untrusted input and must never inject non-numbers.
      const catUser = bd ? safeCount(bd.userChars) : safeCount(pc?.user);
      const catAssistant = bd
        ? safeCount(bd.assistantChars)
        : safeCount(pc?.assistant);
      const catReasoning = bd
        ? safeCount(bd.reasoningChars)
        : safeCount(pc?.reasoning);
      const catToolArgs = bd
        ? safeCount(bd.toolArgsChars)
        : safeCount(pc?.toolArgs);
      // system / tool schemas are hook-only; a fallback breakdown has them null
      // and must not erase a value the hook already persisted.
      const catSystem =
        bd && bd.systemChars != null
          ? safeCount(bd.systemChars)
          : safeCountOrNull(pc?.system);
      const catToolSchemas =
        bd && bd.toolSchemasChars != null
          ? safeCount(bd.toolSchemasChars)
          : safeCountOrNull(pc?.toolSchemas);

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
          denom != null
            ? denom
            : sameModelAsPrev && finitePos(prevEntry.usable)
              ? prevEntry.usable
              : null,
        reserve:
          reserve != null
            ? reserve
            : sameModelAsPrev && finitePos(prevEntry.reserve)
              ? prevEntry.reserve
              : null,
        limit:
          limit != null
            ? limit
            : sameModelAsPrev && finitePos(prevEntry.limit)
              ? prevEntry.limit
              : null,
        reasoning: safeCount(reasoningTokens),
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
      // Random temp suffix + exclusive create (CWE-377), then atomic rename.
      const tmp = `${STATE_FILE}.${randomBytes(6).toString("hex")}.tmp`;
      writeFileSync(tmp, JSON.stringify(all), { encoding: "utf8", flag: "wx" });
      try {
        ensureRegularFile(STATE_FILE); // never rename over a planted symlink
        renameWithRetry(tmp, STATE_FILE);
      } finally {
        // A rename that exhausted its retries leaves the temp file behind; drop
        // it so repeated failures cannot litter %TEMP% (best-effort: on a
        // SUCCESSFUL rename the temp is already gone, existsSync filters that).
        try {
          if (existsSync(tmp)) unlinkSync(tmp);
        } catch {
          /* best-effort cleanup */
        }
      }
    } finally {
      // Release ONLY a lock we actually own (lock === null => fail-open, skip).
      if (lock && lock.ok) releaseStateLock(lock.token);
    }
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
    // Refuse to follow a symlink planted at the log path before writing to it.
    ensureRegularFile(EVENT_LOG_FILE);
    try {
      const st = statSync(EVENT_LOG_FILE);
      if (st.size > EVENT_LOG_MAX_BYTES) {
        // truncate, keep it bounded (explicit "w": create/replace a regular file)
        writeFileSync(EVENT_LOG_FILE, "", { encoding: "utf8", flag: "w" });
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

// Read the whole state.json snapshot ({ sessionID: entry }) or {} on any error.
// The file is UNTRUSTED (shared across processes / user-writable): rebuild it
// with a plain object, dropping prototype-pollution keys ("__proto__",
// "constructor", "prototype") so no downstream lookup can hit the prototype.
function readStateSnapshot() {
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const out = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (isSafeSessionKey(k)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
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

export {
  logErr,
  renderFile,
  writeLog,
  appendLogLine,
  sleepSync,
  ensureRegularFile,
  isStaleLock,
  acquireStateLock,
  releaseStateLock,
  renameWithRetry,
  writeStateFile,
  appendEventLog,
  debugEvent,
  readStateSnapshot,
  finalSummaries,
  pushFinalSummary,
};
