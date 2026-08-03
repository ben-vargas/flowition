// @vitest-environment jsdom
//
// The durable answer-focus intent (§2.7) on its own, at the level the components cannot
// state: that recording an ask does NOT move focus, that satisfying it is a separate act
// that can happen commits later, and that an intent belonging to one run can never be
// satisfied by another run's composer.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ANSWER_COMPOSER, answerFocusPending, cancelAnswerFocus, claimAnswerFocus,
  requestAnswerFocus, subscribeAnswerFocus,
} from './answerFocus.js'

/** `removeChild`, not `innerHTML` — §7.1.6 forbids the sink anywhere under `viewer/src`. */
const clearBody = () => {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
}

/** A composer shaped the way the rail renders one: `.qitem` wrapping `.ans-inp`. */
const mountComposer = (id = 'first'): HTMLInputElement => {
  const item = document.createElement('div')
  item.className = 'qitem'
  const input = document.createElement('input')
  input.className = 'inp ans-inp'
  input.id = id
  item.appendChild(input)
  document.body.appendChild(item)
  return input
}

beforeEach(() => { clearBody() })
afterEach(() => { cancelAnswerFocus(); clearBody() })

describe('the answer-focus intent', () => {
  it('records without focusing — the requester may still own focus', () => {
    const box = mountComposer()
    const elsewhere = document.createElement('button')
    document.body.appendChild(elsewhere)
    elsewhere.focus()

    requestAnswerFocus('r_1')
    // THE fix for round-3 B1: the palette runs its action while its own FocusScope is still
    // mounted, so a request that focused here would be undone a tick later.
    expect(document.activeElement).toBe(elsewhere)
    expect(answerFocusPending('r_1')).toBe(true)

    expect(claimAnswerFocus('r_1')).toBe(true)
    expect(document.activeElement).toBe(box)
    expect(answerFocusPending('r_1')).toBe(false)
  })

  it('survives until a composer exists — no timer, no retry loop', () => {
    requestAnswerFocus('r_1')
    expect(claimAnswerFocus('r_1')).toBe(false)   // the rail is collapsed: nothing to focus
    expect(claimAnswerFocus('r_1')).toBe(false)
    expect(answerFocusPending('r_1')).toBe(true)  // …and it is still armed

    const box = mountComposer()                   // the commit that opened the rail
    expect(claimAnswerFocus('r_1')).toBe(true)
    expect(document.activeElement).toBe(box)
  })

  it('takes the FIRST composer — §2.7 says the first open question', () => {
    const first = mountComposer('a')
    mountComposer('b')
    requestAnswerFocus('r_1')
    claimAnswerFocus('r_1')
    expect(document.activeElement).toBe(first)
    expect(document.querySelectorAll(ANSWER_COMPOSER).length).toBe(2)
  })

  it('is scoped to its run: another run’s inbox cannot satisfy it', () => {
    mountComposer()
    requestAnswerFocus('r_1')
    expect(claimAnswerFocus('r_2')).toBe(false)
    expect(document.activeElement).not.toBe(document.querySelector(ANSWER_COMPOSER))
    expect(answerFocusPending('r_2')).toBe(false)
    expect(answerFocusPending('r_1')).toBe(true)
  })

  it('is consumed by a composer that refuses focus, rather than staying armed', () => {
    const box = mountComposer()
    box.disabled = true                            // a read-only viewer's locked composer
    requestAnswerFocus('r_1')
    expect(claimAnswerFocus('r_1')).toBe(false)    // focus did not land…
    expect(answerFocusPending('r_1')).toBe(false)  // …and the intent does not linger
  })

  it('announces itself so a rail that will not re-render can open', () => {
    const seen: number[] = []
    const off = subscribeAnswerFocus(() => seen.push(1))
    requestAnswerFocus('r_1')
    requestAnswerFocus('r_1')
    off()
    requestAnswerFocus('r_1')
    expect(seen.length).toBe(2)
  })

  it('can be cancelled — a superseding palette open must not fire into the next surface', () => {
    mountComposer()
    requestAnswerFocus('r_1')
    cancelAnswerFocus()
    expect(answerFocusPending('r_1')).toBe(false)
    expect(claimAnswerFocus('r_1')).toBe(false)
  })
})
