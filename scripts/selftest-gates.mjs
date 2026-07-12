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
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
      minTrekVersion: '3.3.0',
      nativeModules: false,
      signature: SIG,
      publishedAt: '2026-01-01T00:00:00Z',
    },
  ],
})

let failures = 0
const results = []

/** Run the validator against `entry` written as <id>.json; returns { ok, out }. */
function runGate(entry, { baseEntry: prev } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trek-selftest-'))
  try {
    // The downgrade guard reads the previous entry via `git show $BASE_SHA:<path>`, so the
    // fixture needs a real git repo with the previous entry committed at HEAD.
    const reg = path.join(dir, 'registry', 'plugins')
    mkdirSync(reg, { recursive: true })
    const file = path.join(reg, `${entry.id}.json`)
    const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })

    let env = { ...process.env, SKIP_NETWORK: '1' }
    if (prev) {
      git('init', '-q')
      git('config', 'user.email', 'selftest@example.com')
      git('config', 'user.name', 'selftest')
      writeFileSync(file, JSON.stringify(prev, null, 2))
      git('add', '-A')
      git('commit', '-qm', 'base')
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

// apiVersion is optional in the manifest (TREK and the SDK both default it to 1). The
// entry always carries 1. This used to fail parity with "manifest apiVersion undefined != 1".
{
  const e = baseEntry()
  expect('an entry whose manifest omits apiVersion passes (offline shape)', runGate(e), true)
}

console.log(results.join('\n'))
console.log(failures ? `\n${failures} gate self-test(s) FAILED` : '\nAll gate self-tests passed.')
process.exit(failures ? 1 : 0)
