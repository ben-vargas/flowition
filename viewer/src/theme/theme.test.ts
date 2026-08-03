// @vitest-environment jsdom
//
// §9.9 theme behavior, including the parity items that make it more than a class toggle:
// #109 no-flash (owned by the external boot script, asserted structurally here), #110
// transitions suppressed during the swap, #111 shortcuts ignored while typing, #112
// cross-tab sync via the storage event.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { runInThisContext } from 'node:vm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  THEME_KEY, currentTheme, installThemeSync, isPinned, isTypingTarget, setTheme,
  subscribeTheme, toggleTheme,
} from './theme.js'

// jsdom rewrites `import.meta.url` to an http: URL, so paths resolve from the vitest
// root (viewer/) instead.
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), 'utf8')
const bootScript = read('public/boot-theme.js')

let teardown: (() => void) | null = null

beforeEach(() => {
  document.documentElement.dataset.theme = 'dark'
  localStorage.clear()
})
afterEach(() => { teardown?.(); teardown = null })

describe('the boot script (parity #109 / §7.1.4)', () => {
  it('is a separate first-party file that sets data-theme before the bundle', () => {
    expect(bootScript).toContain('document.documentElement.dataset.theme')
    expect(bootScript).toContain('localStorage.getItem')
  })

  it('uses the SAME storage key as the toggle', () => {
    // The bug this catches is silent: the boot script paints one theme, the app another,
    // and the flash is back.
    expect(bootScript).toContain(THEME_KEY)
  })

  /**
   * These four RUN the script rather than grepping it. The previous test asserted only
   * that a `catch` existed — which it did, wrapped around storage AND the media query
   * together, so a `localStorage.getItem` that throws (Safari private mode, blocked
   * storage) skipped `prefers-color-scheme` entirely and forced dark on a machine set to
   * light. A structural assertion cannot see that; executing it can (review round 4).
   */
  describe('executed, not grepped', () => {
    // `node:vm` rather than `new Function`, which §7.1.6's sink grep forbids under
    // viewer/src with an empty allowlist — and that rule earns its keep by having no
    // exceptions, including for a test that only wants to run its own boot script.
    const boot = () => { runInThisContext(bootScript, { filename: 'boot-theme.js' }) }
    const systemPrefers = (theme: 'light' | 'dark') => vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('light') === (theme === 'light'), media: q,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false,
    }))

    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

    it('follows the OS when storage THROWS, rather than forcing dark (§9.9)', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      })
      systemPrefers('light')
      document.documentElement.removeAttribute('data-theme')

      boot()
      // Light BEFORE mount — this is the paint the operator sees, and #109 says it must
      // already be right.
      expect(document.documentElement.dataset.theme).toBe('light')

      // …and the mounted sync agrees, instead of waiting for the OS theme to change.
      teardown = installThemeSync()
      expect(currentTheme()).toBe('light')
    })

    it('still forces dark when the media query itself is unavailable', () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('nope') })
      vi.stubGlobal('matchMedia', undefined)
      document.documentElement.removeAttribute('data-theme')
      expect(() => boot()).not.toThrow()
      expect(document.documentElement.dataset.theme).toBe('dark')
    })

    it('treats an unrecognized stored value as no preference, not as a pin', () => {
      localStorage.setItem(THEME_KEY, 'chartreuse')
      systemPrefers('light')
      document.documentElement.removeAttribute('data-theme')
      boot()
      expect(document.documentElement.dataset.theme).toBe('light')
      // The mounted half applies the SAME rule, or system-follow would stand down over a
      // preference nobody expressed.
      expect(isPinned()).toBe(false)
    })

    it('lets a pinned theme beat the system query', () => {
      localStorage.setItem(THEME_KEY, 'dark')
      systemPrefers('light')
      document.documentElement.removeAttribute('data-theme')
      boot()
      expect(document.documentElement.dataset.theme).toBe('dark')
      expect(isPinned()).toBe(true)
    })
  })

  it('is loaded render-blocking from <head>, and never inlined', () => {
    const html = read('index.html')
    // Relative, per §9.2's `base: './'` — the built tree must be relocatable, so no
    // first-party URL in it may be anchored to the origin root.
    expect(html).toContain('src="./boot-theme.js"')
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)
    expect(html).not.toMatch(/<style[\s>]/i)
    expect(html).not.toMatch(/\sstyle=/i)
    // Before the stylesheet: the bundle's <link> is injected by the build after this tag.
    expect(html.indexOf('boot-theme.js')).toBeLessThan(html.indexOf('<body'))
  })
})

