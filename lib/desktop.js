// lib/desktop.js
//
// Server side of the Desktop GUI panel: registers the RPC contract from
// lib/rpc.js and answers it from the SAME collection the /context-breakdown
// command uses (lib/commands.js collectFamilyReports). The GUI is a window in
// the desktop app and cannot read state.json or the plugin's memory, so this is
// its only data path.
//
// Nothing here runs on hosts without the GUI API: the registration is guarded
// and a failure is logged, never thrown, so the TUI and the slash commands are
// unaffected. For the same reason lib/rpc.js - which imports
// `@opencode/plugin/rpc`, an OPTIONAL peer - is loaded lazily inside the guard:
// a host that does not provide that module must still load index.js, not fail
// at import time.

import { collectFamilyReports } from "./commands.js";
import { num } from "./format.js";
import { logErr } from "./state.js";

// A GUI panel polls this while it is open, so the budget is much smaller than
// the command's: the collection is state.json + in-memory caches only (the live
// lookups are skipped once the state entry carries the agent/model), and a poll
// must never hold a hook longer than a fraction of a second.
const DESKTOP_COLLECT_BUDGET_MS = 2000;

// One wire row (see lib/rpc.d.ts). JSON has no undefined/null in this contract:
// every optional value is flattened to "" or 0, which the GUI treats as
// "unknown". `report` is the sanitized object from collectSessionReport.
function toDesktopRow(report) {
  const c = report?.categories || {};
  return {
    sessionID: typeof report?.sessionID === "string" ? report.sessionID : "",
    parentID: typeof report?.parentID === "string" ? report.parentID : "",
    agent: typeof report?.agent === "string" ? report.agent : "",
    modelID: typeof report?.modelID === "string" ? report.modelID : "",
    providerID: typeof report?.providerID === "string" ? report.providerID : "",
    ctx: num(report?.ctxTokens),
    input: num(report?.inputTokens),
    usable: num(report?.usable),
    reserve: num(report?.reserve),
    user: num(c.user),
    assistant: num(c.assistant),
    reasoning: num(c.reasoning),
    toolArgs: num(c.toolArgs),
    toolOut: num(c.toolOut),
    system: num(c.system),
    toolSchemas: num(c.toolSchemas),
    other: num(c.other),
    source: typeof report?.source === "string" ? report.source : "",
    updatedAt: typeof report?.updatedAt === "string" ? report.updatedAt : "",
    stale: report?.compactStale === true,
  };
}

// A row is worth showing only when the session has been measured at least once:
// no tokens, no window and no timestamp means "never seen by this plugin" (a
// foreign or already-pruned session), and a full row of zeros would read as a
// real, empty context. The GUI turns an empty list into its empty state.
function hasMeasurement(row) {
  return row.ctx > 0 || row.usable > 0 || row.updatedAt !== "";
}

// Registers the contract on a V2 plugin context. Returns the registration (so
// the caller can keep it alive / dispose it) or null when this host has no RPC
// support (opencode 2.0.x), does not provide `@opencode/plugin/rpc`, or the
// registration failed.
async function registerDesktopRpc(ctx) {
  try {
    if (!ctx?.rpc || typeof ctx.rpc.register !== "function") return null;
    const { DesktopContextRpc } = await import("./rpc.js");
    return await ctx.rpc.register(DesktopContextRpc, {
      family: async (input) => {
        const sessionID =
          input && typeof input.sessionID === "string" ? input.sessionID : "";
        if (!sessionID) return { rows: [] };
        const { root, children } = await collectFamilyReports(
          ctx,
          sessionID,
          DESKTOP_COLLECT_BUDGET_MS,
        );
        const rootRow = toDesktopRow(root);
        if (!hasMeasurement(rootRow)) return { rows: [] };
        return {
          rows: [
            rootRow,
            ...children.map(toDesktopRow).filter(hasMeasurement),
          ],
        };
      },
    });
  } catch (err) {
    logErr("desktop RPC registration failed", err);
    return null;
  }
}

export {
  registerDesktopRpc,
  toDesktopRow,
  hasMeasurement,
  DESKTOP_COLLECT_BUDGET_MS,
};
