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

// A finite, non-negative, SANE number or null — for persisted provider-reported
// figures (cache read/write). Like safeCountOrNull but also rejects absurd
// magnitudes, so a poisoned state.json cannot render garbage (fmt(NaN), 1e15).
function safeSaneOrNull(v) {
  return typeof v === "number" &&
    Number.isFinite(v) &&
    v >= 0 &&
    v <= MAX_SANE_LIMIT
    ? v
    : null;
}

// Normalise a categories object from untrusted input (state.json) into the 8
// known numeric fields — never trust its shape. `toolOut` is 0 for legacy
// entries written before the category existed (their tool results stay folded
// into `other`, matching how they were measured).
function safeCategories(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    user: safeCount(raw.user),
    assistant: safeCount(raw.assistant),
    reasoning: safeCount(raw.reasoning),
    toolArgs: safeCount(raw.toolArgs),
    toolOut: safeCount(raw.toolOut),
    system: safeCountOrNull(raw.system),
    toolSchemas: safeCountOrNull(raw.toolSchemas),
    other: safeCount(raw.other),
  };
}

// Sum of the 8 canonical category fields (null `system`/`toolSchemas` count as
// 0). The single place the "total measured tokens" is derived — shared by the
// residual-`other` computation, the continuity test and the log/summary writers.
function sumCategories(c) {
  if (!c || typeof c !== "object") return 0;
  return (
    safeCount(c.user) +
    safeCount(c.assistant) +
    safeCount(c.reasoning) +
    safeCount(c.toolArgs) +
    safeCount(c.toolOut) +
    safeCount(c.system) +
    safeCount(c.toolSchemas) +
    safeCount(c.other)
  );
}

// Normalise a breakdown record (cache record with *Chars keys, or a persisted
// state entry with canonical keys) into the 8 categories, deriving the residual
// `other` from `inputTokens`. Pure; the one converter shared by the V2 live log
// (lib/v2.js) and the slash-command report (lib/commands.js).
function breakdownCategories(rec, inputTokens) {
  const user = rec?.userChars ?? rec?.user ?? 0;
  const assistant = rec?.assistantChars ?? rec?.assistant ?? 0;
  const reasoning = rec?.reasoningChars ?? rec?.reasoning ?? 0;
  const toolArgs = rec?.toolArgsChars ?? rec?.toolArgs ?? 0;
  const toolOut = rec?.toolOutChars ?? rec?.toolOut ?? 0;
  const system =
    rec?.systemChars !== undefined ? rec.systemChars : (rec?.system ?? null);
  const toolSchemas =
    rec?.toolSchemasChars !== undefined
      ? rec.toolSchemasChars
      : (rec?.toolSchemas ?? null);
  const sum =
    user +
    assistant +
    reasoning +
    toolArgs +
    toolOut +
    (system || 0) +
    (toolSchemas || 0);
  const other = Math.max(0, (inputTokens || 0) - sum);
  return { user, assistant, reasoning, toolArgs, toolOut, system, toolSchemas, other };
}

// True when a persisted state.json entry carries a categories object measured by
// a request/transform payload that saw the assembled prompt: the V2 context and
// compaction hooks ("context-hook" / "compaction-hook") and the V1 transform
// hooks ("transform" / "system-transform"). Those see the system prompt and the
// tool schemas. `source` is persisted by lib/state.js since 1.7.1; legacy
// entries have none, and for them only a non-null system / tool-schema estimate
// proves a hook ran (the message-based fallback cannot produce one). Shared by
// the state writer, the command report and the live log so the priority rule
// exists once.
const HOOK_SOURCES = new Set([
  "context-hook",
  "compaction-hook",
  "transform",
  "system-transform",
]);

function isHookSource(source) {
  return typeof source === "string" && HOOK_SOURCES.has(source);
}

