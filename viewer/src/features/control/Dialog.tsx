/**
 * The modal primitive every §7.2/§7.3 confirmation, the palette and the shortcut overlay
 * are built on — behavior from @react-aria hooks (§16.3), appearance from §3's tokens.
 *
 * §16.3 is precise about the split: "hooks-level @react-aria/* primitives … under the
 * approved §3 visual system unchanged. Borrow behavior, not appearance: no
 * @adobe/react-spectrum, no component kit, no kit CSS." So this file imports
 * `useDialog`, `useOverlay`, `usePreventScroll`, `ariaHideOutside` and `FocusScope` — none
 * of which render a single element or ship a single style — and draws the dialog itself
 * out of `control.css`.
 *
 * What the hooks buy, and what §3.6 demands of each:
 *   • `useDialog`      — `role="dialog"`, the title association, and focus into the dialog
 *                        on open ("opening a panel moves focus to its header").
 *   • `FocusScope contain` — Tab cannot leave an `aria-modal` dialog, which is the promise
 *                        `aria-modal` makes. Its `restoreFocus`/`autoFocus` options are
 *                        NOT used; see the effect below for why the initial focus and the
 *                        restore are owned here instead.
 *   • `useOverlay`     — Escape and outside-press (the scrim) both route to one `onClose`.
 *   • `usePreventScroll` / `ariaHideOutside` — the page behind a modal neither scrolls nor
 *                        exists for a screen reader.
 *
 * **The scrim path is wired twice, on purpose.** `useOverlay`'s outside-press detection
 * goes through pointer events, and the environment the §16.5 regression was found in — and
 * the jsdom the §11.3 suite runs in — do not all deliver those identically. A close path
 * that "usually" restores focus is exactly the defect DESIGN §16.5 names ("drawer focus
 * restoration (the scrim path specifically — it regressed once)"), so the underlay also
 * carries an explicit click handler and the test that covers it is named for the scrim.
 * Two paths into one idempotent `onClose` cannot double-close; a missing path can regress.
 */

import { useEffect, useId, useRef } from 'react'
import type { DOMAttributes, ReactNode, RefObject } from 'react'
import { useDialog } from '@react-aria/dialog'
import { FocusScope } from '@react-aria/focus'
import { ariaHideOutside, useOverlay, usePreventScroll } from '@react-aria/overlays'

export interface ModalSurfaceOptions {
  /** Every close path — Escape, the scrim, a button, the host deciding it is shut. */
  onClose: () => void
  /**
   * Where focus goes on unmount, when the caller knows better than the "who was focused
   * when this first rendered" guess. See `restoreFocusTo` on `ControlDialogProps`.
   */
  restoreFocusTo?: Element | null
  /**
   * Which element takes focus on open. Default: the first focusable descendant, falling
   * back to the surface itself. The inbox drawer overrides it — §3.6 says "opening a panel
   * moves focus to its HEADER", and a header is not a tab stop.
   */
  initialFocus?: (surface: HTMLElement) => HTMLElement | null | undefined
}

export interface ModalSurface<T extends HTMLElement> {
  ref: RefObject<T | null>
  /** Spread on the scrim/underlay element. */
  underlayProps: DOMAttributes<HTMLElement>
  /** Spread on the surface itself: role, labelling plumbing, Escape, focus target. */
  surfaceProps: DOMAttributes<HTMLElement>
  /** Spread on the surface's own heading when it should be the accessible name. */
  titleProps: DOMAttributes<HTMLElement>
}

/**
 * §16.3's modal behavior, in one place, so every modal surface in this feature gets the
 * SAME contract — `useDialog` + `useOverlay` + `usePreventScroll` + `ariaHideOutside` +
 * `FocusScope contain` — instead of each one hand-wiring the half it remembered.
 *
 * (The `FocusScope` itself is the caller's, because it wraps JSX; every hook that does not
 * render is here. `<FocusScope contain>` around the surface is not optional — `aria-modal`
 * is a promise about Tab that only containment keeps.)
 *
 * Extracted in round 2: `ControlDialog` had all five and the cockpit's narrow inbox drawer
 * had one, so the drawer left the page behind it scrollable and fully visible to a screen
 * reader while claiming `aria-modal="true"` — a claim `ariaHideOutside` is what makes true.
 */
