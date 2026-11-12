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
export interface ComposerStatus {
  percent: number
  label: string
  tone?: "warning" | "danger"
}
export declare const COMPOSER_WARN_PERCENT: number
export declare const COMPOSER_DANGER_PERCENT: number
export declare function composerStatus(
  entry: StateEntry | null | undefined,
): ComposerStatus | null
export declare function readSnapshot(): Record<string, StateEntry>
export declare function collectFamily(
  snapshot: Record<string, StateEntry>,
  rootID: string,
): StateEntry[]
export declare function fmt(n: number): string
export declare function num(v: unknown): number
export declare const MAX_FAMILY_ROWS: number
export interface FamilySplit {
  root: StateEntry | null
  shown: StateEntry[]
  hidden: StateEntry[]
  hiddenCtx: number
}
export declare function splitFamily(
  rows: readonly StateEntry[],
  limit?: number,
): FamilySplit
export interface FamilyTail {
  count: number
  hiddenCtx: number
  percent: number | null
  text: string
}
export declare function familyTail(
  hidden: readonly StateEntry[],
  total: number,
): FamilyTail
export declare function sumCtx(
  rows:
    | ReadonlyArray<{ ctx?: unknown } | null | undefined>
    | null
    | undefined,
): number
export declare function fit(s: string, w: number): string
export declare function updatedAt(iso: string | undefined): string
export declare function updatedCell(
  iso: string | undefined,
  stale: boolean | undefined,
  width: number,
): string
export declare function panelLayout(panelWidth: number | undefined): {
  roleW: number
  modelW: number
  ctxW: number
  costW: number
  updW: number
  gutter: string
}
export declare function toolOutEntries(
  map: Record<string, number> | undefined,
  limit?: number,
): Array<[string, number]>