function isHookMeasuredEntry(entry) {
  if (!entry || typeof entry !== "object" || !entry.categories) return false;
  if (isHookSource(entry.source)) return true;
  return (
    entry.source == null &&
    (entry.categories.system != null || entry.categories.toolSchemas != null)
  );
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

// Bound on the number of distinct tool names kept in a per-tool tool-result
// map (state.json / context payload are untrusted and a plugin could define an
// unbounded tool set). Everything past the cap — plus any unsafe name — is
// folded into a single "other tools" bucket so the total still reconciles with
// the toolOut category.
const TOOL_OUT_MAX_KEYS = 24;
// Normalise a per-tool tool-result map (tool name -> estimated tokens) from
// untrusted input. Names become object keys AND display cells, so prototype
// vectors are dropped and the map is bounded (see TOOL_OUT_MAX_KEYS). The
// overflow bucket is named "other tools" — a real tool with that exact name
// would merge into it (accepted: it is a display-only label).
function safeToolOutByTool(raw, maxKeys = TOOL_OUT_MAX_KEYS) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  let rest = 0;
  let used = 0;
  for (const [k, v] of Object.entries(raw)) {
    const val = safeCount(v);
    if (!isSafeSessionKey(k) || used >= maxKeys) {
      rest += val;
      continue;
    }
    out[k] = (out[k] || 0) + val;
    used++;
  }
  if (rest > 0) out["other tools"] = (out["other tools"] || 0) + rest;
  return Object.keys(out).length > 0 ? out : null;
}

// Descending [name, tokens] pairs for display, capped at `limit`; empty when
// the map carries no positive rows.
function toolOutEntries(map, limit = 8) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return [];
  return Object.entries(map)
    .map(([k, v]) => [k, safeCount(v)])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// Top context consumers + previous-measurement snapshot
// ---------------------------------------------------------------------------
// The heaviest single items still present in the assembled request (one tool
// result, one assistant message, the system prompt, …). Kept as a short list so
// it can be persisted in state.json and rendered in /context-breakdown.
const TOP_CONSUMERS = 5;
const TOP_KINDS = new Set([
  "tool",
  "args",
  "reasoning",
  "assistant",
  "user",
  "system",
]);

// Normalise an untrusted top-consumers list (live estimate OR persisted state).
// `keepTarget=false` drops the per-item target so a persisted / exported payload
// stays free of file paths and URLs (same policy as safeReclaim).
function safeTop(raw, keepTarget = true, maxItems = TOP_CONSUMERS) {
  const src = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const it of src) {
    if (!it || typeof it !== "object") continue;
    const tokens = safeCount(it.tokens);
    if (tokens <= 0) continue;
    const item = {
      kind: TOP_KINDS.has(it.kind) ? it.kind : "other",
      tokens,
    };
    if (
      typeof it.name === "string" &&
      isSafeSessionKey(it.name) &&
      it.name.length <= 64
    ) {
      item.name = it.name;
    }
    if (keepTarget && typeof it.target === "string" && it.target.length > 0) {
      item.target = it.target.slice(0, 200);
    }
    out.push(item);
    if (out.length >= 256) break; // bound untrusted input
  }
  out.sort((a, b) => b.tokens - a.tokens);
  return out.length > 0 ? out.slice(0, Math.max(0, maxItems)) : null;
}

// One measurement snapshot: what /context-diff compares against. Sanitises the
// persisted `previous` object (untrusted state.json input).
function safeSnapshot(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const categories = safeCategories(raw.categories);
  const ctx = safeCount(raw.ctx);
  const input = safeCount(raw.input);
  if (categories == null && ctx === 0 && input === 0) return null;
  return {
    model:
      typeof raw.model === "string" && raw.model.length > 0
        ? raw.model.slice(0, 64)
        : "unknown",
    ctx,
    input,
    categories,
    updatedAt:
      typeof raw.updatedAt === "string" ? raw.updatedAt.slice(0, 40) : null,
  };
}

// True when two measurement snapshots describe the SAME observation (the
// categories object is built in a fixed key order, so JSON is stable).
function sameSnapshot(a, b) {
  if (!a || !b) return false;
  return (
    a.model === b.model &&
    a.ctx === b.ctx &&
    a.input === b.input &&
    JSON.stringify(a.categories) === JSON.stringify(b.categories)
  );
}

