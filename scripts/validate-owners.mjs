// TREK-Plugins registry: OWNERS.json gate.
//
// OWNERS.json is the id→owner trust anchor the owner-binding gate in
// validate-entry.mjs reads — a silent rewrite of it defeats that gate entirely,
// and a malformed one disables it (the read used to fall back to "no bindings").
// publish.yml maintains the file on merge; this script is what a PR that touches
// it (or anything else) is checked against:
//
//   - the file parses and has exactly the shape publish-stamp.mjs writes:
//     { _comment?, plugins: { <id>: { boundOwner, repo, firstReviewedAt } } }
//   - every bound id maps to a real registry/plugins/<id>.json — or to one that
//     EXISTED and was removed (a tombstone: the binding of a deleted plugin is
//     kept on purpose, so its id cannot be resurrected by someone else). An id
//     that never had an entry is junk and is refused.
//
// Fail-closed like the other gates: if git history cannot be read to prove a
// tombstone, that is a failure, not a skip.
//
// Usage: node scripts/validate-owners.mjs   (from the repo root; CI does this)

import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// Mirror the patterns of schema/plugin-entry.schema.json — the bindings describe
// the same ids and repos the entries do.
const ID_RE = /^[a-z][a-z0-9-]{2,39}$/
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

const fail = []
const bad = (m) => fail.push(m)

let owners
try {
  owners = JSON.parse(readFileSync('OWNERS.json', 'utf8'))
} catch (e) {
  console.error('OWNERS.json gate FAILED: not readable/valid JSON: ' + e.message)
  process.exit(1)
}

for (const k of Object.keys(owners)) {
  if (k !== '_comment' && k !== 'plugins') bad(`unknown top-level key "${k}" — OWNERS.json carries only _comment and plugins`)
}
if (typeof owners.plugins !== 'object' || owners.plugins === null || Array.isArray(owners.plugins)) {
  bad('"plugins" must be an object mapping plugin id -> binding')
}

/** Did registry/plugins/<id>.json ever exist on this history? (tombstone check) */
function existedInHistory(rel) {
  try {
    const out = execFileSync('git', ['rev-list', '-1', 'HEAD', '--', rel], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    return { known: true, existed: out !== '' }
  } catch {
    return { known: false, existed: false }
  }
}

for (const [id, binding] of Object.entries(owners.plugins ?? {})) {
  const at = `plugins["${id}"]`
  if (!ID_RE.test(id)) bad(`${at}: id does not match ${ID_RE} (the entry id pattern)`)
  if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) {
    bad(`${at}: binding must be an object { boundOwner, repo, firstReviewedAt }`)
    continue
  }
  for (const k of Object.keys(binding)) {
    if (!['boundOwner', 'repo', 'firstReviewedAt'].includes(k)) bad(`${at}: unknown key "${k}"`)
  }
  if (typeof binding.boundOwner !== 'string' || !binding.boundOwner.trim()) bad(`${at}: boundOwner must be a non-empty string`)
  if (typeof binding.repo !== 'string' || !REPO_RE.test(binding.repo)) bad(`${at}: repo must be "owner/name"`)
  if (typeof binding.firstReviewedAt !== 'string' || !DATE_RE.test(binding.firstReviewedAt)) bad(`${at}: firstReviewedAt must be YYYY-MM-DD`)

  const rel = `registry/plugins/${id}.json`
  if (!existsSync(rel)) {
    const { known, existed } = existedInHistory(rel)
    if (!known) bad(`${at}: no ${rel} on disk, and git history is unreadable so it cannot be proven a tombstone of a removed plugin — refusing rather than skipping the check`)
    else if (!existed) bad(`${at}: no ${rel} exists and none ever did — a binding must map to a registry entry (or the tombstone of one)`)
  }
}

if (fail.length) {
  console.error('OWNERS.json gate FAILED:')
  for (const f of fail) console.error('  - ' + f)
  process.exit(1)
}
console.log(`OWNERS.json gate passed (${Object.keys(owners.plugins ?? {}).length} binding(s)).`)
