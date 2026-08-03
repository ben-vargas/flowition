// @vitest-environment jsdom
//
// The focus handoff §7.3's successful delete uses, on its own. The end of the path — the
// operator landing on Home's heading after a real delete through a real server — is
// asserted in `features/control/e2e.test.tsx`; what is asserted here is the part that test
// cannot observe from the outside: the INTERIM, which exists so focus never passes through
// `<body>` in the window between "the run is gone" and "Home is on screen".

import { afterEach, describe, expect, it } from 'vitest'
import { cancelLandingFocus, claimLandingFocus, landingFocusPending, requestLandingFocus } from './landing.js'

afterEach(() => {
  cancelLandingFocus()
  document.body.replaceChildren()
})

/** The shell's two landing targets, built the way the app builds them (no HTML sinks). */
const shell = (withHome: boolean) => {
  document.body.replaceChildren()
  const runs = document.createElement('a')
  runs.href = '#/'
  runs.dataset.landing = 'runs'
  runs.textContent = 'Runs'
  document.body.append(runs)
  let home: HTMLElement | null = null
  if (withHome) {
    home = document.createElement('h1')
    home.tabIndex = -1
    home.dataset.landing = 'home'
    home.textContent = 'Runs'
    document.body.append(home)
  }
  return { runs, home }
}

describe('the delete focus handoff (§3.6)', () => {
  it('parks on the shell’s Runs control while the route is still in flight', () => {
    const { runs } = shell(false)
    requestLandingFocus()
    expect(document.activeElement).toBe(runs)
    // Still armed: the interim is not the destination.
    expect(landingFocusPending()).toBe(true)
  })

  it('hands over to Home’s heading when Home mounts, once', () => {
    shell(false)
    requestLandingFocus()
    const { home } = shell(true)          // the route committed; Home is now in the document
    expect(claimLandingFocus()).toBe(true)
    expect(document.activeElement).toBe(home)
    expect(landingFocusPending()).toBe(false)

    // Disarmed: a later Home mount does not steal focus from wherever the operator is.
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    elsewhere.focus()
    expect(claimLandingFocus()).toBe(false)
    expect(document.activeElement).toBe(elsewhere)
  })

  it('does nothing at all when no handoff was requested', () => {
    const { runs, home } = shell(true)
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    elsewhere.focus()
    expect(claimLandingFocus()).toBe(false)
    expect(document.activeElement).toBe(elsewhere)
    expect(document.activeElement).not.toBe(runs)
    expect(document.activeElement).not.toBe(home)
  })
})
