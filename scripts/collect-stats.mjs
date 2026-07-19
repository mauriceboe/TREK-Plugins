// Aggregate GitHub release-asset download counts per plugin into
// registry/stats.json. Run by stats.yml on a daily cron; aggregate.mjs merges
// the counts into dist/index.json as `downloadCount` so TREK instances get
// popularity for free with the catalog fetch — no telemetry involved.

import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'

const token = process.env.GITHUB_TOKEN
const headers = {
  'User-Agent': 'trek-plugins-stats',
  Accept: 'application/vnd.github+json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
}

const prev = existsSync('registry/stats.json')
  ? JSON.parse(readFileSync('registry/stats.json', 'utf8'))
  : { plugins: {} }

const entries = readdirSync('registry/plugins')
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(`registry/plugins/${f}`, 'utf8')))

const plugins = { ...prev.plugins }
let failed = 0
for (const entry of entries) {
  try {
    const res = await fetch(`https://api.github.com/repos/${entry.repo}/releases?per_page=100`, { headers })
    if (!res.ok) throw new Error(`releases ${res.status}`)
    const releases = await res.json()
    // Count the assets this entry actually points at. `pack --out` lets an author name the
    // artifact anything, so hardcoding "plugin.zip" silently reported zero forever for them.
    // The downloadUrl is the pinned truth — take its basename.
    const assetNames = new Set(
      (entry.versions || [])
        .map((v) => { try { return decodeURIComponent(new URL(v.downloadUrl).pathname.split('/').pop() || '') } catch { return '' } })
        .filter(Boolean),
    )
    if (!assetNames.size) assetNames.add('plugin.zip')
    const count = releases
      .flatMap((r) => r.assets || [])
      .filter((a) => assetNames.has(a.name))
      .reduce((sum, a) => sum + (a.download_count || 0), 0)
    plugins[entry.id] = count
    console.log(`${entry.id}: ${count}`)
  } catch (err) {
    // Keep the previous count rather than regressing on a transient API failure.
    failed++
    console.warn(`${entry.id}: ${err.message} (keeping ${plugins[entry.id] ?? 'none'})`)
  }
}

writeFileSync('registry/stats.json', JSON.stringify({ updatedAt: new Date().toISOString().slice(0, 10), plugins }, null, 2) + '\n')
console.log(`wrote registry/stats.json (${entries.length - failed}/${entries.length} fetched)`)
if (failed === entries.length && entries.length > 0) process.exit(1)
