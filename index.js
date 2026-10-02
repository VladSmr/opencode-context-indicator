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
 *       RPC (cache + state.json only), so it is instant. Delivered with
 *       resume:true (like /context-breakdown), so the model echoes the summary
 *       into the transcript; the chip label (`description`) is self-contained:
 *       "Context: 41.5k (25%) · your-model · 12:36".
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

import { makeV1 } from "./lib/v1.js";
import { handleV2Event, onV2Context } from "./lib/v2.js";
import {
  commandContextBreakdown,
  commandContextSummary,
  CONTEXT_BREAKDOWN_RESUME,
  collectSessionReport,
  renderSessionRow,
  shortSummaryText,
  shortSummaryDescription,
} from "./lib/commands.js";
import {
  ensureModelLimits,
  getModelLimit,
  getUsableContext,
  hydrateModelLimitsFromState,
  modelLimits,
} from "./lib/limits.js";
import { sessionAgentCache, sessionParentCache } from "./lib/cache.js";
import {
  logErr,
  readStateSnapshot,
  writeStateFile,
} from "./lib/state.js";

// ---------------------------------------------------------------------------
// Named exports for the prepublish unit harness (test/prepublish.mjs).
// These are module-level const variables that the harness needs to mutate
// (modelLimits, sessionAgentCache, etc.) and functions it needs to call
// directly (hydrateModelLimitsFromState, writeStateFile, etc.).
// The plugin itself works without any of these — they are additive.
// Every name is re-exported from the extracted lib/* modules.
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
