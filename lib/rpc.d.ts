// lib/rpc.d.ts
//
// Type surface of the Desktop RPC contract (lib/rpc.js). The GUI part is
// TypeScript, the server part is JS, so the row type lives here once and the
// GUI imports it: `DesktopRow` must stay in sync with ROW_PROPERTIES, which the
// T30 gate check enforces at runtime.

import type { Rpc } from "@opencode/plugin/rpc"

/** One row of the Desktop context panel: one session, its own window. */
export interface DesktopRow {
  readonly sessionID: string
  /** "" for the root session of the family. */
  readonly parentID: string
  readonly agent: string
  readonly modelID: string
  readonly providerID: string
  /** Context tokens in use (prompt + tool schemas + system). */
  readonly ctx: number
  readonly input: number
  /** The engine's usable window; 0 when the model limits are not known yet. */
  readonly usable: number
  /** The compaction reserve subtracted from the window; 0 when unknown. */
  readonly reserve: number
  readonly user: number
  readonly assistant: number
  readonly reasoning: number
  readonly toolArgs: number
  readonly toolOut: number
  readonly system: number
  readonly toolSchemas: number
  readonly other: number
  /** "live" | "snapshot" | "client-context" | "no-data" (or an engine tag). */
  readonly source: string
  /** ISO timestamp of the measurement; "" when unknown. */
  readonly updatedAt: string
  /** The session was compacted after this measurement. */
  readonly stale: boolean
}

/** Output of the `family` method. */
export interface DesktopFamilyResult {
  readonly rows: readonly DesktopRow[]
}

export declare const DesktopContextRpc: Rpc.PortableDefinition
export declare const DESKTOP_ROW_KEYS: readonly string[]
