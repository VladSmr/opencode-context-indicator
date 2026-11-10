// lib/constants.js
//
// Compaction constants mirrored from the RELEASED opencode core
// (packages/core/src/session/compaction.ts). They live in a dependency-free
// module so the daily drift-watch can compare them with the release tag without
// loading the state/config stack just to read two numbers.
//
// Pinned to a release, never to a branch head: v2.2.7 ships RESERVE_SHARE 0.15
// and RESERVE_MIN 16_000 with the `2 * RESERVE_MIN` gate. The unreleased `v2`
// branch uses an inline 0.1; mirroring it would make every displayed percentage
// wrong. See lib/limits.js for the full formula and the PR history.
export const RESERVE_SHARE = 0.15;
export const RESERVE_MIN = 16_000;
