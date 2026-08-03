// Shared vitest setup. Kept minimal on purpose: §11.1 splits the suite into pure logic in
// the node environment and DOM behaviors under a per-file `// @vitest-environment jsdom`
// opt-in, and a heavyweight global setup would erase that split.
//
// The ONE global the split cannot do without is unmounting.
//
// `globals: false` (vite.config.ts) means React Testing Library's auto-cleanup never
// registers: it hooks a GLOBAL `afterEach`, and with globals off there is none. So every
// tree a test rendered stayed mounted for the rest of its file and through the jsdom
// teardown at the end of it — timers, rAF chains, observers and all. That is not a
// cosmetic leak: `@tanstack/react-virtual`'s `scrollToIndex` reschedules itself through
// `targetWindow.requestAnimationFrame` up to ten times and only stops when the virtualizer
// is torn down (`Virtualizer.cleanup()` nulls `targetWindow`, which every guard checks) —
// and the virtualizer is torn down only when React unmounts it. A file that never unmounts
// therefore hands live callbacks to a window vitest is about to dismantle, which is how a
// full run exits 1 with a post-teardown `ReferenceError: window is not defined` after every
// assertion has already passed.
//
// Unmounting after every test closes the whole class — for the virtualizer, for the rAF in
// `Cards.tsx`'s disclosure animation, for every `window.addEventListener` a feature installs
// — and it is imported lazily so the node-environment half of the suite never loads a DOM
// library it has no use for.

import { afterEach } from 'vitest'

/**
 * `CSS.escape`, which jsdom does not implement at all (there is no `CSS` global) and every
 * browser this product targets has had for a decade.
 *
 * React Aria's selection layer builds `[data-key="…"]` selectors through it
 * (`react-aria/…/selection/utils.mjs:22`), so without this the §16.3 listbox/combobox and
 * tab primitives throw on their first render UNDER TEST ONLY. Polyfilling the platform gap
 * is the honest fix: the alternative — avoiding the hooks §16.3 mandates because a test
 * environment is incomplete — would let the harness dictate the product.
 *
 * Implements the CSSOM `serialize an identifier` algorithm
 * (https://drafts.csswg.org/cssom/#serialize-an-identifier).
 */
if (typeof globalThis.CSS === 'undefined') {
  const escape = (value: string): string => {
    const string = String(value)
    if (string.length === 1 && string.charCodeAt(0) === 0x2d) return `\\${string}`
    let out = ''
    for (let index = 0; index < string.length; index++) {
      const code = string.charCodeAt(index)
      if (code === 0x0000) { out += '�'; continue }
      if (
        (code >= 0x0001 && code <= 0x001f) || code === 0x007f
        || (index === 0 && code >= 0x0030 && code <= 0x0039)
        || (index === 1 && code >= 0x0030 && code <= 0x0039 && string.charCodeAt(0) === 0x2d)
      ) {
        out += `\\${code.toString(16)} `
        continue
      }
      if (
        code >= 0x0080 || code === 0x002d || code === 0x005f
        || (code >= 0x0030 && code <= 0x0039)
        || (code >= 0x0041 && code <= 0x005a)
        || (code >= 0x0061 && code <= 0x007a)
      ) {
        out += string.charAt(index)
        continue
      }
      out += `\\${string.charAt(index)}`
    }
    return out
  }
  ;(globalThis as { CSS?: unknown }).CSS = { escape }
}

afterEach(async () => {
  if (typeof document === 'undefined') return
  const { cleanup } = await import('@testing-library/react')
  cleanup()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-theme-swapping')
  try { localStorage.clear(); sessionStorage.clear() } catch { /* node env */ }
})