// ---------------------------------------------------------------------------
// Waste detection: find redundant tool output already sitting in the context.
// Pure transforms — the caller supplies per-call instances captured from the
// request payload; nothing here touches the fs or the caches.
// ---------------------------------------------------------------------------

// Best-effort TARGET of a tool call, from the per-call input. A short, stable
// string used only to group repeated calls (the same file read twice) and to
// label a finding. Returns null when no suitable string field exists. The value
// is untrusted (tool args); it is whitespace-collapsed and bounded here, and
// display layers sanitise it further.
const TARGET_FIELD_MAP = {
  webfetch: ["url", "uri"],
  fetch: ["url", "uri"],
  bash: ["command", "cmd"],
  shell: ["command", "cmd"],
  grep: ["pattern", "query", "regex", "path"],
  search: ["query", "pattern"],
  glob: ["pattern", "path"],
  read: ["filePath", "file", "path", "filename"],
  read_file: ["filePath", "file", "path", "filename"],
  write: ["filePath", "file", "path", "filename"],
  edit: ["filePath", "file", "path", "filename"],
  list: ["path", "dir"],
  ls: ["path", "dir"],
  task: ["description", "prompt"],
  agent: ["description", "prompt"],
};
function extractToolTarget(name, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const n = typeof name === "string" ? name.toLowerCase() : "";
  const fields = TARGET_FIELD_MAP[n];
  const pick = (keys) => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === "string" && v.length > 0) return v;
    }
    return null;
  };
  let t = fields ? pick(fields) : null;
  if (t == null) {
    // Generic fallback: the first non-empty string-valued field. Bounded scan
    // (the input object is untrusted) so a crafted huge input cannot stall us.
    let scanned = 0;
    for (const k of Object.keys(input)) {
      if (++scanned > 32) break;
      const v = input[k];
      if (typeof v === "string" && v.length > 0) {
        t = v;
        break;
      }
    }
  }
  if (typeof t !== "string" || t.length === 0) return null;
  // Slice BEFORE the whitespace pass: normalising an untrusted multi-MB string
  // is the expensive part, so cap the work first.
  return t.slice(0, 400).replace(/\s+/g, " ").trim().slice(0, 200);
}

