// @vitest-environment jsdom
//
// §7.1.4 injection site 2: `usePreventScroll`, which every `ControlDialog` invokes.
//
// The point of this file is that the constants in `preventScrollStyle.ts` are not a
// transcription of what react-aria's source LOOKS like — they are checked against what a
// real modal actually puts in `document.head` on a real iOS platform string. The digest
// in the server's CSP is then derived here, so the three links (react-aria's bytes → the
// exported hash → the shipped policy) cannot drift apart silently. The third link is
// asserted by `test/viewer-http.test.js`; the browser-level proof that the rule is
// actually APPLIED and not merely permitted is the iOS gate in `e2e/viewer.spec.ts`.
//
// react-aria decides iOS from `navigator.userAgentData?.platform || navigator.platform`
// (`react-aria/dist/private/utils/platform.mjs`), and skips its result cache when
// `NODE_ENV === 'test'` — which vitest sets — so the platform can be swapped per test.

import { createElement, useState } from 'react'
import { createHash } from 'node:crypto'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlDialog } from '../features/control/Dialog.js'
import { PREVENT_SCROLL_RULE, PREVENT_SCROLL_STYLE_HASH } from './preventScrollStyle.js'

afterEach(() => {
  cleanup()
  setPlatform('MacIntel')
})

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true })
}

/** Every `<style>` react-aria has prepended to the head right now. */
function injectedStyles(): HTMLStyleElement[] {
  return [...document.head.querySelectorAll('style')]
}

function Harness() {
  const [open, setOpen] = useState(false)
  return createElement(
    'div',
    null,
    createElement('button', { type: 'button', onClick: () => setOpen(true) }, 'Open'),
    open
      ? createElement(
        ControlDialog,
        { name: 'probe', title: 'Confirm', description: 'what it does', onClose: () => setOpen(false) },
        createElement('input', { 'aria-label': 'a field' }),
      )
      : null,
  )
}

const openDialog = () => {
  fireEvent.click(screen.getByRole('button', { name: 'Open' }))
  return screen.getByRole('dialog')
}
const closeDialog = () => { fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' }) }

describe('§7.1.4 usePreventScroll style injection', () => {
  it('injects exactly the rule the CSP hash admits, on an iOS platform', () => {
    setPlatform('iPhone')
    render(createElement(Harness))
    expect(injectedStyles(), 'nothing injected before a modal exists').toEqual([])

    openDialog()
    const styles = injectedStyles()
    expect(styles, 'the iOS modal path must inject exactly one <style>').toHaveLength(1)
    // The assertion that matters: the bytes we hashed are the bytes react-aria ships.
    expect(styles[0]!.textContent).toBe(PREVENT_SCROLL_RULE)
    const digest = createHash('sha256').update(PREVENT_SCROLL_RULE, 'utf8').digest('base64')
    expect(`sha256-${digest}`).toBe(PREVENT_SCROLL_STYLE_HASH)
  })

  it('is modal-only: the rule goes away again when the modal closes', () => {
    setPlatform('iPhone')
    render(createElement(Harness))
    openDialog()
    expect(injectedStyles()).toHaveLength(1)
    // Scroll chaining out of a pane into the page is correct with no modal up, which is
    // why this rule is hash-allowed rather than hoisted into `ui/base.css` the way the
    // `usePress` declaration was.
    closeDialog()
    expect(injectedStyles(), 'the containment rule must not outlive its modal').toEqual([])
    expect(document.documentElement.style.overflow).toBe('')
  })

  it('injects nothing at all off iOS, so the hash is dead weight everywhere else', () => {
    setPlatform('MacIntel')
    render(createElement(Harness))
    openDialog()
    expect(injectedStyles()).toEqual([])
    closeDialog()
  })

  it('leaves the usePress slot claimed by a <meta>, not a <style>', () => {
    // The two injection sites are independent and resolved differently; a regression that
    // un-claims the usePress id would show up here as a second head <style> on iOS.
    setPlatform('iPhone')
    document.head.append(Object.assign(document.createElement('meta'), {
      id: 'react-aria-pressable-style',
    }))
    render(createElement(Harness))
    openDialog()
    expect(document.getElementById('react-aria-pressable-style')?.tagName).toBe('META')
    expect(injectedStyles()).toHaveLength(1)
  })
})
