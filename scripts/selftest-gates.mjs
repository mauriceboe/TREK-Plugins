// Self-test for the entry-validation gates.
//
// validate-entry.mjs is the only thing standing between a bad PR and every TREK
// instance in the world, but until now nothing tested it — and editing it triggered
// no CI at all. These cases pin the behaviour that matters: the gate must fire on a
// signing downgrade (which bricks updates for existing installs), and must NOT fire
// on the legitimate entries already in the registry.
//
// Offline only (SKIP_NETWORK=1) — the crypto path over real artifact bytes is
// exercised by the networked run against the live signed entries.
//
// Usage: node scripts/selftest-gates.mjs

import { execFileSync } from 'node:child_process'
import { writeFileSync, readFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { satisfiableRange, trekFloor } from './lib/trek-range.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// A minimal, schema-valid signed entry. The signature/key are well-formed base64 of the
// right lengths (44-char key, 88-char sig) — shape checks pass; crypto is not run offline.
const KEY = Buffer.alloc(32, 7).toString('base64')
const SIG = Buffer.alloc(64, 9).toString('base64')

const baseEntry = () => ({
  id: 'selftest-plugin',
  name: 'Selftest Plugin',
  author: 'someone',
  description: 'A fixture entry used to self-test the registry validation gates.',
  repo: 'someone/trek-plugin-selftest',
  type: 'integration',
  authorPublicKey: KEY,
  versions: [
    {
      version: '1.0.0',
      gitTag: 'v1.0.0',
      commitSha: 'a'.repeat(40),
      downloadUrl: 'https://github.com/someone/trek-plugin-selftest/releases/download/v1.0.0/plugin.zip',
      sha256: 'b'.repeat(64),
      size: 1024,
      apiVersion: 1,
      trek: '>=3.3.0 <4.0.0',
      minTrekVersion: '3.3.0',
      nativeModules: false,
      signature: SIG,
      publishedAt: '2026-01-01T00:00:00Z',
    },
  ],
})

let failures = 0
const results = []

/** Run the validator against `entry` written as <id>.json; returns { ok, out }.
 *  `overrides` sets the maintainer-override env vars the validate.yml labels supply.
 *  `deleteAtBase` commits the previous entry and then its DELETION, so the entry is
 *  absent at BASE_SHA but present in history — the delete-then-re-add resurrection. */
function runGate(entry, { baseEntry: prev, overrides = {}, deleteAtBase = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trek-selftest-'))
  try {
    // The downgrade guard reads the previous entry via `git show $BASE_SHA:<path>`, so the
    // fixture needs a real git repo with the previous entry committed at HEAD.
    const reg = path.join(dir, 'registry', 'plugins')
    mkdirSync(reg, { recursive: true })
    const file = path.join(reg, `${entry.id}.json`)
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })

    let env = { ...process.env, SKIP_NETWORK: '1', ...overrides }
    if (prev) {
      git('init', '-q')
      git('config', 'user.email', 'selftest@example.com')
      git('config', 'user.name', 'selftest')
      writeFileSync(file, JSON.stringify(prev, null, 2))
      git('add', '-A')
      git('commit', '-qm', 'base')
      if (deleteAtBase) {
        git('rm', '-q', file) // also prunes the emptied registry/plugins dirs…
        git('commit', '-qm', 'remove')
        mkdirSync(reg, { recursive: true }) // …so put them back for the re-add below
      }
      env.BASE_SHA = 'HEAD'
    }
    writeFileSync(file, JSON.stringify(entry, null, 2))

    // Validate from the fixture repo, but with THIS repo's schema/scripts.
    try {
      const out = execFileSync('node', [path.join(ROOT, 'scripts', 'validate-entry.mjs'), file], {
        cwd: prev ? dir : ROOT,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { ok: true, out }
    } catch (e) {
      return { ok: false, out: (e.stdout || '') + (e.stderr || '') }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function expect(label, { ok, out }, shouldPass, mustMention) {
  const passed = ok === shouldPass && (!mustMention || out.includes(mustMention))
  if (!passed) failures++
  results.push(`${passed ? 'ok  ' : 'FAIL'}  ${label}`)
  if (!passed) {
    results.push(`        expected ${shouldPass ? 'PASS' : 'FAIL'}${mustMention ? ` mentioning "${mustMention}"` : ''}, got ${ok ? 'PASS' : 'FAIL'}`)
    results.push(`        output: ${out.trim().split('\n').join('\n        ')}`)
  }
}

// --- the gates ---

expect('a well-formed signed entry passes', runGate(baseEntry()), true)

{
  const e = baseEntry()
  delete e.authorPublicKey
  delete e.versions[0].signature
  expect('an unsigned entry passes (signing is opt-in)', runGate(e), true)
}

{
  const e = baseEntry()
  delete e.authorPublicKey
  expect('a signature with no authorPublicKey fails', runGate(e), false, 'half-signed')
}

{
  const e = baseEntry()
  delete e.versions[0].signature
  expect('an authorPublicKey with no signed version fails', runGate(e), false, 'no version carries a signature')
}

// Even a FIRST signed publish (no base to diff against) must have EVERY version signed,
// not just the newest: TREK verifies whichever version a pinned install runs, so an
// unsigned older block would install green here and then be refused by the host.
{
  const e = baseEntry()
  const older = { ...e.versions[0], version: '0.9.0', gitTag: 'v0.9.0' }
  delete older.signature
  e.versions = [...e.versions, older] // newest (signed) first, older (unsigned) second
  expect('a first signed publish with an unsigned older version fails', runGate(e), false, 'no signature')
}

{
  const e = baseEntry()
  e.authorPublicKey = 'not-base64-a-key'
  expect('a malformed authorPublicKey fails', runGate(e), false, 'not a valid Ed25519')
}

// The brick: a plugin published SIGNED ships an unsigned update. TREK refuses this on
// every instance that already has it, so CI must refuse it first.
{
  const prev = baseEntry()
  const e = baseEntry()
  const v = { ...e.versions[0], version: '1.1.0', gitTag: 'v1.1.0' }
  delete v.signature
  e.versions = [v, ...e.versions]
  expect('a signed plugin shipping an UNSIGNED update fails', runGate(e, { baseEntry: prev }), false, 'no signature')
}

// A key rotation needs an explicit maintainer override, mirroring TREK's TOFU refusal.
{
  const prev = baseEntry()
  const e = baseEntry()
  e.authorPublicKey = Buffer.alloc(32, 42).toString('base64')
  expect('a signed plugin CHANGING its key fails', runGate(e, { baseEntry: prev }), false, 'changes its authorPublicKey')
}

// --- delete-then-re-add (resurrection) ---
//
// An entry absent at BASE_SHA is not necessarily new: deleting a signed plugin in one PR
// and re-adding it in another used to reset the downgrade baseline, laundering the exact
// unsigned/re-keyed update the guard exists to stop. The guard now digs the last published
// state out of the base branch's history and treats THAT as the baseline.
{
  const prev = baseEntry()
  const e = baseEntry()
  delete e.authorPublicKey
  delete e.versions[0].signature
  expect('re-adding a DELETED signed plugin unsigned fails', runGate(e, { baseEntry: prev, deleteAtBase: true }), false, 'drops authorPublicKey')
}
{
  const prev = baseEntry()
  const e = baseEntry()
  e.authorPublicKey = Buffer.alloc(32, 42).toString('base64')
  expect('re-adding a DELETED signed plugin with a DIFFERENT key fails', runGate(e, { baseEntry: prev, deleteAtBase: true }), false, 'changes its authorPublicKey')
}
{
  expect('re-adding a DELETED signed plugin with the SAME key passes', runGate(baseEntry(), { baseEntry: baseEntry(), deleteAtBase: true }), true)
}
{
  const prev = baseEntry()
  const e = baseEntry()
  e.authorPublicKey = Buffer.alloc(32, 42).toString('base64')
  expect(
    'a re-keyed resurrection PASSES with ALLOW_KEY_CHANGE=1 (the allow-key-change label)',
    runGate(e, { baseEntry: prev, deleteAtBase: true, overrides: { ALLOW_KEY_CHANGE: '1' } }),
    true,
  )
}
{
  // A plugin that never signed carries no baseline key — its resurrection is not a downgrade.
  const unsigned = () => {
    const e = baseEntry()
    delete e.authorPublicKey
    delete e.versions[0].signature
    return e
  }
  expect('re-adding a DELETED unsigned plugin passes', runGate(unsigned(), { baseEntry: unsigned(), deleteAtBase: true }), true)
}

// apiVersion is optional in the manifest (TREK and the SDK both default it to 1). The
// entry always carries 1. This used to fail parity with "manifest apiVersion undefined != 1".
{
  const e = baseEntry()
  expect('an entry whose manifest omits apiVersion passes (offline shape)', runGate(e), true)
}

// --- icon ---
//
// TREK falls back to Blocks on an icon name lucide doesn't have, so a typo is invisible
// in the store: the tile just looks like every other plugin. The gate is the only place
// it can be caught.
{
  const e = baseEntry()
  e.icon = 'Luggage'
  expect('an entry with a real lucide icon passes', runGate(e), true)
}
{
  const e = baseEntry()
  delete e.icon
  expect('an entry with no icon passes (optional; TREK defaults to Blocks)', runGate(e), true)
}
{
  const e = baseEntry()
  e.icon = 'Luggagee'
  expect('an entry with a typo\'d icon name fails', runGate(e), false, 'is not a lucide icon name')
}
{
  const e = baseEntry()
  e.icon = 'luggage'
  expect('a lowercase icon name fails the schema pattern', runGate(e), false, 'pattern')
}

// --- the maintainer overrides ---
//
// These are the ONLY way through the two gates that protect existing installs, and
// validate.yml supplies them from the `allow-key-change` / `allow-owner-change` PR labels.
// Pin them here: without a test, renaming an env var (or fat-fingering the label expression
// in the workflow) silently welds the escape hatch shut, and nobody notices until a real
// author needs to rotate a key.

{
  const prev = baseEntry()
  const e = baseEntry()
  e.authorPublicKey = Buffer.alloc(32, 42).toString('base64')
  expect(
    'a key rotation PASSES with ALLOW_KEY_CHANGE=1 (the allow-key-change label)',
    runGate(e, { baseEntry: prev, overrides: { ALLOW_KEY_CHANGE: '1' } }),
    true,
  )
}

// The owner gate needs a real binding in OWNERS.json, so borrow one and repoint it at
// somebody else — which is precisely the hijack the gate exists to stop.
{
  const bound = JSON.parse(readFileSync(path.join(ROOT, 'OWNERS.json'), 'utf8')).plugins
  const [id, { boundOwner }] = Object.entries(bound)[0]
  const hijack = () => ({ ...baseEntry(), id, repo: `not-${boundOwner}/hijacked` })

  expect('repointing a bound id at a NEW owner fails', runGate(hijack()), false, 'is bound to owner')
  expect(
    'an owner change PASSES with ALLOW_OWNER_CHANGE=1 (the allow-owner-change label)',
    runGate(hijack(), { overrides: { ALLOW_OWNER_CHANGE: '1' } }),
    true,
  )
}

// --- the TREK host-version range ---
//
// TREK gates installs AND activation on the manifest's `trek` range, so an entry that
// carries the wrong one (or none) merges green and is then uninstallable. The parity check
// itself needs the author's manifest and so only runs networked; what CAN be pinned offline
// is that the schema admits the field at all — it is `additionalProperties: false`, so before
// `trek` was added to it EVERY entry the current SDK builds was a hard schema failure.
{
  const e = baseEntry()
  expect('an entry carrying a trek range passes the schema', runGate(e), true)

  const noTrek = baseEntry()
  delete noTrek.versions[0].trek
  expect('an entry WITHOUT a trek range still passes (published before the field existed)', runGate(noTrek), true)

  // `trek` supersedes minTrekVersion, so a new entry simply omits the floor. It was required
  // until 3.4.0, which meant a new plugin had to restate — in a weaker form — a fact its range
  // already carried.
  const noFloor = baseEntry()
  delete noFloor.versions[0].minTrekVersion
  expect('an entry with a trek range and NO minTrekVersion passes', runGate(noFloor), true)

  const nullFloor = baseEntry()
  nullFloor.versions[0].minTrekVersion = null
  expect('an explicit null minTrekVersion passes', runGate(nullFloor), true)

  const junk = baseEntry()
  junk.versions[0].notAField = 'x'
  expect('an unknown version field is still rejected', runGate(junk), false, 'must NOT have additional properties')
}

// The floor an entry advertises is derived from the range, never hand-written — and reading
// it off the text instead of the range is how "<4.0.0" came to publish a MINIMUM of 4.0.0,
// the exact inverse of what the plugin supports.
{
  const cases = [
    ['>=3.2.0 <4.0.0', '3.2.0'],
    ['^3.2.0', '3.2.0'],
    ['>=3', '3.0.0'],
    ['<4.0.0', '0.0.0'],
    ['>=4.0.0 <3.0.0', null], // valid syntax, satisfiable by nothing
    ['latest', null],
    ['3.2+', null],
    ['', null],
  ]
  for (const [range, want] of cases) {
    expect(`trekFloor(${JSON.stringify(range)}) === ${JSON.stringify(want)}`, { ok: trekFloor(range) === want, out: String(trekFloor(range)) }, true)
  }
  expect('satisfiableRange rejects an empty range', { ok: !satisfiableRange('>=4.0.0 <3.0.0'), out: '' }, true)
}

// --- downloadCount: computed, never submitted ---
//
// downloadCount exists only in dist/index.json (build/aggregate.mjs injects it from
// registry/stats.json). The entry schema doesn't know the field at all — only
// registry.schema.json's published-entry shape admits it — and the gate refuses it in a
// submission with a message that says why, instead of a bare unevaluatedProperties error.
{
  const e = baseEntry()
  e.downloadCount = 12345
  expect('an entry submitting its own downloadCount fails', runGate(e), false, 'computed by CI')
}
{
  // The published shape: what aggregate.mjs emits (downloadCount + the publish-stamped
  // reviewedAt/boundOwner) must validate against registry.schema.json, which extends the
  // entry core (plugin-entry.schema.json#/$defs/entry) with the CI-injected downloadCount
  // — this is the check that used to fail.
  const ajv = new Ajv2020({ allErrors: true, strict: false })
  addFormats(ajv)
  ajv.addSchema(JSON.parse(readFileSync(path.join(ROOT, 'schema', 'plugin-entry.schema.json'), 'utf8')))
  const validateRegistry = ajv.compile(JSON.parse(readFileSync(path.join(ROOT, 'schema', 'registry.schema.json'), 'utf8')))
  const aggregated = {
    schemaVersion: 1,
    generatedAt: '2026-07-18T00:00:00.000Z',
    plugins: [{ ...baseEntry(), downloadCount: 42, reviewedAt: '2026-07-18', boundOwner: 'someone' }],
  }
  expect(
    'the aggregated dist/index.json shape validates against registry.schema.json',
    { ok: !!validateRegistry(aggregated), out: JSON.stringify(validateRegistry.errors) },
    true,
  )
}

// --- the OWNERS.json gate ---
//
// OWNERS.json is the trust anchor the owner-binding gate reads; validate-owners.mjs is what
// keeps it well-formed and honest (every binding maps to an entry, or to the tombstone of a
// deliberately removed one). Same fixture idea as runGate: a real git repo, because the
// tombstone check reads history.

/** Run validate-owners.mjs in a fixture repo; `entries` exist, `tombstones` existed and were removed. */
function runOwnersGate(owners, { entries = [], tombstones = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trek-owners-'))
  try {
    const reg = path.join(dir, 'registry', 'plugins')
    mkdirSync(reg, { recursive: true })
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
    git('init', '-q')
    git('config', 'user.email', 'selftest@example.com')
    git('config', 'user.name', 'selftest')
    for (const id of [...entries, ...tombstones]) writeFileSync(path.join(reg, `${id}.json`), '{}\n')
    writeFileSync(path.join(dir, 'OWNERS.json'), JSON.stringify(owners, null, 2))
    git('add', '-A')
    git('commit', '-qm', 'base')
    for (const id of tombstones) git('rm', '-q', path.join(reg, `${id}.json`))
    if (tombstones.length) git('commit', '-qm', 'remove')
    try {
      const out = execFileSync('node', [path.join(ROOT, 'scripts', 'validate-owners.mjs')], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return { ok: true, out }
    } catch (e) {
      return { ok: false, out: (e.stdout || '') + (e.stderr || '') }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  const binding = { boundOwner: 'someone', repo: 'someone/trek-plugin-selftest', firstReviewedAt: '2026-01-01' }
  expect(
    'a binding that maps to an existing entry passes',
    runOwnersGate({ plugins: { 'selftest-plugin': binding } }, { entries: ['selftest-plugin'] }),
    true,
  )
  expect(
    'a binding for a DELETED entry passes (tombstone reserves the id)',
    runOwnersGate({ plugins: { 'selftest-plugin': binding } }, { tombstones: ['selftest-plugin'] }),
    true,
  )
  expect(
    'a binding for an id that never had an entry fails',
    runOwnersGate({ plugins: { 'selftest-plugin': binding } }),
    false,
    'none ever did',
  )
  expect(
    'a binding missing firstReviewedAt fails',
    runOwnersGate(
      { plugins: { 'selftest-plugin': { boundOwner: 'someone', repo: 'someone/x' } } },
      { entries: ['selftest-plugin'] },
    ),
    false,
    'firstReviewedAt',
  )
  expect(
    'an unknown top-level key in OWNERS.json fails',
    runOwnersGate({ plugins: {}, extra: true }),
    false,
    'unknown top-level key',
  )
  // The repo's real OWNERS.json must itself pass the gate it feeds.
  let own
  try {
    const out = execFileSync('node', [path.join(ROOT, 'scripts', 'validate-owners.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    own = { ok: true, out }
  } catch (e) {
    own = { ok: false, out: (e.stdout || '') + (e.stderr || '') }
  }
  expect("this repo's own OWNERS.json passes the gate", own, true)
}

console.log(results.join('\n'))
console.log(failures ? `\n${failures} gate self-test(s) FAILED` : '\nAll gate self-tests passed.')
process.exit(failures ? 1 : 0)
