/**
 * The drawer's focus trap (§3.6; the comps' `cockpit-live-800` supporting frame, annotations
 * 20–22 as ruled on: "opening moves focus to the drawer HEADER, Escape closes and restores
 * focus to the 44px handle, **and Tab is trapped while the scrim is up** (role=dialog
 * aria-modal)").
 *
 * `aria-modal="true"` is a PROMISE to assistive technology that the rest of the page is
 * inert. A dialog that makes the promise and then lets Tab walk out of it into content the
 * scrim is covering is worse than one that never claimed to be modal: the screen-reader user
 * is told there is nothing behind the dialog while their focus is standing in it (review
 * round 2, B6).
 *
 * This lives beside the cockpit rather than in `viewer/src/ui/` because §12 gives W12 the
 * Dialog primitive; when that lands, the drawer adopts it and this goes away. It is 30 lines
 * of behavior, not a design-system component.
 */

/**
 * Everything inside `root` that Tab can reach, in DOM order.
 *
 * `tabindex="-1"` is deliberately excluded: the drawer's heading is focusable so that
 * opening can move focus onto it, but it is not a tab STOP, and including it would make Tab
 * cycle through a heading the operator never asked to visit.
 */
export function focusable(root: HTMLElement): HTMLElement[] {
  const candidates = root.querySelectorAll<HTMLElement>(
    'a[href], button, input, select, textarea, [tabindex]',
  )
  return [...candidates].filter((el) => {
    if (el.hasAttribute('disabled') || el.getAttribute('aria-hidden') === 'true') return false
    const tabindex = el.getAttribute('tabindex')
    if (tabindex != null && Number(tabindex) < 0) return false
    // jsdom computes no layout, so `offsetParent` is null for everything there; visibility is
    // therefore checked through the properties that DO resolve in both environments.
    return el.style.display !== 'none' && el.style.visibility !== 'hidden'
  })
}

/**
 * Handle one `Tab` inside a modal container. Returns `true` when the event was handled (and
 * therefore consumed), so the caller can `preventDefault()` exactly then and leave every
 * other Tab alone.
 *
 * Focus that is not on a stop inside the container — the heading it was moved to on open, or
 * anything outside — enters at the first stop, or at the last under Shift.
 */
export function trapTab(root: HTMLElement, event: KeyboardEvent): boolean {
  if (event.key !== 'Tab') return false
  const stops = focusable(root)
  if (stops.length === 0) return false
  const active = document.activeElement as HTMLElement | null
  const at = active ? stops.indexOf(active) : -1
  const first = stops[0]!
  const last = stops[stops.length - 1]!
  if (at === -1) {
    (event.shiftKey ? last : first).focus()
    return true
  }
  if (event.shiftKey && active === first) { last.focus(); return true }
  if (!event.shiftKey && active === last) { first.focus(); return true }
  return false
}
