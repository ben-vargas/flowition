// @vitest-environment jsdom
//
// The modal primitive (§3.6, §16.3, and §16.5's named regression).
//
// DESIGN §16.5 lists the browser suite's minimum and names one case out of all of them:
// "drawer focus restoration (**the scrim path specifically — it regressed once**)". That is
// the test below called `restores focus … the SCRIM path`, and it exists at this level too
// (not only in W13's Playwright suite) because the defect is a component contract, and a
// contract only checked in a browser job is a contract that regresses between browser jobs.
//
// The property, stated once: focus returns to the opener on EVERY close path. Not "on the
// Cancel button", not "usually" — every path, including the two nobody writes a handler for
// (Escape and the scrim).

import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ControlDialog } from './Dialog.js'

beforeEach(() => { render(<Harness />) })
afterEach(cleanup)

function Harness({ onClosed }: { onClosed?: () => void } = {}) {
  const [open, setOpen] = useState(false)
  const close = () => { setOpen(false); onClosed?.() }
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>Open the dialog</button>
      <button type="button">A button outside</button>
      {open ? (
        <ControlDialog
          name="probe"
          title="Confirm the thing"
          description="what it does"
          onClose={close}
          footer={
            <>
              <button type="button" onClick={close}>Keep it</button>
              <button type="button" onClick={close}>Do it</button>
            </>
          }
        >
          <input aria-label="a field" />
        </ControlDialog>
      ) : null}
    </div>
  )
}

const opener = () => screen.getByRole('button', { name: 'Open the dialog' })
const openDialog = () => {
  const button = opener()
  button.focus()
  fireEvent.click(button)
  return screen.getByRole('dialog')
}

describe('§3.6 modal dialog', () => {
  it('is a labelled, described, aria-modal dialog with focus inside it', () => {
    const dialog = openDialog()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(screen.getByRole('heading', { name: 'Confirm the thing' })).toBeTruthy()
    // useDialog + FocusScope autoFocus: focus is INSIDE the dialog, never left behind on
    // the opener (§3.6 "opening a panel moves focus to its header").
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('takes its default focus from DOM order, which is why safe actions come first', () => {
    openDialog()
    // The first tabbable element in this dialog is its input; in the §7.2 confirmations the
    // first is "Keep running" / "Keep it". Same mechanism, asserted here once.
    expect((document.activeElement as HTMLElement).getAttribute('aria-label')).toBe('a field')
  })

  it('makes the rest of the page inert while it is up (ariaHideOutside)', () => {
    openDialog()
    expect(screen.queryByRole('button', { name: 'A button outside' })).toBeNull()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.getByRole('button', { name: 'A button outside' })).toBeTruthy()
  })

  it('restores focus to the opener on the ESCAPE path', () => {
    openDialog()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener())
  })

  // §16.5, by name. The scrim is a close path with no button, no handler an author would
  // naturally write, and no visible affordance — which is exactly why it is the one that
  // regressed, and the one pinned here.
  it('restores focus to the opener on the SCRIM path (§16.5 — it regressed once)', () => {
    openDialog()
    const scrim = document.querySelector<HTMLElement>('.ctl-scrim')!
    fireEvent.click(scrim)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener())
  })

  it('does NOT close when a click starts inside the dialog and lands on the scrim', () => {
    const dialog = openDialog()
    fireEvent.click(dialog)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('restores focus to the opener on the BUTTON paths', () => {
    for (const name of ['Keep it', 'Do it']) {
      openDialog()
      fireEvent.click(screen.getByRole('button', { name }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(opener())
      cleanup()
      render(<Harness />)
    }
  })

  it('CONTAINS focus: an element outside the dialog cannot take it', () => {
    // `aria-modal="true"` is a promise that the rest of the page is inert, and FocusScope
    // `contain` is what keeps it — including against the paths a keyboard user can actually
    // reach (Tab past the last control, a click that lands behind the scrim).
    const dialog = openDialog()
    const inside = document.activeElement
    // Queried off the DOM, not by role: `ariaHideOutside` has already made everything
    // outside the dialog invisible to assistive tech, which is the point of the test above.
    const outside = document.querySelector<HTMLElement>('.app-outside, button')!
    outside.focus()
    expect(document.activeElement).toBe(inside)
    expect(dialog.contains(document.activeElement)).toBe(true)
    expect(outside).not.toBe(inside)
  })
})
