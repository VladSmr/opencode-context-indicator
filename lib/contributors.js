// lib/contributors.js
//
// Pure contributor-measurement helpers extracted from the TUI panel (lib/tui-panel.ts)
// for unit testing.
// All functions are stateless transforms of their arguments.
//
// Functions: asRecord, safeText, measureContributors, contributorLine,
// exportFileName, buildRedactedPayload, panelDenom, panelRole. Token estimation
// is imported from lib/estimate.js (single source of truth).

import { estimateTokens } from "./estimate.js";

// ---------------------------------------------------------------------------
// Token estimation — the SHARED lib/estimate.js heuristic (the TUI panel and
// the server must price the same text identically; the earlier self-contained
// copy had drifted risk). estimate.js is pure and dependency-free, so it loads
// in the TUI host exactly like the rest of lib/.
// ---------------------------------------------------------------------------

// Live message data is untrusted: coerce every field defensively, never throw.
function asRecord(v) {
  return v && typeof v === "object" ? v : null;
}

// One-line sanitisation for untrusted labels (agent / model). Drops zero-width
// + bidi control chars, collapses C0/C1 controls, caps at 32 code points
// (surrogate-safe). Only labels are ever rendered — never message content.
function safeText(v) {
  try {
    const s = v == null ? "" : String(v);
    const cleaned = s
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
      .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ");
    const cps = Array.from(cleaned);
    return cps.length > 32 ? cps.slice(0, 31).join("") + "~" : cleaned;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Contributor measurement
// ---------------------------------------------------------------------------

// Char counts per (message, bucket). `asst.text` = assistant text,
// `asst.rsn` = reasoning, `asst.tool` = tool CALL arguments (streaming raw
// string or JSON.stringify of the input object), `asst.result` = tool RESULT
// outputs (text content of completed/error tool states). Sorted descending by
// estimated tokens.
//
// Returns an array of plain objects (no class/prototype dependency):
//   { kind, ref, chars, tokensEstimate, tool, preview }
function measureContributors(messages) {
  const out = [];
  // Bounded preview: control chars collapse to spaces, bidi/zero-width stripped,
  // capped at 26 code points with a "~" tail. Local rendering only.
  const previewOf = (sample) => {
    const cleaned = sample
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
      .replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/g, " ")
      .trim();
    const cps = Array.from(cleaned);
    return cps.length > 26 ? cps.slice(0, 25).join("") + "~" : cleaned;
  };
  const add = (kind, ref, sample, tool, previewOverride) => {
    if (sample.length === 0) return;
    out.push({
      kind,
      ref,
      chars: sample.length,
      tokensEstimate: estimateTokens(sample),
      tool: tool || "",
      preview: previewOverride !== undefined ? previewOverride : previewOf(sample),
    });
  };
  // Human clock ref: "21:04" from the message's own creation time — far more
  // actionable than an array ordinal. Falls back to "#N" when time is absent.
  const hhmm = (ms) => {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
    try {
      const d = new Date(ms);
      if (Number.isNaN(d.getTime())) return "";
      const pad = (x) => String(x).padStart(2, "0");
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch {
      return "";
    }
  };
  for (let i = 0; i < messages.length; i++) {
    const m = asRecord(messages[i]);
    if (!m) continue;
    const timeRec = asRecord(m.time);
    const ref = hhmm(timeRec && timeRec.created) || `#${i + 1}`;
    const type = typeof m.type === "string" ? m.type : "";
    if (type === "user") {
      if (typeof m.text === "string") add("user.text", ref, m.text);
      continue;
    }
    if (type !== "assistant") continue;
    const content = Array.isArray(m.content) ? m.content : [];
    let text = "";
    let rsn = "";
    for (const rawPart of content) {
      const part = asRecord(rawPart);
      if (!part) continue;
      const pt = typeof part.type === "string" ? part.type : "";
      if (pt === "text") {
        if (typeof part.text === "string") text += part.text;
      } else if (pt === "reasoning") {
        if (typeof part.text === "string") rsn += part.text;
      } else if (pt === "tool") {
        const state = asRecord(part.state);
        if (!state) continue;
        // Per-tool-part contributors: each tool call carries its own name and
        // measured size (one message can hold several tool calls). The raw
        // args JSON is measured but NOT previewed — the tool name is the
        // useful identifier; result text previews fine.
        const toolName =
          typeof part.name === "string" && part.name ? safeText(part.name) : "";
        let toolArgs = "";
        let result = "";
        if (typeof state.input === "string") {
          toolArgs += state.input;
        } else if (state.input != null) {
          try {
            toolArgs += JSON.stringify(state.input) || "";
          } catch {
            /* unstringifiable input: skip its chars */
          }
        }
        const c = state.content;
        if (Array.isArray(c)) {
          for (const rawItem of c) {
            const item = asRecord(rawItem);
            if (item && item.type === "text" && typeof item.text === "string")
              result += item.text;
          }
        }
        add("asst.tool", ref, toolArgs, toolName, ""); // raw args: no preview
        add("asst.result", ref, result, toolName);
      }
    }
    add("asst.text", ref, text);
    add("asst.rsn", ref, rsn);
  }
  return out.sort((a, b) => b.tokensEstimate - a.tokensEstimate);
}

// Human line for one measured contributor: role in full words, the message's
// own clock time, the bucket (with the tool name for tool buckets), the token
// estimate, and a bounded single-line preview. Never contains a full session id
// or file paths.
function contributorLine(c, rank) {
  const dot = c.kind.indexOf(".");
  const who = dot >= 0 ? c.kind.slice(0, dot) : c.kind;
  const bucket = dot >= 0 ? c.kind.slice(dot + 1) : "";
  const role = who === "asst" ? "assistant" : who;
  const what =
    bucket === "rsn"
      ? "reasoning"
      : bucket === "tool"
        ? "tool args"
        : bucket === "result"
          ? "tool result"
          : "";
  const tool = c.tool ? ` (${c.tool})` : "";
  const whatFull = what ? `${what}${tool}` : "";
  const head = `${rank}. ${role} ${c.ref}${whatFull ? ` ${whatFull}` : ""} \u2014 ${c.tokensEstimate}`;
  return c.preview ? `${head}  "${c.preview}"` : head;
}

// ---------------------------------------------------------------------------
// Redacted export helpers (pure)
// ---------------------------------------------------------------------------

// Filename for a redacted export snapshot:
// context-<id8>-<yyyymmdd-HHMMSSmmm>.json
function exportFileName(sessionID, now) {
  const id8 = String(sessionID).slice(0, 8);
  const pad = (n) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}` +
    `${pad(now.getSeconds())}${String(now.getMilliseconds()).padStart(3, "0")}`;
  return `context-${id8}-${stamp}.json`;
}

// Build the redacted export payload. All IO (mkdirSync/writeFileSync) and
// toasts stay in lib/tui-panel.ts as the thin exportRedacted() wrapper.
//
// Fields: generatedAt, session{id8-prefixed id, model, providerID},
// family[role/model/ctx/usable/limit/pct/updated], contributors[kind/tool/ref/
// chars/tokensEstimate].  NO message text, NO full session id, NO tool output
// content, NO contributor preview text.
//
// panelDenom / panelRole are passed as parameters so this file stays pure and
// lib/tui-panel.ts controls their source.
function buildRedactedPayload({ sessionID, root, rows, contributors, now, panelDenom, panelRole, num }) {
  const id8 = String(sessionID).slice(0, 8);
  return {
    generatedAt: now.toISOString(),
    session: {
      id: `${id8}...`,
      model: safeText(root && root.model != null ? root.model : ""),
      providerID: safeText(root && root.providerID != null ? root.providerID : ""),
    },
    family: rows.map((e, i) => {
      const d = panelDenom(e);
      const ctxVal = num(e && e.ctx);
      return {
        role: panelRole(e, i === 0),
        model: safeText(e && e.model != null ? e.model : ""),
        ctx: ctxVal,
        usable: e && e.usable != null ? num(e.usable) : null,
        limit: e && e.limit != null ? num(e.limit) : null,
        pct: d > 0 ? Math.round((ctxVal / d) * 100) : null,
        updated: safeText(e && e.updatedAt != null ? e.updatedAt : ""),
      };
    }),
    contributors: contributors.map((c) => ({
      kind: c.kind,
      tool: c.tool || null,
      ref: c.ref,
      chars: c.chars,
      tokensEstimate: c.tokensEstimate,
    })),
  };
}

// ---------------------------------------------------------------------------
// Panel helpers (pure, shared with lib/tui-panel.ts)
// ---------------------------------------------------------------------------

// Per-row denominator with the same fallback cascade as the server table:
// usable, else limit, else 0.
function panelDenom(e) {
  const u = e && typeof e.usable === "number" && e.usable > 0 ? e.usable : 0;
  if (u > 0) return u;
  const l = e && typeof e.limit === "number" && e.limit > 0 ? e.limit : 0;
  return l;
}

// Role label for a state entry: "main" for root, "sub" or "sub:<agent>" for
// descendants.
function panelRole(e, isMain) {
  if (isMain) return "main";
  return e && e.agent ? `sub:${safeText(e.agent)}` : "sub";
}

export {
  safeText,
  measureContributors,
  contributorLine,
  exportFileName,
  buildRedactedPayload,
  panelDenom,
  panelRole,
};