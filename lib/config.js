// lib/config.js
//
// Reads the ONE opencode setting the plugin cannot obtain through the plugin
// API: `compaction.buffer` (opencode 2.2.5+, a token count or a percentage such
// as "20%"). Core applies it in calculateCeiling(); a plugin only sees the
// resulting model limits, so the reserve has to be mirrored from the user's own
// config file.
//
// The plugin has NO runtime dependencies (see README "Live sidebar"), so the
// JSONC reader is a small in-file scanner instead of a parser package:
//   - strips // line and /* block */ comments OUTSIDE strings,
//   - drops a trailing comma before } or ] OUTSIDE strings,
//   - understands strings with escapes so "a//b" and "/*" survive.
// That covers the shapes opencode itself accepts (opencode.jsonc is JSONC).
//
// Precedence mirrors opencode: the project config wins over the global one; the
// env var OPENCODE_CONTEXT_INDICATOR_COMPACT_BUFFER still wins over both (it is
// a testing/power-user override, resolved in lib/limits.js). A buffer that is
// not smaller than the window is ignored by the caller, exactly like core.
//
// The directory is an ARGUMENT, never module state: one server process can host
// several plugin instances (one per location), so a single "current project"
// variable would leak project A's buffer into project B's measurement. Callers
// pass `ctx.location.directory` (see locationDirectory) or nothing for the
// global-only lookup.
//
// The file is read on demand and re-parsed only when its mtime/size changes, so
// the 1 s tick never turns this into a hot loop.

import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// path -> { mtimeMs, size, entry }; entry = { ok: true, value } | { ok: false }
const fileCache = new Map()

// The project directory a V2 plugin context belongs to, or "" when the host did
// not give one. Accepts any object with a `location.directory` string.
export function locationDirectory(ctx) {
  try {
    const dir = ctx?.location?.directory
    return typeof dir === "string" && dir.length > 0 ? dir : ""
  } catch {
    return ""
  }
}

// Global config directory, same resolution opencode uses on every platform.
function globalConfigDir() {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = typeof xdg === "string" && xdg.length > 0 ? xdg : join(homedir(), ".config")
  return join(base, "opencode")
}

// Drop a trailing comma (one followed only by whitespace and } or ]). This is a
// second string-aware pass: a plain regex would also rewrite `"a,}"` INSIDE a
// string value, silently changing it.
function dropTrailingCommas(text) {
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === ",") {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === "}" || text[j] === "]") continue // drop the comma only
    }
    out += ch
  }
  return out
}

// Strip comments and trailing commas from a JSONC document. The scanner is
// string-aware: `//` or `/*` inside a string value is left untouched.
export function stripJsonc(text) {
  if (typeof text !== "string") return ""
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      out += ch
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++
      i++ // skip the closing "/"
      continue
    }
    out += ch
  }
  return dropTrailingCommas(out)
}

// Parse a JSONC file with caching. Returns { ok, value } (never throws).
function readJsoncFile(path) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    return { ok: false }
  }
  const cached = fileCache.get(path)
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.entry
  }
  let entry
  try {
    const parsed = JSON.parse(stripJsonc(readFileSync(path, "utf8")))
    entry = { ok: true, value: parsed }
  } catch {
    // A malformed config is the host's problem to report; the plugin simply
    // falls back to the default reserve rather than guessing.
    entry = { ok: false }
  }
  fileCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, entry })
  return entry
}

// Candidate files for one config directory, in opencode's own precedence.
function configFiles(dir) {
  return [
    join(dir, "opencode.jsonc"),
    join(dir, "opencode.json"),
    join(dir, ".opencode", "opencode.jsonc"),
    join(dir, ".opencode", "opencode.json"),
  ]
}

function bufferFromFile(path) {
  const read = readJsoncFile(path)
  if (!read.ok) return { found: false }
  const root = read.value && typeof read.value === "object" ? read.value : null
  const compaction = root && typeof root.compaction === "object" && root.compaction ? root.compaction : null
  if (!compaction || !Object.prototype.hasOwnProperty.call(compaction, "buffer")) {
    return { found: false }
  }
  return { found: true, value: compaction.buffer, source: path }
}

// Resolve the effective `compaction.buffer`. Project beats global; inside one
// directory the first existing file wins (that is how opencode picks a file).
// Returns { value, source } where value may be undefined when nobody set it.
export function resolveCompactionBuffer(directory) {
  const globalDir = globalConfigDir()
  const dirs = [globalDir]
  if (typeof directory === "string" && directory.length > 0 && directory !== globalDir) {
    dirs.push(directory)
  }

  let result = { value: undefined, source: undefined }
  for (const configDir of dirs) {
    for (const path of configFiles(configDir)) {
      const hit = bufferFromFile(path)
      if (hit.found) {
        result = { value: hit.value, source: hit.source }
        break
      }
      // A file that exists but has no buffer still ends the search in this
      // directory only if it exists; otherwise keep looking at the next name.
      let exists = true
      try {
        statSync(path)
      } catch {
        exists = false
      }
      if (exists) break
    }
  }
  return result
}

// Convert a configured buffer to tokens for a given window. Accepts the two
// shapes opencode 2.2.5 accepts (`NonNegativeInt` and a 1%-99% string) and
// returns undefined for anything else - the caller then keeps the default 15%
// formula, exactly like core ignoring an unusable buffer. The integer/1e9
// bounds match the env override in lib/limits.js so both paths reject the same
// shapes.
export function bufferTokens(window, raw) {
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw >= 0 && raw <= 1e9 ? raw : undefined
  }
  if (typeof raw !== "string") return undefined
  const match = /^([1-9]\d?(?:\.\d+)?)%$/.exec(raw)
  if (!match) return undefined
  const percent = Number.parseFloat(match[1])
  if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) return undefined
  if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return undefined
  return Math.round((window * percent) / 100)
}

// Test-only: drop the parse cache so a rewritten fixture is re-read on the same
// mtime granularity (Windows FAT timestamps are coarse).
export function resetConfigCache() {
  fileCache.clear()
}
