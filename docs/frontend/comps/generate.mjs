#!/usr/bin/env node
// Regenerate the W8a reference comps.
//
//   node docs/frontend/comps/generate.mjs
//
// The four .html files are checked in and open standalone — no build step is needed to
// VIEW them. This script exists so the token block and the contrast table stay identical
// across all four files and so every printed ratio is computed rather than typed.
// It fails loudly if any (fg, bg) token pair misses its DESIGN §3.6 threshold.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAIRS, FAILING, r2 } from './lib/tokens.mjs';
import { pageTokens } from './lib/page-tokens.mjs';
import { pageHome } from './lib/page-home.mjs';
import { pageCockpit } from './lib/page-cockpit.mjs';
import { pageTranscript } from './lib/page-transcript.mjs';

const here = dirname(fileURLToPath(import.meta.url));

if (FAILING.length) {
  console.error(`\n§3.6 contrast gate FAILED — ${FAILING.length} of ${PAIRS.length} pairs:\n`);
  for (const p of FAILING) {
    console.error(`  ${p.label}\n    need ${p.need}:1 · light ${r2(p.light)} · dark ${r2(p.dark)}`);
  }
  console.error('\nFix the token in lib/tokens.mjs. Do not ship a failing swatch.\n');
  process.exit(1);
}

const files = [
  ['tokens.html', pageTokens()],
  ['home.html', pageHome()],
  ['cockpit.html', pageCockpit()],
  ['transcript.html', pageTranscript()],
];

for (const [name, html] of files) {
  // Self-containment guards: these comps must make zero network requests.
  for (const [re, why] of [
    [/<link[\s>]/i, 'a <link> element'],
    [/@font-face\s*\{/i, 'an @font-face rule'],
    [/@import\s/i, 'a CSS @import'],
    [/(?:href|src|action)\s*=\s*["']https?:/i, 'an absolute http(s) URL in an attribute'],
    [/\bsrc\s*=\s*["'](?!#)/i, 'an external src attribute'],
    [/url\(\s*["']?(?!#|data:)[a-z0-9./]/i, 'a CSS url() reference'],
    [/<iframe|<img|<audio|<video|<object|<embed/i, 'an external media element'],
  ]) {
    if (re.test(html)) throw new Error(`${name} contains ${why} — comps must be self-contained`);
  }
  writeFileSync(join(here, name), html);
  console.log(`  wrote ${name.padEnd(16)} ${(html.length / 1024).toFixed(1)} KiB`);
}

console.log(`\n§3.6 contrast gate: ${PAIRS.length} pairs checked, 0 failing.`);
