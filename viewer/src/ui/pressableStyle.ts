/**
 * §7.1.4 runtime CSP: keep react-aria out of `<head>`.
 *
 * `usePress` (react-aria/dist/private/interactions/usePress) prepends a `<style>` element
 * to `document.head` the first time any pressable control mounts, carrying
 *
 *     @layer { [data-react-aria-pressable] { touch-action: pan-x pan-y pinch-zoom; } }
 *
 * to suppress the double-tap-to-zoom click delay on touch devices. Under
 * `style-src 'self'` that element is a `style-src-elem` violation on every cockpit load:
 * the policy blocks it (fail-closed, as designed), and the rule never applies — so touch
 * devices keep the 300 ms delay AND the app violates its own policy.
 *
 * Neither half is acceptable, and loosening the policy (a hash allowance, `unsafe-inline`)
 * is the wrong trade for a rule we can simply own: the declaration is now shipped
 * verbatim in `ui/base.css`, so the behavior exists without an injection.
 *
 * usePress guards its injection with `ownerDocument.getElementById(STYLE_ID)` — so
 * claiming that id with a non-style marker before React mounts makes the injection never
 * happen at all, rather than happen-and-be-blocked. A `<meta>` is used deliberately:
 * whatever CSP directive a future react-aria trips, this element can never be the thing
 * that trips it.
 *
 * If a react-aria bump renames the id, the injection resumes — and the Playwright suite's
 * zero-`securitypolicyviolation` assertion (viewer/e2e/viewer.spec.ts) fails on every
 * route. That gate, not this comment, is what keeps the two in sync.
 */

/** The element id react-aria's `usePress` checks before injecting its style element. */
export const PRESSABLE_STYLE_ID = 'react-aria-pressable-style'

/** The attribute `usePress` puts on every pressable; `ui/base.css` styles it. */
export const PRESSABLE_ATTRIBUTE = 'data-react-aria-pressable'

/**
 * Claim the injection slot. Idempotent, and safe to call before or after mount — but
 * callers should call it before the first render, which is the only ordering that
 * guarantees the injection never runs.
 */
export function claimPressableStyleSlot(doc: Document = document): HTMLElement | null {
  const head = doc.head
  if (!head) return null
  const existing = doc.getElementById(PRESSABLE_STYLE_ID)
  if (existing) return existing as HTMLElement
  const marker = doc.createElement('meta')
  marker.id = PRESSABLE_STYLE_ID
  marker.name = PRESSABLE_STYLE_ID
  marker.content = 'owned by ui/base.css'
  head.prepend(marker)
  return marker
}
