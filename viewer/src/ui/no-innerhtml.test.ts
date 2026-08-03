// §7.1.6 / §11.3 — the repo-enforced no-innerHTML rule, as a source grep with an EMPTY
// allowlist.
//
// The API returns JSON only and the SPA renders model output through React elements
// (§9.7 markdown, §9.8 ANSI), so hostile transcript content is never interpreted as HTML.
// That claim is only worth anything if nothing can quietly reintroduce an HTML sink, so
// the check lives here from the first unit rather than arriving with W10, when there
// would already be renderers to audit.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** Every HTML sink React or the DOM exposes. The allowlist is empty and stays empty. */
const SINKS = [
  /\bdangerouslySetInnerHTML\b/,
  /\.innerHTML\b/,
  /\.outerHTML\s*=/,
  /\binsertAdjacentHTML\b/,
  /\bdocument\.write\b/,
  /\bcreateContextualFragment\b/,
  /\bnew\s+Function\b/,
  /\beval\s*\(/,
]

/** This file names every sink in order to search for it, so it excludes itself. */
const SELF = 'no-innerhtml.test.ts'

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full))
    else if (/\.(ts|tsx)$/.test(entry) && entry !== SELF) out.push(full)
  }
  return out
}

const stripComments = (source: string) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

describe('§7.1.6 no-innerHTML', () => {
  const files = sourceFiles(SRC)

  it('finds the SPA sources at all', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('has zero HTML sinks anywhere under viewer/src', () => {
    const hits: string[] = []
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'))
      for (const sink of SINKS) {
        if (sink.test(source)) hits.push(`${file.slice(SRC.length)}: ${sink}`)
      }
    }
    expect(hits, `HTML sinks are forbidden — the allowlist is empty:\n${hits.join('\n')}`)
      .toEqual([])
  })

  it('renders SVG geometry from data, never from a markup string', () => {
    // The icon sprite is the one place a "just interpolate the path" shortcut is tempting.
    const icons = readFileSync(join(SRC, 'ui', 'icons.ts'), 'utf8')
    expect(icons).not.toMatch(/<(svg|path|circle|symbol)\b/)
  })
})
