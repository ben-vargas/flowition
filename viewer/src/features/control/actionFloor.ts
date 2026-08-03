/**
 * The "action floor": the height of the LOWER INTERACTIVE EXCLUSION ZONE on the current
 * screen — every bottom-anchored control the operator can click — published as a CSS custom
 * property so the fixed toast layer can sit ABOVE all of it.
 *
 * Why this exists. §3.6 says toasts are `role=status` and never focus-stealing, and the
 * shipped ones honoured both — but a `position: fixed; bottom: 16px` stack lands exactly on
 * top of §2.5's steer composer, whose Send button is the bottom-right control of the
 * transcript pane. A reviewer's first click on Send hit the resume toast instead. A toast
 * that intercepts a mutation's own control is a worse defect than a toast that lingers: the
 * operator's action silently does not happen, and nothing on screen says why.
 *
 * **The zone is not the composer.** A first pass reserved only `.tp-foot` and left the
 * transcript's "Jump to latest" — `position: absolute; right: 18px; bottom: 12px` inside the
 * virtual frame, i.e. immediately ABOVE the composer and on the same right edge — inside the
 * band the toast then occupied, and `.ctl-toast` restores `pointer-events: auto`, so the card
 * could swallow that click too. Fixing one control and not its neighbour is the same defect
 * with a different button in it, so every claimant below reserves its own box PLUS the gap
 * beneath it, and the floor is the tallest claim. Adding a bottom-anchored control to a
 * screen means claiming here; that is the whole contract.
 *
 * Three properties, and all three are load-bearing:
 *
 *  • **The floor is measured, not guessed.** A magic offset would be wrong the moment the
 *    composer grew a second line or a lock chip, which is the same class of failure as the
 *    unshrinkable chips this release also fixes.
 *  • **Claims are a multiset keyed by identity.** Two transcript panes are open in compare
 *    mode, each with its own composer and its own jump control; the floor is the tallest of
 *    them, and one unmounting must not clear the others'.
 *  • **The variable is written on `documentElement`,** because the toast layer is a fixed
 *    child of the shell and the composer is many levels down a different subtree. A CSS
 *    variable is the only channel between them that does not couple the two components.
 */

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

const VAR = '--action-floor'

const claims = new Map<object, number>()

function publish(): void {
  if (typeof document === 'undefined') return
  let max = 0
  for (const height of claims.values()) if (height > max) max = height
  const root = document.documentElement
  if (max > 0) root.style.setProperty(VAR, `${Math.round(max)}px`)
  else root.style.removeProperty(VAR)
}

/** Test seam and teardown: no claim outlives the tree that made it. */
export function resetActionFloor(): void {
  claims.clear()
  publish()
}

/** The current floor in px — what the CSS variable resolves to. Read by tests. */
export function actionFloor(): number {
  let max = 0
  for (const height of claims.values()) if (height > max) max = height
  return Math.round(max)
}

export interface FloorClaim {
  /** Re-measure `element` and republish. Safe to call on every render. */
  measure(): void
  /** Drop this claim. Idempotent. */
  release(): void
}

/**
 * Claim the floor for one element. Returns a handle rather than taking a React ref, so the
 * module stays testable without a renderer and usable from a layout effect.
 */
export function claimActionFloor(element: Element | null): FloorClaim {
  const key = {}
  let observer: ResizeObserver | null = null
  let onResize: (() => void) | null = null

  const measure = () => {
    if (!element || !element.isConnected) {
      claims.delete(key)
      publish()
      return
    }
    const rect = element.getBoundingClientRect()
    // `bottom` matters, not just height: a composer that is not actually docked at the
    // bottom of the viewport (a short pane, a narrow-mode drawer) reserves nothing, because
    // the toast layer is anchored to the VIEWPORT and would not overlap it anyway.
    const viewport = typeof window === 'undefined' ? 0 : window.innerHeight
    const gap = viewport > 0 ? Math.max(0, viewport - rect.bottom) : 0
    const reserve = rect.height > 0 ? rect.height + gap : 0
    claims.set(key, reserve)
    publish()
  }

  measure()

  if (element && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => measure())
    observer.observe(element)
  }
  if (element && typeof window !== 'undefined') {
    onResize = () => measure()
    window.addEventListener('resize', onResize)
  }

  return {
    measure,
    release() {
      observer?.disconnect()
      observer = null
      if (onResize && typeof window !== 'undefined') {
        window.removeEventListener('resize', onResize)
        onResize = null
      }
      claims.delete(key)
      publish()
    },
  }
}

/**
 * React's side of the same claim. It runs on EVERY render rather than on a dependency list,
 * because the thing it measures — a composer that grows a line, a lock chip that appears —
 * changes without any value this hook could depend on. One `getBoundingClientRect` per
 * render of one element is cheaper than being wrong about where the toast may sit.
 */
export function useActionFloorClaim(ref: RefObject<Element | null>): void {
  const claim = useRef<FloorClaim | null>(null)
  const claimed = useRef<Element | null>(null)

  useLayoutEffect(() => {
    const element = ref.current ?? null
    if (element !== claimed.current) {
      claim.current?.release()
      claimed.current = element
      claim.current = element ? claimActionFloor(element) : null
      return
    }
    claim.current?.measure()
  })

  useEffect(() => () => {
    claim.current?.release()
    claim.current = null
    claimed.current = null
  }, [])
}
