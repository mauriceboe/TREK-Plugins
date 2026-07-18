// Regenerates scripts/lib/lucide-icon-names.mjs — the set of lucide icon names the
// entry gate validates a plugin's `icon` against.
//
// lucide is NOT a dependency of this repo: the name list is a checked-in snapshot and
// regenerating it is a rare maintenance step (bump it when TREK bumps lucide-react).
// Run it with lucide available, e.g.:
//
//   npm i --no-save lucide-react && node scripts/gen-lucide-icon-names.mjs
//
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let dynamicIconImports;
let version;
try {
  dynamicIconImports = require('lucide-react/dynamicIconImports.js');
  ({ version } = require('lucide-react/package.json'));
} catch {
  console.error('lucide-react is not installed here. Run:\n  npm i --no-save lucide-react && node scripts/gen-lucide-icon-names.mjs');
  process.exit(1);
}

const iconsByKebabName = dynamicIconImports.default ?? dynamicIconImports;
const toPascalCase = (kebab) =>
  kebab.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');

const names = Object.keys(iconsByKebabName).map(toPascalCase).sort();

const source = `// GENERATED — do not edit by hand.
// Every lucide icon name (lucide-react ${version}), the set TREK resolves a plugin's
// \`icon\` against at render time. The entry gate rejects a name outside this list:
// TREK would silently fall back to Blocks, so a typo is invisible in the store.
// Regenerate with: node scripts/gen-lucide-icon-names.mjs
export const LUCIDE_ICON_NAMES = new Set([
${names.map((n) => '  ' + JSON.stringify(n) + ',').join('\n')}
]);
`;

writeFileSync(join(here, 'lib', 'lucide-icon-names.mjs'), source);
console.log(`wrote ${names.length} icon names from lucide-react ${version}`);
