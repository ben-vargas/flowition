import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const viewer = resolve(here, '../../..')
const pkg = JSON.parse(readFileSync(resolve(viewer, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>
}
const lock = JSON.parse(readFileSync(resolve(viewer, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string; integrity?: string; link?: boolean }>
}

/**
 * W12 additions: §16.3 adopts hooks-level @react-aria packages for the interactive
 * primitives, and §16.7 requires every DIRECT security-sensitive rendering dependency to
 * carry an EXACT version in package.json (a caret range authorizes drift the next time the
 * lockfile is regenerated). The allowlist below is therefore closed in both directions: a
 * new direct dependency fails this test until someone writes it down with its reason, and a
 * caret on any of them fails it too.
 */
const REACT_ARIA = {
  '@react-aria/combobox': '3.16.1',
  '@react-aria/dialog': '3.6.1',
  '@react-aria/focus': '3.22.1',
  '@react-aria/listbox': '3.16.1',
  '@react-aria/overlays': '3.32.1',
  '@react-aria/tabs': '3.12.1',
} as const

/**
 * The state half of the same §16.3 adoption. `useListBox`, `useComboBox` and `useTabList`
 * are specified as hooks over a react-stately collection — the collection builder and the
 * selection manager ARE the keyboard-navigation behavior §16.3 names, and the aria hooks do
 * not work without them. Pinned exactly for the same reason as the aria half (§16.7).
 */
const REACT_STATELY = {
  '@react-stately/collections': '3.13.1',
  '@react-stately/combobox': '3.14.1',
  '@react-stately/list': '3.14.1',
  '@react-stately/tabs': '3.9.1',
} as const

describe('§16.7 package graph', () => {
  it('react-markdown is exact and is W10’s only new direct runtime dependency', () => {
    expect(pkg.dependencies['react-markdown']).toBe('10.1.0')
    expect(pkg.dependencies['react-markdown']).not.toMatch(/^[~^]/)
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      ...Object.keys(REACT_ARIA), ...Object.keys(REACT_STATELY),
      '@tanstack/react-virtual', 'react', 'react-dom', 'react-markdown',
    ].sort())
  })

  it('every @react-aria / @react-stately hook package is pinned EXACTLY (§16.3 / §16.7) — W12', () => {
    for (const [name, version] of Object.entries({ ...REACT_ARIA, ...REACT_STATELY })) {
      expect(pkg.dependencies[name], `${name} must be a direct dependency`).toBe(version)
      expect(pkg.dependencies[name]).not.toMatch(/^[~^]/)
      expect(lock.packages[`node_modules/${name}`]?.version).toBe(version)
    }
  })

  it('the component KIT never enters the tree — hooks only (§16.3)', () => {
    // "Borrow behavior, not appearance: no @adobe/react-spectrum, no component kit, no kit
    // CSS." The scoped hook packages are thin re-exports over the `react-aria` monopackage,
    // which is behavior-only; the Spectrum packages are the styled kit and are the thing
    // §16.3 forbids. This asserts the boundary rather than trusting a review to hold it.
    const names = Object.keys(lock.packages)
      .map((path) => path.slice(path.lastIndexOf('node_modules/') + 13))
    for (const forbidden of names.filter((name) => name.startsWith('@adobe/'))) {
      throw new Error(`${forbidden} is a component kit — §16.3 admits hooks only`)
    }
    expect(names).not.toContain('@react-spectrum/theme-default')
  })

  it('forbidden raw-HTML packages cannot enter the resolved tree', () => {
    const names = Object.keys(lock.packages).map((path) => path.slice(path.lastIndexOf('node_modules/') + 13))
    expect(names).not.toContain('rehype-raw')
  })

  it('the direct renderer and every resolved registry package are integrity pinned', () => {
    expect(lock.packages['node_modules/react-markdown']?.version).toBe('10.1.0')
    expect(lock.packages['node_modules/react-markdown']?.integrity).toMatch(/^sha512-/)
    for (const [path, entry] of Object.entries(lock.packages)) {
      if (!path.startsWith('node_modules/') || entry.link) continue
      expect(entry.integrity, `${path} is not integrity pinned`).toMatch(/^sha512-/)
    }
  })

  it('keeps the shipped viewer inside the P10 bundle budget', () => {
    const dist = resolve(viewer, 'dist')
    const jsGzip = gzipSync(readFileSync(resolve(dist, 'app.js'))).byteLength
    const cssGzip = gzipSync(readFileSync(resolve(dist, 'app.css'))).byteLength
    const fonts = readdirSync(resolve(dist, 'fonts'))
      .filter((name) => name.endsWith('.woff2'))
      .reduce((bytes, name) => bytes + statSync(resolve(dist, 'fonts', name)).size, 0)

    expect(jsGzip, `app.js is ${jsGzip} bytes gzip; app.css is ${cssGzip} bytes gzip`)
      .toBeLessThanOrEqual(250 * 1024)
    expect(fonts).toBeLessThanOrEqual(300 * 1024)
  })
})