export function useModalSurface<T extends HTMLElement>(
  options: ModalSurfaceOptions,
): ModalSurface<T> {
  const { onClose } = options
  const ref = useRef<T>(null)
  // WHO OPENED THIS, captured during the FIRST RENDER rather than in an effect.
  //
  // By the time effects run, `useDialog` has already moved focus onto the surface itself,
  // so an effect that reads `document.activeElement` captures the surface and "restores"
  // focus to a node that is about to be removed — which lands the operator on `<body>`
  // with no keyboard position at all. Render happens before any of that.
  const opener = useRef<Element | null>(null)
  if (opener.current === null) opener.current = document.activeElement
  // An explicit caller-supplied target always wins over the guess, and it is re-read on
  // every render so a caller that learns the answer late still gets it right.
  const restoreTo = useRef<Element | null>(null)
  restoreTo.current = options.restoreFocusTo ?? opener.current
  const initialFocus = useRef(options.initialFocus)
  initialFocus.current = options.initialFocus

  const { overlayProps, underlayProps } = useOverlay(
    { isOpen: true, onClose, isDismissable: true, shouldCloseOnBlur: false },
    ref as RefObject<HTMLElement | null>,
  )
  usePreventScroll()
  const { dialogProps, titleProps } = useDialog(
    { role: 'dialog' }, ref as RefObject<HTMLElement | null>,
  )

  // The rest of the document stops existing for assistive tech while the modal is up —
  // `aria-modal` alone is advisory, this is the enforcement (§3.6).
  //
  // It is registered BEFORE the focus effect on purpose: cleanups run in registration
  // order, so the outside world is un-hidden before the restore focuses back into it.
  useEffect(() => {
    const node = ref.current
    if (!node) return
    return ariaHideOutside([node])
  }, [])

  // Initial focus, explicitly.
  //
  // `FocusScope autoFocus` would normally do this, and in a browser it does — but its tree
  // walker filters on VISIBILITY, and in the jsdom the §11.3 suite runs in every element
  // measures 0×0, so nothing qualifies and focus silently stays on the opener. A focus
  // contract that is only true in one of the two environments it is tested in is not a
  // contract, and the failure mode is the worst kind: the restore-focus assertions would
  // pass trivially, because focus never left. So the target is resolved and focused here,
  // deterministically. DOM ORDER IS THE POLICY for dialogs: §7.2's "default focus on Keep"
  // is implemented by putting Keep first, in every confirmation.
  useEffect(() => {
    const node = ref.current
    if (!node) return
    const chosen = initialFocus.current?.(node)
      ?? node.querySelector<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), textarea:not([disabled]),'
        + ' select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )
    ;(chosen ?? node).focus()
    // …and the restore, for the same reason and one more: `FocusScope restoreFocus` runs
    // its own restore through the same visibility-filtered focus manager, and when that
    // finds nothing to focus it leaves focus on the BODY — clobbering a correct restore
    // that ran before it. Two mechanisms racing over one guarantee is worse than one that
    // holds, so containment is React Aria's and the restore is ours: on unmount, whichever
    // path closed the surface, focus returns to the element that opened it. A node that
    // has since left the document is skipped rather than focused into nowhere.
    return () => {
      const back = restoreTo.current
      if (back instanceof HTMLElement && back.isConnected && !node.contains(back)) back.focus()
    }
  }, [])

  return {
    ref,
    underlayProps,
    surfaceProps: { ...overlayProps, ...dialogProps },
    titleProps,
  }
}

export interface ControlDialogProps {
  /** The dialog's heading. It is the accessible name (`aria-labelledby`). */
  title: string
  /** Sub-head under the title; also the dialog's `aria-describedby` when present. */
  description?: ReactNode
  /** Every close path — Escape, the scrim, a Cancel button, a completed mutation. */
  onClose: () => void
  /** Buttons. The SAFE one goes first: `FocusScope autoFocus` takes the first tabbable. */
  footer?: ReactNode
  children?: ReactNode
  /** `danger` tints the rule and the heading glyph for destructive lifecycle mutations. */
  tone?: 'neutral' | 'danger'
  /** Width class hook — the palette is wider than a confirm. */
  size?: 'confirm' | 'wide'
  /** Test/telemetry hook so a walkthrough can name the dialog it is in. */
  name?: string
  /**
   * Where focus goes when this dialog closes, when the host knows better than the dialog
   * does. `ControlProvider` supplies it for CHAINED modals (palette → confirmation): the
   * node that opened the palette is the operator's real page position, and by the time the
   * confirmation renders that node is no longer `document.activeElement` — the palette's
   * combobox is, and it is about to be removed. Without this, the chain restores focus to
   * a detached node, the guard below correctly skips it, and the operator lands on `<body>`.
   */
  restoreFocusTo?: Element | null
}

export function ControlDialog(props: ControlDialogProps) {
  const { title, description, onClose, footer, children, tone = 'neutral' } = props
  const descriptionId = useId()
  const { ref, underlayProps, surfaceProps, titleProps } = useModalSurface<HTMLDivElement>({
    onClose,
    restoreFocusTo: props.restoreFocusTo ?? null,
  })

  return (
    <div
      className="ctl-scrim"
      data-scrim={props.name ?? 'dialog'}
      {...underlayProps}
      // The second scrim path (see the header note). `currentTarget === target` keeps a
      // click that started inside the dialog from closing it.
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <FocusScope contain>
        <div
          {...surfaceProps}
          ref={ref}
          className={`ctl-dialog ${props.size ?? 'confirm'}${tone === 'danger' ? ' danger' : ''}`}
          aria-modal="true"
          {...(description ? { 'aria-describedby': descriptionId } : {})}
          {...(props.name ? { 'data-dialog': props.name } : {})}
        >
          <h2 {...titleProps} className="ctl-title">{title}</h2>
          {description ? (
            <div className="ctl-desc" id={descriptionId}>{description}</div>
          ) : null}
          {children}
          {footer ? <div className="ctl-actions">{footer}</div> : null}
        </div>
      </FocusScope>
    </div>
  )
}
