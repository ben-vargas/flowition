/**
 * A cancellable replacement for `@tanstack/react-virtual`'s `observeElementOffset`.
 *
 * **The defect it exists for.** The shipped observer debounces an "and now scrolling has
 * stopped" callback through `targetWindow.setTimeout(…, isScrollingResetDelay)` (150 ms by
 * default) and its unsubscribe function removes the scroll listener but NEVER CLEARS THAT
 * TIMER (`@tanstack/virtual-core` 3.13.12 `dist/esm/index.js:71-105`; still true on 3.17.7,
 * the newest published build, at `index.js:84-117` — so this is not a version that can be
 * bumped away). A scroll inside the last 150 ms of a component's life therefore fires
 * `cb(offset, false)` after the virtualizer has been torn down, which walks
 * `Virtualizer.notify` → the React `onChange` → `dispatchReducerAction` → a re-render.
 *
 * Under vitest that lands as a `ReferenceError: window is not defined` thrown out of
 * `react-dom` AFTER the jsdom environment is gone: a full run that exits 1 with every
 * assertion passed. In a browser it is the milder version of the same thing — a state
 * update on a tree that is no longer mounted.
 *
 * This is the same observer with one addition: the unsubscribe clears the pending debounce.
 * Everything else is deliberately byte-for-byte behavior-identical to the version installed
 * (including the RTL sign flip, the initial `endHandler()` priming call, the passive
 * listener, and the `useScrollendEvent && 'onscrollend' in window` branch), because the
 * point is to cancel scheduled work — not to change how the timeline scrolls.
 */

import type { Virtualizer } from '@tanstack/react-virtual'

type ElementVirtualizer = Virtualizer<HTMLDivElement, Element>

const PASSIVE = { passive: true } as const

/** `'onscrollend' in window`, evaluated once, matching the library's own capability test. */
const supportsScrollend = typeof window === 'undefined' ? true : 'onscrollend' in window

export function observeElementOffsetCancellable(
  instance: ElementVirtualizer,
  cb: (offset: number, isScrolling: boolean) => void,
): (() => void) | undefined {
  const element = instance.scrollElement
  if (!element) return
  const targetWindow = instance.targetWindow
  if (!targetWindow) return

  let offset = 0
  let debounceId: number | undefined
  const useScrollend = instance.options.useScrollendEvent && supportsScrollend

  // The library's `debounce(targetWindow, …)`, inlined so the handle stays reachable from
  // the unsubscribe below. That reachability IS the fix.
  const fallback = useScrollend
    ? () => {}
    : () => {
      targetWindow.clearTimeout(debounceId)
      debounceId = targetWindow.setTimeout(
        () => { cb(offset, false) },
        instance.options.isScrollingResetDelay,
      )
    }

  const createHandler = (isScrolling: boolean) => () => {
    const { horizontal, isRtl } = instance.options
    offset = horizontal ? element.scrollLeft * ((isRtl && -1) || 1) : element.scrollTop
    fallback()
    cb(offset, isScrolling)
  }

  const handler = createHandler(true)
  const endHandler = createHandler(false)
  endHandler()
  element.addEventListener('scroll', handler, PASSIVE)
  if (useScrollend) element.addEventListener('scrollend', endHandler, PASSIVE)

  return () => {
    // ← the line the library is missing.
    targetWindow.clearTimeout(debounceId)
    debounceId = undefined
    element.removeEventListener('scroll', handler)
    if (useScrollend) element.removeEventListener('scrollend', endHandler)
  }
}
