// TREK-Plugins registry: entry validation gate.
// Validates one registry/plugins/<id>.json: schema, id/filename, owner binding,
// homoglyph/mixed-script, and — over the network — that the release exists, the
// manifest matches, the artifact's SHA-256 matches the pin, and the artifact
// contains no native binaries.
//
// Usage:  node scripts/validate-entry.mjs registry/plugins/<id>.json
// Env:    ALLOW_OWNER_CHANGE=1    allow rebinding an existing id to a new owner
//         GITHUB_TOKEN            raises GitHub API rate limits (optional)
//         SKIP_NETWORK=1          offline mode (schema/format checks only)

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const pexec = promisify(execFile)
const entryPath = process.argv[2]
if (!entryPath) { console.error('usage: validate-entry.mjs registry/plugins/<id>.json'); process.exit(2) }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fail = []
const bad = (m) => fail.push(m)

const raw = await readFile(entryPath, 'utf8')
let entry
try { entry = JSON.parse(raw) } catch (e) { console.error('FAIL: not valid JSON: ' + e.message); process.exit(1) }

// --- schema ---
const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)
const schema = JSON.parse(await readFile(path.join(ROOT, 'schema', 'plugin-entry.schema.json'), 'utf8'))
const validate = ajv.compile(schema)
if (!validate(entry)) for (const e of validate.errors) bad(`schema: ${e.instancePath || '/'} ${e.message}`)

// --- id === filename ---
const fileId = path.basename(entryPath).replace(/\.json$/, '')
if (entry.id && entry.id !== fileId) bad(`id "${entry.id}" must equal filename "${fileId}"`)

// --- homoglyph / mixed-script name ---
// Reject a name that mixes Latin with Cyrillic/Greek look-alikes (spoofing).
if (entry.name) {
  const hasLatin = /[A-Za-z]/.test(entry.name)
  const hasConfusable = /[Ѐ-ӿͰ-Ͽ]/.test(entry.name) // Cyrillic / Greek
  if (hasLatin && hasConfusable) bad(`name "${entry.name}" mixes Latin with Cyrillic/Greek characters (possible homoglyph spoof)`)
}

// --- owner / repo binding ---
const ownersPath = path.join(ROOT, 'OWNERS.json')
const owners = JSON.parse(await readFile(ownersPath, 'utf8').catch(() => '{"plugins":{}}'))
const repoOwner = (entry.repo || '').split('/')[0]
const bound = owners.plugins?.[entry.id]
if (bound) {
  if (bound.boundOwner !== repoOwner && process.env.ALLOW_OWNER_CHANGE !== '1') {
    bad(`id "${entry.id}" is bound to owner "${bound.boundOwner}"; this entry points at "${repoOwner}". Owner changes need a maintainer override.`)
  }
} // new id: publish.yml records the binding on merge.

// --- per-version network checks ---
const ghHeaders = { 'User-Agent': 'trek-plugins-ci', Accept: 'application/vnd.github+json' }
if (process.env.GITHUB_TOKEN) ghHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

