// The TREK host-version range a plugin declares in its manifest's `trek` field.
//
// TREK gates installs AND activation on this range, so what the registry accepts has to be
// exactly what the server accepts. These two helpers mirror TREK's own host-compat module
// (server/src/nest/plugins/install/host-compat.ts) — keep them in step.

import semver from 'semver'

/**
 * Whether `r` is a range a plugin may declare.
 *
 * `semver.validRange()` alone is not enough: ">=4.0.0 <3.0.0" is a VALID range that no
 * version can ever satisfy, so a plugin declaring it would be uninstallable on every
 * instance with nothing to tell its author why. `minVersion()` returns null for exactly
 * that case — and throws outright on junk like "latest" — so it is the real test.
 */
export function satisfiableRange(r) {
  if (typeof r !== 'string' || !r.trim()) return false
  if (semver.validRange(r) === null) return false
  try {
    return semver.minVersion(r) !== null
  } catch {
    return false
  }
}

/**
 * The lowest TREK a range admits — what an entry publishes as `minTrekVersion`.
 *
 * Read off the range with semver rather than by finding the first version-shaped substring
 * in it: for "<4.0.0" that substring is 4.0.0, which is the range's UPPER bound, and
 * publishing it as the minimum states the exact inverse of what the plugin supports.
 */
export function trekFloor(r) {
  return satisfiableRange(r) ? semver.minVersion(r).version : null
}
