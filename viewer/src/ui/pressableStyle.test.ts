// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'

import { PRESSABLE_ATTRIBUTE, PRESSABLE_STYLE_ID, claimPressableStyleSlot } from './pressableStyle.js'

const here = dirname(fileURLToPath(import.meta.url))
const viewer = resolve(here, '../..')

/**
 * The §7.1.4 gap the panel found: react-aria injects a `<style>` element at runtime that
 * `style-src 'self'` blocks, so the app violated its own policy AND lost the touch-action
 * behavior. Three things have to stay true together — the slot is claimed, the rule is
 * shipped by us, and react-aria still keys its injection off the id we claim.
 */
describe('§7.1.4 pressable style guard', () => {
  beforeEach(() => {
    // `replaceChildren`, not the HTML sink — §7.1.6's grep has an empty allowlist and it
    // covers tests too.
    document.head.replaceChildren()
  })

  it('claims the id react-aria checks, with an element that can never be a CSP violation', () => {
    const marker = claimPressableStyleSlot(document)
    expect(marker).not.toBeNull()
    expect(document.getElementById(PRESSABLE_STYLE_ID)).toBe(marker)
    // A <style> here would BE the violation. A <meta> carries no fetch and no styling.
    expect(marker!.tagName).toBe('META')
    expect(marker!.textContent).toBe('')
    // Prepended, so it is in place before anything else in <head>.
    expect(document.head.firstElementChild).toBe(marker)
  })

  it('is idempotent — a second call never adds a second element', () => {
    const first = claimPressableStyleSlot(document)
    const second = claimPressableStyleSlot(document)
    expect(second).toBe(first)
    expect(document.head.querySelectorAll(`#${PRESSABLE_STYLE_ID}`)).toHaveLength(1)
  })

  it('yields to an element that already holds the id', () => {
    const other = document.createElement('meta')
    other.id = PRESSABLE_STYLE_ID
    document.head.append(other)
    expect(claimPressableStyleSlot(document)).toBe(other)
    expect(document.head.querySelectorAll(`#${PRESSABLE_STYLE_ID}`)).toHaveLength(1)
  })

  it('is called by the SPA entry point before the first render', () => {
    // Ordering is the whole guarantee: claimed after mount means one injection already
    // happened. Asserted on the source because the entry point renders the real app.
    const main = readFileSync(resolve(viewer, 'src/main.tsx'), 'utf8')
    const claim = main.indexOf('claimPressableStyleSlot()')
    const render = main.indexOf('createRoot(')
    expect(claim, 'main.tsx must claim the pressable style slot').toBeGreaterThan(-1)
    expect(claim).toBeLessThan(render)
  })

  it('ships the touch-action rule react-aria would have injected', () => {
    const css = readFileSync(resolve(viewer, 'src/ui/base.css'), 'utf8')
    expect(css).toContain(`[${PRESSABLE_ATTRIBUTE}]`)
    expect(css.replace(/\s+/g, ' ')).toContain(
      `[${PRESSABLE_ATTRIBUTE}] { touch-action: pan-x pan-y pinch-zoom; }`,
    )
  })

  it('still matches the react-aria version resolved in node_modules', () => {
    // If this fails, react-aria changed how (or whether) it injects its press style. The
    // guard, the base.css rule and this pin all have to be re-derived from the new source
    // — the failure is a prompt to re-verify, not a bug in the app.
    const usePress = readFileSync(
      resolve(viewer, 'node_modules/react-aria/dist/private/interactions/usePress.mjs'),
      'utf8',
    )
    expect(usePress).toContain(`'${PRESSABLE_STYLE_ID}'`)
    expect(usePress).toContain(`'${PRESSABLE_ATTRIBUTE}'`)
    // The early return we rely on: an existing element with that id suppresses injection.
    expect(usePress).toMatch(/getElementById\([^)]*\)\)\s*return/)
    expect(usePress).toContain('touch-action: pan-x pan-y pinch-zoom')
  })
})
