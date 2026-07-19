// TREK-Plugins registry: entry validation gate.
// Validates one registry/plugins/<id>.json: schema, id/filename, owner binding,
// homoglyph/mixed-script, signature integrity, and — over the network — that the
// release exists, the manifest matches, the artifact's SHA-256 matches the pin, the
// author signature verifies, and the artifact contains no native binaries.
//
// Usage:  node scripts/validate-entry.mjs registry/plugins/<id>.json
// Env:    ALLOW_OWNER_CHANGE=1    allow rebinding an existing id to a new owner
//         ALLOW_KEY_CHANGE=1      allow rotating a published plugin's signing key
//         GITHUB_TOKEN            raises GitHub API rate limits (optional)
//         SKIP_NETWORK=1          offline mode (schema/format checks only)
//         BASE_SHA                git ref of the PR base, for the signing-downgrade guard

import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { verifyAuthorSignature, checkSignatureShape, SignatureError } from './lib/verify-signature.mjs'
import { satisfiableRange, trekFloor } from './lib/trek-range.mjs'
import { LUCIDE_ICON_NAMES } from './lib/lucide-icon-names.mjs'

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

// --- icon ---
// TREK resolves `icon` against lucide at render time and falls back to Blocks on a name
// it can't find, so a typo is invisible in the store — it just looks like every other
// plugin. The schema pins the shape; this pins the name to one lucide actually has.
if (entry.icon && !LUCIDE_ICON_NAMES.has(entry.icon)) {
  bad(`icon "${entry.icon}" is not a lucide icon name — TREK would fall back to Blocks. See https://lucide.dev/icons`)
}

// --- downloadCount is computed, not submitted ---
// build/aggregate.mjs injects it into dist/index.json from registry/stats.json; only
// registry.schema.json's published-entry shape knows the field, so the entry schema already
// rejects it as an unknown property. This check exists for the error message: in a
// registry/plugins file it would be a hand-picked popularity number that flows straight
// into the index whenever the stats cron has no count to overwrite it with.
if ('downloadCount' in entry) {
  bad('downloadCount is computed by CI (build/aggregate.mjs, from registry/stats.json) and lives only in dist/index.json — remove it from the entry')
}

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

// --- signature shape (offline) ---
// A key without a signature, or a signature without a key, passes the schema but is
// refused by TREK at install time. Catch it here rather than merging a dead entry.
for (const p of checkSignatureShape(entry)) bad(p)