describe('setTheme / toggleTheme', () => {
  it('swaps data-theme and persists the choice', () => {
    setTheme('light')
    expect(currentTheme()).toBe('light')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(localStorage.getItem(THEME_KEY)).toBe('light')
    toggleTheme()
    expect(currentTheme()).toBe('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
  })

  /**
   * #110 + §3.6, and the ordering is the whole test.
   *
   * The old contract was "suppress, then release on the next animation frame". A rAF
   * callback runs BEFORE that frame's style recalculation and paint, so the release
   * landed before the new palette was ever committed: `color` (untransitioned) flipped
   * instantly while every `transition: background` interpolated out of the old palette,
   * and the page rendered light text over a dark-to-light background for 120ms. Real
   * browsers reproduce it — axe measured 2.8:1 on Home's 11px column headers.
   *
   * So the assertion is not "the attribute is eventually gone". It is that the forced
   * style flush happens WHILE the attribute is still on AND after `data-theme` already
   * says the new palette — because that is the only ordering in which the new values can
   * become the transition's *before* state instead of its *from* state.
   */
  it('commits the new palette while transitions are still suppressed (#110/§3.6)', () => {
    const observed: { theme?: string; suppressed: boolean }[] = []
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        const el = document.documentElement
        observed.push({ theme: el.dataset.theme, suppressed: el.hasAttribute('data-theme-swapping') })
        return 0
      },
    })
    try {
      setTheme('light')
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original)
      else delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetHeight
    }

    expect(
      observed,
      'the swap must force a style flush with the NEW theme applied and transitions still suppressed',
    ).toContainEqual({ theme: 'light', suppressed: true })
    // …and nothing stays permanently un-animated afterwards.
    expect(document.documentElement.hasAttribute('data-theme-swapping')).toBe(false)
  })

  it('releases suppression synchronously — no frame, no timer, can be lost (#110)', () => {
    // A deferred release is a release that can be observed early: the frame between the
    // palette change and the callback is exactly the frame that used to render wrong.
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const timeout = vi.spyOn(window, 'setTimeout')
    // `persist: false`: jsdom schedules its own StorageEvent on a timer, and this
    // assertion is about the release, not about how jsdom delivers storage events.
    setTheme('light', { persist: false })
    expect(document.documentElement.hasAttribute('data-theme-swapping')).toBe(false)
    expect(raf, 'the release must not wait for a frame').not.toHaveBeenCalled()
    expect(timeout, 'the release must not wait for a timer').not.toHaveBeenCalled()
    raf.mockRestore()
    timeout.mockRestore()
  })

  it('notifies subscribers', () => {
    const seen: string[] = []
    const off = subscribeTheme((t) => seen.push(t))
    setTheme('light')
    setTheme('dark')
    off()
    setTheme('light')
    expect(seen).toEqual(['light', 'dark'])
  })

  it('is a no-op when the theme is already applied', () => {
    const seen: string[] = []
    const off = subscribeTheme((t) => seen.push(t))
    setTheme('dark')      // already dark
    off()
    expect(seen).toEqual([])
  })
})

describe('cross-tab sync (parity #112)', () => {
  it('mirrors another tab pinning a theme, without re-persisting', () => {
    teardown = installThemeSync()
    localStorage.setItem(THEME_KEY, 'light')
    window.dispatchEvent(new StorageEvent('storage', { key: THEME_KEY, newValue: 'light' }))
    expect(currentTheme()).toBe('light')
  })

  it('ignores storage events for other keys', () => {
    teardown = installThemeSync()
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated', newValue: 'light' }))
    expect(currentTheme()).toBe('dark')
  })
})

describe('pinning', () => {
  it('reports whether the user has chosen, so system-follow knows to stand down', () => {
    expect(isPinned()).toBe(false)
    setTheme('light')
    expect(isPinned()).toBe(true)
  })
})

describe('isTypingTarget — parity #111', () => {
  it('treats form fields and contenteditable as typing', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isTypingTarget(document.createElement(tag)), tag).toBe(true)
    }
    const editable = document.createElement('div')
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(isTypingTarget(editable)).toBe(true)
  })

  it('does not treat ordinary elements or null as typing', () => {
    expect(isTypingTarget(document.createElement('div'))).toBe(false)
    expect(isTypingTarget(document.body)).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})
