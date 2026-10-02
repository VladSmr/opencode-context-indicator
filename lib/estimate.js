// lib/estimate.js
//
// Pure, stateless token-estimation and input-sanitisation helpers shared by the
// context-indicator plugin modules. Nothing here touches the filesystem, the
// in-memory caches, or the plugin lifecycle: every function is a pure transform
// of its arguments, which keeps the split modules free of hidden coupling.
// Extracted 1:1 (code + WHY comments) from index.js.

// Token-estimate densities by script (unicode heuristic — estimate, not a
// tokenizer): Latin/ASCII ~4 chars/token, Cyrillic ~2.5, CJK ~1.5.
const CHARS_PER_TOKEN_OTHER = 4;
const CHARS_PER_TOKEN_CYRILLIC = 2.5;
const CHARS_PER_TOKEN_CJK = 1.5;

// Hard upper bound on a plausible model window (tokens). Anything larger is
// junk from a poisoned/legacy state.json and must not become a denominator.
const MAX_SANE_LIMIT = 1e9;

// ---------------------------------------------------------------------------
// Input-sanitisation helpers (all external data — state.json, plugin context,
// event payloads, invocation args — is UNTRUSTED).
// ---------------------------------------------------------------------------

// Collapse CR/LF/TAB to spaces and bound the length. Used for anything that ends
// up in a log line, so a crafted value cannot inject fake log rows (CWE-117).
function oneLine(s) {
  try {
    return String(s).replace(/[\r\n\t]+/g, " ").slice(0, 500);
  } catch {
    return "";
  }
}

// Sanitise a value for a markdown table cell. The table is echoed VERBATIM by
// the model (see BREAKDOWN_MODEL_INSTRUCTION), so a newline or a raw `|` in an
// agent/model name could break the row and smuggle instructions into the model
// turn (prompt injection). Bounded to ~64 chars.
//
// Ordering is security-relevant:
//   1. DELETE zero-width + bidi control chars (U+200B-200F, U+202A-202E,
//      U+2066-2069): invisible carriers that reorder or hide injected text;
//   2. COLLAPSE C0/C1 controls (incl. \r\n\t) and U+2028/U+2029 (line/paragraph
//      separators, which some renderers treat as real line breaks) to a space;
//   3. backtick -> `'` so a cell cannot open/close code formatting;
//   4. TRUNCATE — code-point safe (Array.from never cuts a surrogate pair) and
//      BEFORE escaping: a cut between the halves of an escape pair would leave
//      a trailing `\` that un-escapes the following `|` row separator and
//      re-opens the table to injection;
//   5. escape `\` FIRST, else a crafted `a\|b` becomes `a\\|b` and the pipe is
//      still a live row separator;
//   6. escape `|` -> `\|`.
// Escaping runs after the cap, so the emitted cell can exceed maxLen slightly —
// the cap bounds SOURCE content; every emitted `\` is doubled, so the cell can
// never end in a dangling escape regardless of where the cut fell.
function safeCell(value, maxLen = 64) {
  let s = value == null ? "" : String(value);
  s = s
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ")
    .replace(/`/g, "'");
  const cps = Array.from(s);
  if (cps.length > maxLen) s = `${cps.slice(0, maxLen - 1).join("")}…`;
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

// A finite, strictly-positive, sane number (rejects NaN/Infinity/1e15 garbage).
function finitePos(v) {
  return (
    typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_SANE_LIMIT
  );
}

// A finite, non-negative token count; anything else -> 0.
function safeCount(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

// A finite, non-negative token count that may legitimately be null (the
// hook-only `system` / `toolSchemas` cells).
function safeCountOrNull(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

// Normalise a categories object from untrusted input (state.json) into the 7
// known numeric fields — never trust its shape.
function safeCategories(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    user: safeCount(raw.user),
    assistant: safeCount(raw.assistant),
    reasoning: safeCount(raw.reasoning),
    toolArgs: safeCount(raw.toolArgs),
    system: safeCountOrNull(raw.system),
    toolSchemas: safeCountOrNull(raw.toolSchemas),
    other: safeCount(raw.other),
  };
}

// A session key safe to use as an object property / map key. Rejects the
// prototype-pollution vectors ("__proto__", "constructor", "prototype").
function isSafeSessionKey(k) {
  return (
    typeof k === "string" &&
    k.length > 0 &&
    k !== "__proto__" &&
    k !== "constructor" &&
    k !== "prototype"
  );
}

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

function fmtCell(n) {
  return n == null ? "n/a" : fmt(n);
}

export {
  CHARS_PER_TOKEN_OTHER,
  CHARS_PER_TOKEN_CYRILLIC,
  CHARS_PER_TOKEN_CJK,
  MAX_SANE_LIMIT,
  oneLine,
  safeCell,
  finitePos,
  safeCount,
  safeCountOrNull,
  safeCategories,
  isSafeSessionKey,
  fmt,
  estimateTokens,
  estJson,
  tokenCountOf,
  withTimeout,
  fmtCell,
};
