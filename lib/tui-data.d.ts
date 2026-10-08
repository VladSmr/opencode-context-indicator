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
  updatedAt?: string
}

export declare const STATE_FILE: string
export declare const POLL_MS: number
export declare function isNodeModulesInstall(): boolean
export declare function readSnapshot(): Record<string, StateEntry>
export declare function collectFamily(
  snapshot: Record<string, StateEntry>,
  rootID: string,
): StateEntry[]
export declare function fmt(n: number): string
export declare function num(v: unknown): number
export declare function fit(s: string, w: number): string
export declare function updatedAt(iso: string | undefined): string
