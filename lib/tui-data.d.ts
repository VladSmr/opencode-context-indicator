// lib/tui-data.d.ts
//
// Types for lib/tui-data.js (the TUI data layer). state.json is written by
// writeStateFile() in index.js and is untrusted input — every consumer treats
// the fields as optional.

export interface Categories {
  user?: number
  assistant?: number
  reasoning?: number
  toolArgs?: number
  toolOut?: number
  system?: number | null
  toolSchemas?: number | null
  other?: number
}

export interface StateEntry {
  sessionID?: string
  parentID?: string | null
  role?: string
  agent?: string | null
  model?: string
  providerID?: string
  ctx?: number
  input?: number
  usable?: number | null
  reserve?: number | null
  limit?: number | null
  reasoning?: number
  categories?: Categories
  /** Per-tool tool-result split: tool name -> estimated tokens. */
  toolOutByTool?: Record<string, number>
  /** Provider-reported prompt-cache tokens (exact; a subset of input). */
  cacheRead?: number | null
  cacheWrite?: number | null
  /** Redundant tool output (waste detector). Findings here are path-free. */
  reclaim?: {
    tokens: number
    count: number
    findings?: Array<{
      kind?: string
      name?: string
      n?: number
      tokens?: number
    }>
  } | null
  /** ISO time of the last session.compacted (marker only). */
  compactedAt?: string | null
  /** True while the entry still shows pre-compaction numbers. */
  compactStale?: boolean
  updatedAt?: string
}

export declare const STATE_FILE: string
export declare const POLL_MS: number
export declare function readSnapshot(): Record<string, StateEntry>
export declare function collectFamily(
  snapshot: Record<string, StateEntry>,
  rootID: string,
): StateEntry[]
export declare function fmt(n: number): string
export declare function num(v: unknown): number
export declare function fit(s: string, w: number): string
export declare function updatedAt(iso: string | undefined): string
export declare function toolOutEntries(
  map: Record<string, number> | undefined,
  limit?: number,
): Array<[string, number]>