if (process.env.SKIP_NETWORK !== '1' && entry.repo && Array.isArray(entry.versions)) {
  for (const v of entry.versions) {
    // version == manifest.version, checked via manifest parity below
    // 1. tag exists and points at commitSha
    try {
      const r = await fetch(`https://api.github.com/repos/${entry.repo}/git/refs/tags/${encodeURIComponent(v.gitTag)}`, { headers: ghHeaders })
      if (!r.ok) { bad(`${v.version}: tag ${v.gitTag} not found (${r.status})`); continue }
      const ref = await r.json()
      // ref.object.sha may be the tag object (annotated) or the commit (lightweight); resolve annotated
      let sha = ref.object?.sha
      if (ref.object?.type === 'tag') {
        const tr = await fetch(`https://api.github.com/repos/${entry.repo}/git/tags/${sha}`, { headers: ghHeaders })
        if (tr.ok) sha = (await tr.json()).object?.sha
      }
      if (sha && sha !== v.commitSha) bad(`${v.version}: tag ${v.gitTag} points at ${sha?.slice(0, 8)}, entry pins ${v.commitSha.slice(0, 8)}`)
    } catch (e) { bad(`${v.version}: tag check failed: ${e.message}`) }

    // 2. manifest parity at the pinned commit
    try {
      const mr = await fetch(`https://raw.githubusercontent.com/${entry.repo}/${v.commitSha}/trek-plugin.json`, { headers: { 'User-Agent': 'trek-plugins-ci' } })
      if (!mr.ok) { bad(`${v.version}: trek-plugin.json not found at ${v.commitSha.slice(0, 8)} (${mr.status})`) }
      else {
        const m = JSON.parse(await mr.text())
        if (m.id !== entry.id) bad(`${v.version}: manifest id "${m.id}" != entry id "${entry.id}"`)
        if (m.version !== v.version) bad(`${v.version}: manifest version "${m.version}" != entry version "${v.version}"`)
        if (m.type !== entry.type) bad(`${v.version}: manifest type "${m.type}" != entry type "${entry.type}"`)
        if (m.apiVersion !== v.apiVersion) bad(`${v.version}: manifest apiVersion ${m.apiVersion} != entry ${v.apiVersion}`)
        if (m.nativeModules === true) bad(`${v.version}: manifest declares nativeModules:true — native modules are forbidden in v1`)
        // egress presence when http:outbound declared
        const perms = Array.isArray(m.permissions) ? m.permissions : []
        if (perms.some((p) => p === 'http:outbound' || p.startsWith('http:outbound:'))) {
          const egress = Array.isArray(m.egress) ? m.egress : []
          if (!egress.length) bad(`${v.version}: http:outbound declared but egress[] is empty`)
          if (egress.includes('*')) bad(`${v.version}: egress[] must not contain a bare "*" wildcard`)
        }
        // dependency parity: the enriched entry must mirror the manifest so TREK can
        // resolve deps from the index before downloading.
        const normAddons = (a) => (Array.isArray(a) ? [...a].map(String).sort() : [])
        if (JSON.stringify(normAddons(m.requiredAddons)) !== JSON.stringify(normAddons(v.requiredAddons))) {
          bad(`${v.version}: manifest requiredAddons != entry requiredAddons`)
        }
        const normDeps = (d) => (Array.isArray(d) ? d.map((x) => `${x?.id}@${x?.version}`).sort() : [])
        if (JSON.stringify(normDeps(m.pluginDependencies)) !== JSON.stringify(normDeps(v.pluginDependencies))) {
          bad(`${v.version}: manifest pluginDependencies != entry pluginDependencies`)
        }
      }
    } catch (e) { bad(`${v.version}: manifest parity failed: ${e.message}`) }

    // 3. artifact SHA-256 + native-binary scan
    let tmp
    try {
      tmp = await mkdtemp(path.join(tmpdir(), 'trekp-'))
      const file = path.join(tmp, 'artifact')
      const dr = await fetch(v.downloadUrl, { redirect: 'follow', headers: { 'User-Agent': 'trek-plugins-ci' } })
      if (!dr.ok) { bad(`${v.version}: download failed (${dr.status}) ${v.downloadUrl}`); continue }
      const buf = Buffer.from(await dr.arrayBuffer())
      if (buf.length > v.size + 4096) bad(`${v.version}: artifact is larger (${buf.length}) than declared size (${v.size})`)
      const sha = createHash('sha256').update(buf).digest('hex')
      if (sha !== v.sha256) bad(`${v.version}: SHA-256 mismatch — downloaded ${sha.slice(0, 12)}…, entry pins ${v.sha256.slice(0, 12)}…`)
      await writeFile(file, buf)
      // list entries (zip via unzip -l, tar.gz via tar -tzf) and scan for native binaries / lifecycle scripts
      const isZip = buf[0] === 0x50 && buf[1] === 0x4b
      let listing = ''
      try {
        listing = isZip
          ? (await pexec('unzip', ['-l', file])).stdout
          : (await pexec('tar', ['-tzf', file])).stdout
      } catch (e) { bad(`${v.version}: could not list archive (${isZip ? 'zip' : 'tar.gz'}): ${e.message}`) }
      if (/\.node(\s|$)/m.test(listing) || /\/binding\.gyp(\s|$)/m.test(listing) || /\/prebuilds?\//.test(listing)) {
        bad(`${v.version}: artifact contains native binaries (.node / binding.gyp / prebuilds) — forbidden in v1`)
      }
    } catch (e) { bad(`${v.version}: artifact check failed: ${e.message}`) }
    finally { if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => {}) }
  }
}

if (fail.length) {
  console.error(`Entry validation FAILED for ${entryPath}:`)
  for (const f of fail) console.error('  - ' + f)
  process.exit(1)
}
console.log(`Entry validation passed for ${entry.id}.`)