// Cheap content fingerprint of a tool RESULT (length + FNV-1a over the first
// 4KB). Used to detect byte-identical outputs already in context. Not
// cryptographic — deliberately cheap (runs on every model request).
function contentFingerprint(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  const s = text.length > 4096 ? text.slice(0, 4096) : text;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${text.length}:${(h >>> 0).toString(36)}`;
}

// Group per-call instances and estimate the tool-output tokens that are
// redundant (the same target invoked repeatedly, or byte-identical outputs).
// `instances`: [{ name, target, tokens, fp }]. Reclaim = the sum of the
// NON-largest member of every group of size >= 2, unioned across target- and
// content-groups so an instance is counted once. This is a LOWER bound of what
// compaction/trim could reclaim — labelled as an estimate everywhere.
function computeReclaim(instances, maxFindings = 8) {
  const list = Array.isArray(instances) ? instances : [];
  const byTarget = new Map();
  const byContent = new Map();
  const push = (map, key, idx) => {
    const a = map.get(key);
    if (a) a.push(idx);
    else map.set(key, [idx]);
  };
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (safeCount(it?.tokens) <= 0) continue;
    const name = typeof it?.name === "string" && it.name ? it.name : "?";
    const target =
      typeof it?.target === "string" && it.target ? it.target : null;
    if (target) push(byTarget, `${name}\u0000${target}`, i);
    const fp = typeof it?.fp === "string" && it.fp ? it.fp : "";
    if (fp) push(byContent, fp, i);
  }
  // Resolve each group's keeper (largest member) once.
  const buildGroups = (map) => {
    const out = [];
    for (const idxs of map.values()) {
      if (idxs.length < 2) continue;
      let maxI = idxs[0];
      for (const i of idxs) {
        if (safeCount(list[i]?.tokens) > safeCount(list[maxI]?.tokens)) maxI = i;
      }
      let groupTokens = 0;
      for (const i of idxs) {
        if (i !== maxI) groupTokens += safeCount(list[i]?.tokens);
      }
      out.push({ idxs, maxI, groupTokens });
    }
    out.sort((a, b) => b.groupTokens - a.groupTokens);
    return out;
  };
  const targetGroups = buildGroups(byTarget);
  const contentGroups = buildGroups(byContent);

  // The authoritative total: every instance that is NOT the largest member of
  // at least one duplicate group, counted ONCE (union across group kinds).
  const removable = new Set();
  for (const g of targetGroups) {
    for (const i of g.idxs) if (i !== g.maxI) removable.add(i);
  }
  for (const g of contentGroups) {
    for (const i of g.idxs) if (i !== g.maxI) removable.add(i);
  }
  let tokens = 0;
  for (const i of removable) tokens += safeCount(list[i]?.tokens);

  // Findings: target groups first (they carry the target label), then content
  // groups only for instances not already covered — so the rendered findings
  // never sum to more than the headline total.
  const findings = [];
  const covered = new Set();
  for (const g of targetGroups) {
    const rep = list[g.maxI] || {};
    findings.push({
      kind: "target",
      name: typeof rep.name === "string" ? rep.name : "?",
      target: typeof rep.target === "string" ? rep.target : null,
      n: g.idxs.length,
      tokens: g.groupTokens,
    });
    for (const i of g.idxs) covered.add(i);
  }
  for (const g of contentGroups) {
    let t = 0;
    for (const i of g.idxs) {
      if (i === g.maxI || covered.has(i)) continue;
      t += safeCount(list[i]?.tokens);
    }
    if (t > 0) {
      const rep = list[g.maxI] || {};
      findings.push({
        kind: "content",
        name: typeof rep.name === "string" ? rep.name : "?",
        target: null,
        n: g.idxs.length,
        tokens: t,
      });
    }
  }
  findings.sort((a, b) => b.tokens - a.tokens);
  return {
    tokens,
    count: removable.size,
    findings: findings.slice(0, Math.max(0, maxFindings)),
  };
}

// Sanitise a reclaim summary from a live estimate OR persisted state.json
// (untrusted). `keepTarget=false` drops the per-finding target so a persisted /
// exported payload stays free of file paths and URLs. Returns null when there
// is nothing worth showing.
function safeReclaim(raw, keepTarget = true, maxFindings = 8) {
  if (!raw || typeof raw !== "object") return null;
  const tokens = safeCount(raw.tokens);
  const count = safeCount(raw.count);
  if (tokens <= 0 || count <= 0) return null;
  const findings = [];
  const src = Array.isArray(raw.findings) ? raw.findings : [];
  for (const f of src) {
    if (!f || typeof f !== "object") continue;
    const name = isSafeSessionKey(f.name) && f.name.length <= 64 ? f.name : "?";
    const ft = safeCount(f.tokens);
    const fn = safeCount(f.n);
    if (ft <= 0 || fn < 2) continue;
    const item = {
      kind: f.kind === "content" ? "content" : "target",
      name,
      n: fn,
      tokens: ft,
    };
    if (keepTarget && typeof f.target === "string" && f.target.length > 0) {
      item.target = f.target.slice(0, 200);
    }
    findings.push(item);
    if (findings.length >= Math.max(0, maxFindings)) break;
  }
  return { tokens, count, findings };
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
  oneLine,
  safeCell,
  finitePos,
  safeCount,
  safeCountOrNull,
  safeSaneOrNull,
  safeCategories,
  sumCategories,
  breakdownCategories,
  isHookSource,
  isHookMeasuredEntry,
  isSafeSessionKey,
  safeToolOutByTool,
  toolOutEntries,
  TOOL_OUT_MAX_KEYS,
  safeTop,
  safeSnapshot,
  sameSnapshot,
  TOP_CONSUMERS,
  extractToolTarget,
  contentFingerprint,
  computeReclaim,
  safeReclaim,
  fmt,
  estimateTokens,
  estJson,
  tokenCountOf,
  withTimeout,
  fmtCell,
};
