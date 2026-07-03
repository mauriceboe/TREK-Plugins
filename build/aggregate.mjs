// Concatenate every registry/plugins/<id>.json into the single aggregated
// dist/index.json that TREK instances fetch, deterministically (plugins sorted
// by id, versions sorted newest-first), and write its SHA-256 sidecar.
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

const files = (await readdir(PLUGINS_DIR).catch(() => []))
  .filter((f) => f.endsWith('.json'))
  .sort()

const plugins = []
for (const f of files) {
  const entry = JSON.parse(await readFile(path.join(PLUGINS_DIR, f), 'utf8'))
  entry.versions.sort((x, y) => cmpSemverDesc(x.version, y.version))
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
