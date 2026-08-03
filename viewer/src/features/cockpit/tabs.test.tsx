// @vitest-environment jsdom
//
// The cockpit's tab strip, after §16.3's ruling that React Aria's hooks — not hand-wired
// `aria-selected` buttons — are the implementation vehicle for "tabs where used".
//
// These assert the BEHAVIOR the hooks bring, which is exactly what a hand-wired strip
// silently lacked: a single Tab stop for the whole group, arrow navigation with wrap, and a
// real `role=tabpanel` for `aria-controls` to point at. §2.7's `[`/`]` remain the cockpit's
// own global shortcuts and are re-asserted here so the two systems are known to coexist.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Cockpit } from './Cockpit.js'
import { IconSprite } from '../../ui/Icon.js'
import { LIVE_RUN, NOW, fixedApi } from './fixtures.js'
import { resetRouteForTests } from '../../app/router.js'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  window.location.hash = '#/'
  resetRouteForTests()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

const mount = async () => {
  render(
    <>
      <IconSprite />
      <Cockpit runId={LIVE_RUN.runId} storeApi={fixedApi(LIVE_RUN)} />
    </>,
  )
  await screen.findByRole('tablist')
}

const tabs = () => screen.getAllByRole('tab') as HTMLButtonElement[]
const selected = () => tabs().find((tab) => tab.getAttribute('aria-selected') === 'true')!

describe('§16.3 — the cockpit tabs are React Aria’s', () => {
  it('is ONE Tab stop: roving tabindex, not three tabbable buttons (§3.6)', async () => {
    await mount()
    const tabbable = tabs().filter((tab) => tab.tabIndex >= 0)
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]).toBe(selected())
    // The unselected ones are reachable by arrow key, not by Tab — which is the whole
    // promise `role="tablist"` makes and the reason the roving index exists.
    for (const tab of tabs()) {
      if (tab !== selected()) expect(tab.tabIndex).toBe(-1)
    }
  })

  it('moves the selection with the arrow keys, and wraps', async () => {
    await mount()
    const [timeline, structure, agents] = tabs()
    expect(selected()).toBe(timeline)

    timeline!.focus()
    fireEvent.keyDown(timeline!, { key: 'ArrowRight' })
    expect(selected()).toBe(structure)

    fireEvent.keyDown(selected(), { key: 'ArrowRight' })
    expect(selected()).toBe(agents)

    // Wrap: past the end is the beginning, which a hand-wired `onClick`-only strip has no
    // opinion about at all.
    fireEvent.keyDown(selected(), { key: 'ArrowRight' })
    expect(selected()).toBe(timeline)

    fireEvent.keyDown(selected(), { key: 'End' })
    expect(selected()).toBe(agents)
    fireEvent.keyDown(selected(), { key: 'Home' })
    expect(selected()).toBe(timeline)
  })

  it('names a real tabpanel after every selection, so aria-controls never dangles', async () => {
    await mount()
    const assertPair = () => {
      const panel = screen.getByRole('tabpanel')
      expect(selected().getAttribute('aria-controls')).toBe(panel.id)
      expect(panel.getAttribute('aria-labelledby')).toBe(selected().id)
    }
    assertPair()
    fireEvent.click(screen.getByRole('tab', { name: /Structure/ }))
    assertPair()
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    assertPair()
    // …and the panel adds no box to the cockpit column (`display: contents`), so the three
    // tabs lay out exactly as the approved comps photographed them.
    expect(screen.getByRole('tabpanel').className).toBe('tabpanel')
  })

  it('still switches on §2.7’s `[` and `]` from anywhere on the page', async () => {
    await mount()
    const [timeline, structure, agents] = tabs()
    fireEvent.keyDown(window, { key: ']' })
    expect(selected()).toBe(structure)
    fireEvent.keyDown(window, { key: ']' })
    expect(selected()).toBe(agents)
    fireEvent.keyDown(window, { key: '[' })
    expect(selected()).toBe(structure)
    fireEvent.keyDown(window, { key: '[' })
    expect(selected()).toBe(timeline)
  })

  it('still switches on click, and the panel follows', async () => {
    await mount()
    fireEvent.click(screen.getByRole('tab', { name: /Agents/ }))
    expect(selected().textContent).toContain('Agents')
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(selected().id)
  })
})
