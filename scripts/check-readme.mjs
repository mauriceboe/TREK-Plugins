// TREK-Plugins registry: README quality gate.
// Fetches a submitted plugin's README.md at its pinned commit and enforces that
// it is genuinely filled in — real prose, the docs/screenshot.png store cover,
// all required sections, no template placeholders, and permission parity.
//
// Usage (from validate.yml, per changed registry/plugins/<id>.json):
//   node scripts/check-readme.mjs <owner/repo> <commitSha> <path-to-manifest.json>
//
// Exit 0 = pass, exit 1 = fail (with a human-readable reason list).

import { readFile } from 'node:fs/promises'

const [repo, commitSha, manifestPath] = process.argv.slice(2)
if (!repo || !commitSha || !manifestPath) {
  console.error('usage: check-readme.mjs <owner/repo> <commitSha> <manifest.json>')
  process.exit(2)
}

const RAW = (p) => `https://raw.githubusercontent.com/${repo}/${commitSha}/${p.replace(/^\.?\//, '')}`
const REQUIRED_HEADINGS = ['What it does', 'Screenshots', 'Permissions', 'Setup']
const PLACEHOLDER_PATTERNS = [
  /\{\{[^}]*\}\}/,            // any leftover {{ token }}
  /\bREPLACE_ME\b/i,
  /\bDescribe (what|the)\b/i, // template prose that was never edited
  /\byour-name\/trek-plugin/i,
]
const MIN_PROSE_CHARS = 400

const fail = []
const note = (m) => fail.push(m)

// 1. README must exist at repo root (case-insensitive on GitHub, but require README.md)
let readme
try {
  const res = await fetch(RAW('README.md'))
  if (!res.ok) throw new Error(String(res.status))
  readme = await res.text()
} catch {
  console.error('FAIL: README.md is missing at the repo root (commit ' + commitSha.slice(0, 8) + ').')
  process.exit(1)
}

// 2. Required headings present
const headings = [...readme.matchAll(/^#{1,6}\s+(.+?)\s*(?:<!--.*)?$/gm)].map((m) => m[1].toLowerCase())
for (const h of REQUIRED_HEADINGS) {
  if (!headings.some((got) => got.includes(h.toLowerCase()))) note(`missing required section: "## ${h}"`)
}

// 3. No leftover template placeholders
for (const re of PLACEHOLDER_PATTERNS) {
  const hit = readme.match(re)
  if (hit) note(`README still contains an unfilled template placeholder: "${hit[0]}"`)
}

// 4. Real prose length — strip html comments, code fences, images, links, headings, tables
const prose = readme
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/```[\s\S]*?```/g, '')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/^#{1,6}\s+.*$/gm, '')
  .replace(/^\s*\|.*$/gm, '')
  .replace(/[#>*_`|-]/g, '')
  .replace(/\s+/g, ' ')
  .trim()
if (prose.length < MIN_PROSE_CHARS) {
  note(`README has too little written content (${prose.length} chars, need >= ${MIN_PROSE_CHARS}). Fill in the sections.`)
}

// 5. The store cover: docs/screenshot.png must exist at the pinned commit and be
// a real image. The TREK store loads exactly this path at the reviewed commit
// (raw.../<commit>/docs/screenshot.png), so a README that only links other image
// names renders a blank card despite "having screenshots" — enforce the exact
// file the store reads, not just any image.
try {
  const r = await fetch(RAW('docs/screenshot.png'), { method: 'GET', headers: { Range: 'bytes=0-2047' } })
  const ct = r.headers.get('content-type') || ''
  if (!r.ok || !ct.startsWith('image/')) {
    note(`docs/screenshot.png does not resolve to an image at ${commitSha.slice(0, 8)} (got ${r.status} ${ct || 'no content-type'}). This exact file is the store cover — run \`npx trek-plugin shot\` to generate it, commit it, and re-pin the entry to that commit.`)
  }
} catch {
  note(`docs/screenshot.png is unreachable at ${commitSha.slice(0, 8)}. This exact file is the store cover — run \`npx trek-plugin shot\` to generate it and commit it.`)
}

// 6. Permission parity — every manifest permission must be mentioned in the README
try {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const perms = Array.isArray(manifest.permissions) ? manifest.permissions : []
  const lower = readme.toLowerCase()
  const undocumented = perms.filter((p) => !lower.includes(p.toLowerCase()))
  if (undocumented.length) {
    note(`these declared permissions are not explained in the README "## Permissions" section: ${undocumented.join(', ')}`)
  }
} catch (e) {
  note('could not read/parse the manifest for permission parity: ' + e.message)
}

if (fail.length) {
  console.error('README quality gate FAILED for ' + repo + ':')
  for (const f of fail) console.error('  - ' + f)
  console.error('\nSee README.template.md for the required structure.')
  process.exit(1)
}
console.log('README quality gate passed for ' + repo + '.')
