// The viewer TOOLCHAIN is bound by the root invariant "Node >= 18.17" (README/engines,
// DESIGN §9.1's stack lives inside it). A viewer that cannot be installed, typechecked,
// built or tested on the minimum supported Node is not buildable at that version — the
// invariant is about the product, not about one process in it.
//
// This test walks the COMMITTED lockfile (not node_modules — §11.1 requires the viewer
// suite to run with no install present) and fails on any resolved package whose declared
// `engines.node` excludes 18.17.0. That is what caught @vitejs/plugin-react 5 (^20.19.0)
// and jsdom 27 (^20.19.0) in review; it is what keeps the next `npm update` from quietly
// re-breaking it.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const MIN_NODE = '18.17.0'
const lockPath = fileURLToPath(new URL('../package-lock.json', import.meta.url))
const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url))

interface LockEntry { engines?: { node?: string }; dev?: boolean; version?: string }

type Triple = [number, number, number]

const num = (part: string | undefined, fallback: number): number => {
  if (part == null || part === 'x' || part === 'X' || part === '*') return fallback
  const parsed = Number.parseInt(part, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

const cmp = (a: Triple, b: Triple): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

const parse = (version: string): Triple => {
  const m = /^v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?/.exec(version.trim())
  if (!m) throw new Error(`unparseable version: ${version}`)
  return [num(m[1], 0), num(m[2], 0), num(m[3], 0)]
}

/**
 * A deliberately small semver-range evaluator: `||` unions, whitespace-joined comparator
 * sets, and the `^ ~ >= > <= < =` operators plus bare/partial versions. That is the whole
 * grammar npm registry `engines.node` fields actually use; anything richer throws loudly
 * rather than being silently treated as satisfied.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version)
  return range.split('||').some((clause) => {
    const comparators = clause.trim().split(/\s+/).filter(Boolean)
    // An empty clause ("" or "*") admits everything.
    if (comparators.length === 0 || clause.trim() === '*') return true
    // ">= 14" tokenizes as [">=", "14"]; re-join a bare operator with its operand.
    const joined: string[] = []
    for (const token of comparators) {
      if (/^[<>=^~]+$/.test(token)) joined.push(token)
      else if (joined.length && /^[<>=^~]+$/.test(joined[joined.length - 1]!)) {
        joined[joined.length - 1] += token
      } else joined.push(token)
    }
    return joined.every((comparator) => {
      const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator)
      if (!m) throw new Error(`unparseable comparator: ${comparator} (in "${range}")`)
      const op = m[1] ?? '='
      const raw = m[2]!
      const target = parse(raw)
      const parts = raw.trim().split('.')
      const partial = parts.length < 3 || parts.some((p) => p === 'x' || p === 'X' || p === '*')
      switch (op) {
        case '>=': return cmp(v, target) >= 0
        case '>': return cmp(v, target) > 0
        case '<=': return cmp(v, target) <= 0
        case '<': return cmp(v, target) < 0
        case '^': {
          if (cmp(v, target) < 0) return false
          const ceiling: Triple = target[0] > 0
            ? [target[0] + 1, 0, 0]
            : target[1] > 0 ? [0, target[1] + 1, 0] : [0, 0, target[2] + 1]
          return cmp(v, ceiling) < 0
        }
        case '~': {
          if (cmp(v, target) < 0) return false
          return cmp(v, [target[0], target[1] + 1, 0]) < 0
        }
        default: {
          // "18" and "18.x" mean the 18 line; "18.17.0" means exactly that version.
          if (!partial) return cmp(v, target) === 0
          if (cmp(v, target) < 0) return false
          const ceiling: Triple = parts.length === 1 || parts[1] === 'x' || parts[1] === '*'
            ? [target[0] + 1, 0, 0]
            : [target[0], target[1] + 1, 0]
          return cmp(v, ceiling) < 0
        }
      }
    })
  })
}

describe('the semver-range evaluator this gate is built on', () => {
  it('reads the range shapes npm engines fields actually use', () => {
    expect(satisfies('18.17.0', '^18.0.0 || ^20.0.0 || >=22.0.0')).toBe(true)
    expect(satisfies('18.17.0', '^20.19.0 || ^22.12.0 || >=24.0.0')).toBe(false)
    expect(satisfies('18.17.0', '^20.19.0 || >=22.12.0')).toBe(false)
    expect(satisfies('18.17.0', '^14.18.0 || >=16.0.0')).toBe(true)
    expect(satisfies('18.17.0', '>=18')).toBe(true)
    expect(satisfies('18.17.0', '>= 14')).toBe(true)
    expect(satisfies('18.17.0', '>=20')).toBe(false)
    expect(satisfies('18.17.0', '18.x')).toBe(true)
    expect(satisfies('18.17.0', '18')).toBe(true)
    expect(satisfies('18.17.0', '20')).toBe(false)
    expect(satisfies('18.17.0', '>=12 <20')).toBe(true)
    expect(satisfies('18.17.0', '>=12 <18')).toBe(false)
    expect(satisfies('18.17.0', '~18.17.0')).toBe(true)
    expect(satisfies('18.16.0', '>=18.17')).toBe(false)
    expect(satisfies('18.17.0', '*')).toBe(true)
  })
})

describe('the viewer toolchain runs on the minimum supported Node (>= 18.17)', () => {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
    packages: Record<string, LockEntry>
  }

  it('declares the floor in package.json#engines', () => {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { engines?: { node?: string } }
    expect(pkg.engines?.node).toBe('>=18.17')
  })

  it('has no resolved dependency whose engines.node excludes 18.17.0', () => {
    const offenders: string[] = []
    for (const [name, entry] of Object.entries(lock.packages)) {
      const range = entry?.engines?.node
      if (!range || name === '') continue
      if (!satisfies(MIN_NODE, range)) {
        offenders.push(`${name}@${entry.version ?? '?'} requires node ${range}`)
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('pins the two packages whose next major drops Node 18', () => {
    // Named explicitly so a bump reads as a deliberate act with this test's name on it.
    const react = lock.packages['node_modules/@vitejs/plugin-react']
    const jsdom = lock.packages['node_modules/jsdom']
    expect(react?.version?.startsWith('4.')).toBe(true)
    expect(jsdom?.version?.startsWith('26.')).toBe(true)
  })
})
