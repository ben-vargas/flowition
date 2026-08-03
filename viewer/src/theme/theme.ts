// DESIGN §9.9. `data-theme` on <html>; the pre-mount bootstrap is the external,
// render-blocking `/boot-theme.js` (never inline — §7.1.4). This module owns everything
// after mount: the `d` toggle (§2.7), system-follow, cross-tab sync via the storage event
// (parity #112), and transition suppression during the swap (parity #110).

export type Theme = 'light' | 'dark'

/** Shared with public/boot-theme.js. Changing it in one place only is a real bug. */
export const THEME_KEY = 'flowition.theme'

const listeners = new Set<(t: Theme) => void>()

const root = (): HTMLElement | null =>
  typeof document === 'undefined' ? null : document.documentElement

export function currentTheme(): Theme {
  const el = root()
  return el?.dataset.theme === 'light' ? 'light' : 'dark'
}

/**
 * Whether the user has pinned a theme, or we are following the OS.
 *
 * Only the two values this app writes count as a pin. `public/boot-theme.js` applies the
 * same rule, and the two MUST agree: if the boot script treats a junk `flowition.theme`
 * value as "no preference" and follows the OS while this said "pinned", system-follow
 * would stand down over a preference nobody expressed.
 */
export function isPinned(): boolean {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    return stored === 'light' || stored === 'dark'
  } catch { return false }
}

/**
 * Force the document's pending style recalculation to happen NOW.
 *
 * Reading a layout-dependent property is the standard way to demand one: the engine
 * cannot answer without clean style, so it runs the recalc synchronously. That recalc is
 * also the "style change event" CSS transitions are started from — which is the whole
 * point of calling it while transitions are suppressed.
 */
function flushStyle(el: HTMLElement) {
  void el.offsetHeight
}

function apply(theme: Theme) {
  const el = root()
  if (!el) return
  if (el.dataset.theme === theme) return
  // parity #110 + §3.6: the swap is ATOMIC. Suppress transitions, change the palette,
  // then force a synchronous style flush so every transitionable property COMMITS to the
  // new palette inside the suppressed style-change event. Only then release.
  //
  // Releasing on the next animation frame (what this used to do) released too early: a
  // rAF callback runs BEFORE that frame's style/paint, so the attribute was already gone
  // when the new palette was first committed, and every `transition: background` on the
  // page — Home's table header among them (features/home/home.css) — started a 120ms
  // interpolation from the OLD canvas while `color`, which nothing transitions, was
  // already the new one. For the length of that interpolation the page really rendered
  // one palette's text over the other's background: axe measured 2.8:1 on the 11px
  // column headers against a 4.5:1 floor. §3.6 is normative in BOTH themes AT ALL TIMES,
  // so "it settles in 120ms" is not a defense. A timeout would not have fixed it either
  // — only ordering the release AFTER the commit does, which is what the flush buys.
  el.setAttribute('data-theme-swapping', '')
  el.dataset.theme = theme
  flushStyle(el)
  el.removeAttribute('data-theme-swapping')
  for (const fn of listeners) fn(theme)
}

export function setTheme(theme: Theme, { persist = true } = {}) {
  if (persist) {
    try { localStorage.setItem(THEME_KEY, theme) } catch { /* private mode: session only */ }
  }
  apply(theme)
}

export function toggleTheme() {
  setTheme(currentTheme() === 'dark' ? 'light' : 'dark')
}

export function subscribeTheme(fn: (t: Theme) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/**
 * Wire the cross-tab and system-follow listeners. Returns a teardown.
 *
 * System-follow applies ONLY while the user has not pinned a theme: once they press `d`,
 * an OS change must not yank the palette out from under them.
 */
export function installThemeSync(): () => void {
  if (typeof window === 'undefined') return () => {}

  const onStorage = (e: StorageEvent) => {
    if (e.key !== THEME_KEY) return
    // parity #112: another tab pinned or cleared the theme. Mirror without re-persisting.
    if (e.newValue === 'light' || e.newValue === 'dark') apply(e.newValue)
    else apply(systemTheme())
  }
  window.addEventListener('storage', onStorage)

  const media = typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: light)')
    : null
  const onMedia = () => { if (!isPinned()) apply(systemTheme()) }
  media?.addEventListener?.('change', onMedia)

  // System-follow is a STATE, not just an event. Reconciling only on `change` left any
  // wrong initial paint standing until the OS theme happened to move — which is exactly
  // what a boot script that could not reach storage used to produce. Reconcile once here
  // too: unpinned means the OS decides, right now, not at the next change.
  onMedia()

  return () => {
    window.removeEventListener('storage', onStorage)
    media?.removeEventListener?.('change', onMedia)
  }
}

function systemTheme(): Theme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'dark'
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/**
 * §2.7 / parity #111: keyboard shortcuts are ignored while the user is typing. Exported
 * because every shortcut owner needs the same predicate, and "ignored while typing" is
 * the kind of rule that rots when it is reimplemented per handler.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return el.isContentEditable === true
}