// --- signing-downgrade guard (offline) ---
// TREK pins the author key on first install (TOFU). Once a plugin has shipped signed,
// an unsigned update — or one signed with a different key — is REFUSED on every
// instance that already has it (registry.service.ts: "this plugin was signed before
// but the update is unsigned — refusing"). Nothing else in this repo notices, so a
// downgrade merges green and then bricks the update for every existing user.
//
// Compare against the entry as it exists on the PR base. `git show` fails for a
// brand-new plugin (no previous entry) — that's the opt-in case, and it's fine.
const baseSha = process.env.BASE_SHA
let previous = null
if (baseSha) {
  // Resolve against the repo the ENTRY lives in, not the one this script lives in — they
  // are the same in CI, but tying the lookup to the entry keeps the guard testable.
  const entryDir = path.dirname(path.resolve(entryPath))
  const git = (...a) => execFileSync('git', a, { cwd: entryDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  let repoRoot = null
  try { repoRoot = git('rev-parse', '--show-toplevel') } catch { repoRoot = null } // not a git checkout — nothing to compare
  if (repoRoot) {
    // git addresses tree paths with '/', but path.relative yields '\' on Windows, so
    // `git show <sha>:registry\plugins\x.json` fails there. That failure used to be
    // swallowed as "new plugin", silently disabling the whole downgrade guard (and the
    // test:gates self-tests) on a maintainer's own machine.
    const rel = path.relative(repoRoot, path.resolve(entryPath)).split(path.sep).join('/')
    let baseText = null
    try {
      baseText = git('show', `${baseSha}:${rel}`)
    } catch (err) {
      // A path simply absent from the base tree is a brand-new plugin — the opt-in case,
      // and fine. ANY other git failure (bad base sha, IO, shallow clone) must NOT wave
      // the guard through, or a signed plugin could ship an unsigned or re-keyed update
      // unnoticed. Fail closed on the unexpected instead of skipping the check.
      const msg = String(err.stderr || err.message || '')
      const isNewEntry = /exists on disk, but not in|does not exist in/i.test(msg)
      if (!isNewEntry) {
        bad(`could not read the base revision of ${rel} for the signing-downgrade guard (${msg.split('\n')[0] || 'git error'}); refusing rather than skipping the check`)
      } else {
        // Absent from the base TREE is not the same as never published: delete-then-re-add
        // would otherwise reset the baseline, letting an unsigned or re-keyed RESURRECTION
        // of a previously-signed plugin through as "brand new" — the exact downgrade the
        // guard exists to stop, laundered through two PRs instead of one. So when the path
        // is missing at BASE_SHA, look for its last deletion in the base branch's HISTORY
        // and treat the entry as it stood just before that as the baseline. Needs full
        // history — validate.yml checks out with fetch-depth: 0.
        //
        // Fail-closed here too: a deletion we can see but whose prior state we cannot read
        // is a refusal, not a skip.
        try {
          // `:(top)` because a `git log` pathspec is cwd-relative and the guard runs git from
          // the entry's directory — rel is root-relative, like every other tree path here.
          const deletedAt = git('log', '--diff-filter=D', '--format=%H', '-1', baseSha, '--', `:(top)${rel}`)
          if (deletedAt) baseText = git('show', `${deletedAt}^:${rel}`)
        } catch (err2) {
          const msg2 = String(err2.stderr || err2.message || '')
          bad(`"${entry.id}" is absent at the PR base but its history could not be checked for a prior (deleted) publication (${msg2.split('\n')[0] || 'git error'}); refusing rather than skipping the signing-downgrade guard`)
        }
      }
    }
    if (baseText) {
      try { previous = JSON.parse(baseText) }
      catch (e) { bad(`the base revision of ${rel} is not valid JSON, so the signing-downgrade guard cannot run: ${e.message}`) }
    }
  }
}

/**
 * Is this the version the PR is PUBLISHING (as opposed to one already on the registry)?
 *
 * It matters because rules that are new can only be applied to new versions: an entry file
 * carries every version ever published, and their manifests sit at commits that predate the
 * rule. Demanding a `trek` range from all of them would make a routine "add v2.0.0" PR fail
 * on v1.0.0's two-year-old commit, which the author cannot now change.
 *
 * With a PR base we know exactly which versions are new. Without one (a local run), fall back
 * to the newest — versions are newest-first by convention, and it is what validate.yml already
 * treats as "the version being published" when it grades the README.
 */
const publishedBefore = new Set((previous?.versions ?? []).map((v) => v.version))
const isNewlyPublished = (v) => (previous ? !publishedBefore.has(v.version) : v === entry.versions?.[0])

if (baseSha) {
  if (previous?.authorPublicKey) {
    if (!entry.authorPublicKey) {
      bad(`"${entry.id}" was published signed but this entry drops authorPublicKey — TREK refuses an unsigned update to a signed plugin, which would break every existing install`)
    } else if (previous.authorPublicKey !== entry.authorPublicKey && process.env.ALLOW_KEY_CHANGE !== '1') {
      bad(`"${entry.id}" changes its authorPublicKey — TREK refuses a key rotation until an admin re-trusts the plugin. Key changes need a maintainer override.`)
    }
    // Every-version-signed is enforced for ALL signed entries by checkSignatureShape
    // above — including a first signed publish, which reaches this block with no base to
    // compare against — so it no longer needs its own loop here.
  }
}

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
        // apiVersion is optional in the manifest: TREK defaults it to 1 at install and the
        // SDK defaults it to 1 when building the entry. Compare the DEFAULTED values, or a
        // manifest that legally omits it fails with "manifest apiVersion undefined != entry 1".
        const mApiVersion = m.apiVersion ?? 1
        if (mApiVersion !== v.apiVersion) bad(`${v.version}: manifest apiVersion ${mApiVersion} != entry ${v.apiVersion}`)
        if (m.nativeModules === true) bad(`${v.version}: manifest declares nativeModules:true — native modules are forbidden in v1`)

        // TREK host-version range. TREK gates installs AND activation on this: a plugin whose
        // manifest declares no satisfiable range cannot be installed at all, and one whose range
        // excludes the running TREK is refused. So an entry that lies about it — or omits it —
        // merges green here and is then uninstallable on every instance.
        //
        // Required only on the version being published (see isNewlyPublished): the older versions
        // in this file point at commits whose manifests predate the field.
        const mTrek = typeof m.trek === 'string' ? m.trek.trim() : ''
        const mTrekOk = satisfiableRange(mTrek)
        const isNew = isNewlyPublished(v)

        if (isNew && !mTrekOk) {
          bad(
            mTrek
              ? `${v.version}: manifest "trek" is not a satisfiable semver range: "${mTrek}" — TREK will refuse to install this plugin`
              : `${v.version}: manifest declares no "trek" version range — TREK will refuse to install this plugin. Add e.g. "trek": ">=3.2.0 <4.0.0"`,
          )
        }
        if (v.trek && !mTrekOk) {
          bad(`${v.version}: entry declares trek "${v.trek}" but the manifest at ${v.commitSha.slice(0, 8)} declares no usable range`)
        }
        // Parity + an honest floor — but only for the version being published, or an older one
        // whose entry block already carries the field. An older version that predates `trek` in
        // the ENTRY is grandfathered: its manifest may well declare a range (the SDK has always
        // required one to build an entry), and re-deriving it now would fail a routine
        // "add v2.0.0" PR on a v1.0.0 block nobody is touching.
        if (mTrekOk && (isNew || v.trek !== undefined)) {
          if (v.trek !== mTrek) bad(`${v.version}: manifest trek "${mTrek}" != entry trek "${v.trek ?? '(absent)'}"`)
          // minTrekVersion is DEPRECATED: `trek` says the same thing and more, so a new entry
          // simply omits it. It is only checked when present — an entry that still carries one
          // (every entry published before `trek` existed) must not disagree with its own range,
          // because a TREK too old to read `trek` gates on the floor and nothing else.
          const floor = trekFloor(mTrek)
          if (v.minTrekVersion != null && v.minTrekVersion !== floor) {
            bad(`${v.version}: entry minTrekVersion "${v.minTrekVersion}" != the lower bound of trek "${mTrek}" (${floor}) — they must agree, or drop minTrekVersion (deprecated; \`trek\` supersedes it)`)
          }
        }
        // egress presence when http:outbound declared. An empty egress[] is legal ONLY
        // for an operatorEgress plugin, whose hosts an admin supplies after install.
        const perms = Array.isArray(m.permissions) ? m.permissions : []
        if (perms.some((p) => p === 'http:outbound' || p.startsWith('http:outbound:'))) {
          const egress = Array.isArray(m.egress) ? m.egress : []
          if (!egress.length && m.operatorEgress !== true) {
            bad(`${v.version}: http:outbound declared but egress[] is empty (set operatorEgress: true if the hosts are admin-supplied)`)
          }
          if (egress.includes('*')) bad(`${v.version}: egress[] must not contain a bare "*" wildcard`)
        }
        // operatorEgress parity. This flag says the manifest's egress[] is NOT the plugin's
        // full network reach — an admin may add hosts after install (a self-hosted Gotify,
        // an ntfy). Mirroring it onto the entry, and pinning it here, means an entry can
        // never UNDERSTATE the reach of the code at the commit it points to.
        const mOperatorEgress = m.operatorEgress === true
        const vOperatorEgress = v.operatorEgress === true
        if (mOperatorEgress !== vOperatorEgress) {
          bad(`${v.version}: manifest operatorEgress ${mOperatorEgress} != entry ${vOperatorEgress}`)
        }
        if (mOperatorEgress && !perms.some((p) => p === 'http:outbound' || p.startsWith('http:outbound:'))) {
          bad(`${v.version}: operatorEgress declared without an http:outbound permission`)
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

      // Author signature over the artifact bytes. sha256 proves the bytes are what the
      // REGISTRY vouches for; the signature proves they came from the AUTHOR's key. TREK
      // verifies this at install and aborts on a mismatch — so a bad signature merged here
      // is an entry nobody can install. We already have the bytes; no extra download.
      if (v.signature && entry.authorPublicKey) {
        try {
          if (!verifyAuthorSignature(buf, v.signature, entry.authorPublicKey)) {
            bad(`${v.version}: author signature does not verify against authorPublicKey — TREK will refuse this artifact`)
          }
        } catch (e) {
          if (e instanceof SignatureError) bad(`${v.version}: signature/key is malformed: ${e.message}`)
          else throw e
        }
      }

      await writeFile(file, buf)
      // list entries (zip via unzip -l, tar.gz via tar -tzf) and scan for native binaries / lifecycle scripts
      const isZip = buf[0] === 0x50 && buf[1] === 0x4b
      let listing = ''
      try {
        listing = isZip
          ? (await pexec('unzip', ['-l', file])).stdout
          : (await pexec('tar', ['-tzf', file])).stdout
      } catch (e) { bad(`${v.version}: could not list archive (${isZip ? 'zip' : 'tar.gz'}): ${e.message}`) }
      // Anchor on a path boundary, not a literal slash: `binding.gyp` and `prebuilds/` at the
      // ARCHIVE ROOT have no leading slash and slipped straight through the old patterns.
      if (/\.node(\s|$)/m.test(listing) || /(^|[/\s])binding\.gyp(\s|$)/m.test(listing) || /(^|[/\s])prebuilds?\//m.test(listing)) {
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
