// @vitest-environment jsdom
//
// The toast lifecycle, and the reason it needed one: a reviewer's resume toast sat over the
// transcript for minutes and swallowed the first click on the steer composer's Send.
//
// Two independent defences are asserted here, because either alone is insufficient:
//   • the toast EXPIRES (with pause-on-hover and pause-on-focus, and the explicit Dismiss
//     still there), so a notice cannot outlive its own relevance;
//   • the toast LAYER is lifted above whatever bottom-docked control the screen has
//     (`--action-floor`) and does not intercept clicks in the space around it.
// The real-geometry proof — a visible toast and Send simultaneously clickable at a real
// 1280px viewport — is `e2e/viewer.spec.ts`; this file owns the units beneath it.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Toasts, TOAST_MAX_MS, TOAST_MIN_MS, toastDurationMs } from './Confirmations.js'
import { IconSprite } from '../../ui/Icon.js'
import { actionFloor, claimActionFloor, resetActionFloor } from './actionFloor.js'

afterEach(() => { cleanup(); resetActionFloor(); vi.useRealTimers(); vi.restoreAllMocks() })
beforeEach(() => { resetActionFloor() })

const RESUME = 'Resume launched for flo_x — launch accepted, nothing more; the preflight’s verdict arrives in the run’s own events.'

describe('toast lifecycle (§3.6)', () => {
  it('scales its lifetime to its copy, within a floor and a ceiling', () => {
    expect(toastDurationMs('ok')).toBe(TOAST_MIN_MS)
    expect(toastDurationMs('x'.repeat(10_000))).toBe(TOAST_MAX_MS)
    const mid = toastDurationMs(RESUME)
    expect(mid).toBeGreaterThan(TOAST_MIN_MS)
    expect(mid).toBeLessThanOrEqual(TOAST_MAX_MS)
  })

  it('dismisses itself on a timeout', async () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(<Toasts items={[{ id: 1, message: RESUME }]} onDismiss={onDismiss} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(toastDurationMs(RESUME) - 1) })
    expect(onDismiss).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(2) })
    expect(onDismiss).toHaveBeenCalledWith(1)
  })

  it('does not expire while the pointer is over it, and restarts when it leaves', async () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(<Toasts items={[{ id: 7, message: 'short' }]} onDismiss={onDismiss} />)
    const toast = document.querySelector('.ctl-toast')!
    fireEvent.mouseEnter(toast)
    await act(async () => { await vi.advanceTimersByTimeAsync(TOAST_MAX_MS * 3) })
    expect(onDismiss).not.toHaveBeenCalled()
    fireEvent.mouseLeave(toast)
    await act(async () => { await vi.advanceTimersByTimeAsync(TOAST_MAX_MS) })
    expect(onDismiss).toHaveBeenCalledWith(7)
  })

  it('does not expire while focus is inside it — the Dismiss button must stay reachable', async () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(<><IconSprite /><Toasts items={[{ id: 2, message: 'short' }]} onDismiss={onDismiss} /></>)
    fireEvent.focus(screen.getByRole('button', { name: 'Dismiss' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(TOAST_MAX_MS * 3) })
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('keeps §3.6’s role=status and the explicit Dismiss', () => {
    const onDismiss = vi.fn()
    render(<><IconSprite /><Toasts items={[{ id: 3, message: 'done' }]} onDismiss={onDismiss} /></>)
    expect(document.querySelector('.ctl-toast')!.getAttribute('role')).toBe('status')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalledWith(3)
  })

  it('gives each toast its own clock — one expiring does not take the others', async () => {
    vi.useFakeTimers()
    const onDismiss = vi.fn()
    render(<Toasts items={[{ id: 1, message: 'a' }, { id: 2, message: 'x'.repeat(400) }]} onDismiss={onDismiss} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(TOAST_MIN_MS + 1) })
    expect(onDismiss.mock.calls.map((c) => c[0])).toEqual([1])
  })
})

describe('the action floor — the toast layer is lifted, not merely click-through', () => {
  const rect = (el: Element, height: number, bottom: number) => {
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      height, bottom, top: bottom - height, left: 0, right: 0, width: 100, x: 0, y: 0,
      toJSON: () => ({}),
    } as DOMRect)
  }

  it('is 0 when nothing is docked — the shipped geometry, unchanged', () => {
    expect(actionFloor()).toBe(0)
    expect(document.documentElement.style.getPropertyValue('--action-floor')).toBe('')
  })

  it('reserves a docked composer’s height plus its gap to the viewport floor', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const foot = document.createElement('footer')
    document.body.appendChild(foot)
    rect(foot, 48, 900)
    const claim = claimActionFloor(foot)
    expect(actionFloor()).toBe(48)
    expect(document.documentElement.style.getPropertyValue('--action-floor')).toBe('48px')
    claim.release()
    expect(actionFloor()).toBe(0)
    foot.remove()
  })

  it('takes the TALLEST of two claims — compare mode has two composers', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const a = document.createElement('footer')
    const b = document.createElement('footer')
    document.body.append(a, b)
    rect(a, 40, 900)
    rect(b, 72, 900)
    const ca = claimActionFloor(a)
    const cb = claimActionFloor(b)
    expect(actionFloor()).toBe(72)
    // One pane closing must not clear the other's reservation.
    cb.release()
    expect(actionFloor()).toBe(40)
    ca.release()
    expect(actionFloor()).toBe(0)
    a.remove(); b.remove()
  })

  it('reserves nothing for furniture that is not against the viewport floor', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const foot = document.createElement('footer')
    document.body.appendChild(foot)
    // A zero-height (unrendered) element reserves nothing at all.
    rect(foot, 0, 400)
    const claim = claimActionFloor(foot)
    expect(actionFloor()).toBe(0)
    claim.release()
    foot.remove()
  })

  it('drops the claim when the element leaves the document', () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 })
    const foot = document.createElement('footer')
    document.body.appendChild(foot)
    rect(foot, 60, 900)
    const claim = claimActionFloor(foot)
    expect(actionFloor()).toBe(60)
    foot.remove()
    claim.measure()
    expect(actionFloor()).toBe(0)
    claim.release()
  })
})
