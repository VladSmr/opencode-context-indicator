// lib/dedup.js
//
// Shared helpers for the local OpenCode plugins in ../ (V2 + V1 dual format).
//
// WHY THIS FILE LIVES IN A SUBDIRECTORY WITHOUT AN INDEX FILE
//   The V2 plugin loader auto-discovers entries under the plugins/ directory.
//   A *directory* entry is treated as a plugin only when it contains an index
//   file (docs: ".opencode/plugins/example/index.ts"); a directory without one
//   is ignored entirely (verified empirically against opencode 2.0.16:
//   plugins/lib/index.js showed up as a plugin, plugins/libprobe2/dedup.js did
//   not). Keeping the shared helpers in ./lib/dedup.js therefore lets other
//   plugin files `import` them with a plain relative specifier — the documented
//   multi-file plugin pattern — WITHOUT registering a phantom no-op plugin.
//   The default export below is still a valid no-op plugin definition as
//   defense-in-depth, so the file stays inert even if a future loader starts
//   discovering non-index modules.
//
// EXPORTS
//   claimOnce(key, dedupDir)  atomic cross-instance / cross-process claim
//   pruneDedup(dedupDir)      delete claim markers older than DEDUP_TTL_MS
//   pruneMap(map, maxSize)    FIFO-trim an in-process Map (insertion order)
//   DEDUP_TTL_MS              marker lifetime (24h)
//
// The claim mechanism is the exact one proven in token-usage-logger.js:
// OpenCode loads one plugin instance per loaded location and mirrors the public
// event stream to every instance, so without an atomic claim each logical event
// would be recorded once per location. An exclusive-create file marker ("wx")
// makes exactly one instance win. Fail-open: if the marker cannot be created
// for an unexpected reason the event is still recorded (never lose data over
// bookkeeping).

import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // prune claim markers after a day
// Time-throttled pruning. A claim directory can hold tens of thousands of
// markers (mostly legacy per-delta markers), and pruneDedup() does a
// synchronous readdirSync+statSync over the whole directory — running that in
// the event-loop hot path stalls the event stream. Pruning therefore runs at
// most once per PRUNE_MIN_INTERVAL_MS. The timestamp is seeded at module load
// so the first claim after startup does NOT trigger a scan (keeping startup /
// first events off the scan path); the first prune happens on the first claim
// at least PRUNE_MIN_INTERVAL_MS after load.
const PRUNE_MIN_INTERVAL_MS = 10 * 60 * 1000; // at most one prune / 10 minutes
let lastPruneAt = Date.now();

function logErr(msg, err) {
  try {
    console.error(`[plugin-lib] ${msg}:`, err);
  } catch {
    /* ignore */
  }
}

// Trim an in-process Map to at most `maxSize` entries. This is FIFO, not LRU:
// it deletes the OLDEST INSERTED keys and `set()` on an existing key does NOT
// move it to the end, so a frequently-updated key can still be evicted once it
// ages out of the insertion order.
export function pruneMap(map, maxSize) {
  if (!map || map.size <= maxSize) return;
  const excess = map.size - maxSize;
  let removed = 0;
  for (const key of map.keys()) {
    if (removed >= excess) break;
    map.delete(key);
    removed++;
  }
}

// Atomic, cross-instance, cross-process exactly-once claim.
// Returns true when this caller won the claim (or on fail-open), false when the
// marker already existed (another instance already claimed it).
export function claimOnce(key, dedupDir) {
  try {
    mkdirSync(dedupDir, { recursive: true });
    // The sanitised name alone collapses distinct keys (e.g. "a/b" and "a_b" both
    // become "a_b") into the SAME marker -> a false "already claimed". Append a
    // stable hash of the ORIGINAL key so distinct keys get distinct markers while
    // an identical key maps to an identical name in every instance/process.
    const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
    const hash = createHash("sha1").update(String(key)).digest("hex").slice(0, 12);
    const fd = openSync(join(dedupDir, `${safe}.${hash}.seen`), "wx");
    closeSync(fd);
    const now = Date.now();
    if (now - lastPruneAt >= PRUNE_MIN_INTERVAL_MS) {
      lastPruneAt = now;
      pruneDedup(dedupDir);
    }
    return true;
  } catch (err) {
    if (err && err.code === "EEXIST") return false;
    logErr("claimOnce failed (fail-open)", err);
    return true; // fail open
  }
}

// Delete claim markers older than DEDUP_TTL_MS. Never throws.
export function pruneDedup(dedupDir) {
  try {
    const now = Date.now();
    for (const f of readdirSync(dedupDir)) {
      try {
        const p = join(dedupDir, f);
        if (now - statSync(p).mtimeMs > DEDUP_TTL_MS) unlinkSync(p);
      } catch {
        /* ignore single file */
      }
    }
  } catch {
    /* ignore (dir missing / transient) */
  }
}

// Valid no-op plugin definition (see "WHY THIS FILE LIVES ..." above).
export default {
  id: "plugin-lib",
  async setup() {},
  async server() {
    return {};
  },
};
