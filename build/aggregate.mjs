// Concatenate every registry/plugins/<id>.json into the single aggregated
// dist/index.json that TREK instances fetch, deterministically (plugins sorted
// by id, versions sorted newest-first), and write its SHA-256 sidecar.
//
// Also resolves each plugin's store cover image at its latest pinned commit and
// injects it as `screenshotUrl` (see resolveScreenshot). This makes a HEAD-ish
// request per plugin, so it needs network — same as publish.yml already has.
//
// Run by publish.yml on merge to main. Local: `node build/aggregate.mjs`.

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLUGINS_DIR = path.join(ROOT, 'registry', 'plugins')
const DIST_DIR = path.join(ROOT, 'dist')

function cmpSemverDesc(a, b) {
  const pa = a.split('-')[0].split('.').map(Number)
  const pb = b.split('-')[0].split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i]
  return 0
}

const RAW = (repo, commit, p) =>
  `https://raw.githubusercontent.com/${repo}/${commit}/${p.replace(/^\.?\//, '')}`

// Does `url` return an actual image? A ranged GET is enough to read the
// content-type without pulling the whole file.
async function resolvesToImage(url) {
  try {
    const r = await fetch(url, { method: 'GET', headers: { Range: 'bytes=0-2047' } })
    return r.ok && (r.headers.get('content-type') || '').startsWith('image/')
  } catch {
    return false
  }
}

// The store cover image for a plugin at its pinned commit. The TREK server would
// otherwise construct raw.../<commit>/docs/screenshot.png itself; we resolve it
// here so the catalog can also carry a fallback for entries that never committed
// that exact file. Order: the canonical, curated docs/screenshot.png first; then
// the first README image that actually resolves at the commit (data: URIs
// skipped) so a card is never blank when the repo clearly has screenshots.
// Returns null if nothing resolves — the server keeps its own guess then.
const _shotCache = new Map()
async function resolveScreenshot(repo, commit) {
  const key = `${repo}@${commit}`
  if (_shotCache.has(key)) return _shotCache.get(key)
  let result = null
  const canonical = RAW(repo, commit, 'docs/screenshot.png')
  if (await resolvesToImage(canonical)) {
    result = canonical
  } else {
    try {
      const res = await fetch(RAW(repo, commit, 'README.md'))
      if (res.ok) {
        const readme = await res.text()
        const md = [...readme.matchAll(/!\[[^\]]*\]\(\s*([^)\s]+)/g)].map((m) => m[1])
        const html = [...readme.matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1])
        const seen = new Set()
        for (const src of [...md, ...html]) {
          if (src.startsWith('data:') || seen.has(src)) continue
          seen.add(src)
          // absolute stays as-is (github.com/blob -> raw); relative resolves at the commit
          const url = /^https?:\/\//.test(src)
            ? (src.includes('github.com') && src.includes('/blob/')
                ? src.replace('github.com', 'raw.githubusercontent.com').replace('/blob/', '/')
                : src)
            : RAW(repo, commit, src)
          if (await resolvesToImage(url)) { result = url; break }
        }
      }
    } catch {
      // Network hiccup — leave null; the TREK server still falls back on its own.
    }
  }
  _shotCache.set(key, result)
  return result
}

const files = (await readdir(PLUGINS_DIR).catch(() => []))
  .filter((f) => f.endsWith('.json'))
  .sort()

// Download counts collected by scripts/collect-stats.mjs (stats.yml cron);
// merged here so instances get popularity with the same single catalog fetch.
const stats = await readFile(path.join(ROOT, 'registry', 'stats.json'), 'utf8')
  .then((s) => JSON.parse(s).plugins || {})
  .catch(() => ({}))

const plugins = []
for (const f of files) {
  const entry = JSON.parse(await readFile(path.join(PLUGINS_DIR, f), 'utf8'))
  entry.versions.sort((x, y) => cmpSemverDesc(x.version, y.version))
  if (typeof stats[entry.id] === 'number') entry.downloadCount = stats[entry.id]
  // The store shows the latest version's cover; resolve it once at that commit.
  const latest = entry.versions[0]
  if (latest) {
    const shot = await resolveScreenshot(entry.repo, latest.commitSha)
    if (shot) entry.screenshotUrl = shot
  }
  plugins.push(entry)
}
plugins.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

const registry = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  plugins,
}

const json = JSON.stringify(registry, null, 2) + '\n'
await mkdir(DIST_DIR, { recursive: true })
await writeFile(path.join(DIST_DIR, 'index.json'), json)
const sha = createHash('sha256').update(json).digest('hex')
await writeFile(path.join(DIST_DIR, 'index.json.sha256'), sha + '  index.json\n')

console.log(`aggregated ${plugins.length} plugin(s) -> dist/index.json (sha256 ${sha.slice(0, 12)}…)`)
