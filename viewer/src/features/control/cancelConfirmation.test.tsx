// @vitest-environment jsdom
//
// One invariant, from panel round 4's item-12 partial: §7.2's per-agent cancel verdict is
// about a request THIS session made, so it survives the agent it was aimed at settling.
//
// The defect it pins was found as a flaky test rather than as a bug report, which is the
// interesting part. `CancelAgentButton` renders "cancel sent" only while `cancellable`
// holds, and `cancellable` goes false the moment a snapshot reports the agent settled —
// which, after a cancel that worked, is immediately. The engine writes the agent's
// `cancelled` event BEFORE it answers the control request (src/engine.js), so the settle
// can reach the client over the live feed before the reply that sets `done` does. Lose
// that race and the operator's confirmation is never rendered at all: the walkthrough's
// 20s `waitFor` for a `role=status` matching /cancel sent/i could not recover, because
// there was nothing left to wait for.
//
// So this is not a test about a test. "Did my cancel land?" must not be answerable only
// by winning a race against the thing being cancelled.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SteerComposer } from './SteerComposer.js'
import { IconSprite } from '../../ui/Icon.js'
import { LIVE_RUN } from '../cockpit/fixtures.js'
import type { AgentView, RunDetail } from '../../api/types.js'

afterEach(() => { cleanup() })

const agentIn = (detail: RunDetail, state: AgentView['state']): AgentView =>
  detail.agents.find((agent) => agent.state === state)!

const view = (agent: AgentView, runLive: boolean, cancelAgentFn: () => Promise<unknown>) => (
  <>
    <IconSprite />
    <SteerComposer
      runId={LIVE_RUN.runId} detail={LIVE_RUN} agent={agent} runLive={runLive}
      capabilities={['send', 'cancel', 'answer', 'resume', 'delete']}
      sendFn={async () => ({ delivery: 'live' })}
      cancelAgentFn={cancelAgentFn as never}
    />
  </>
)

describe('§7.2 the per-agent cancel verdict outlives its target', () => {
  const running = () => agentIn(LIVE_RUN, 'running')
  const settled = (): AgentView => ({ ...running(), state: 'cancelled', displayState: 'cancelled' })

  const cancelThrough = async (cancelAgentFn: () => Promise<unknown>) => {
    const rendered = render(view(running(), true, cancelAgentFn))
    fireEvent.click(screen.getByRole('button', { name: /Cancel agent/ }))
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`^Cancel agent ${running().index}\\?$`) }))
    return rendered
  }

  it('keeps "cancel sent" after the snapshot reports the agent settled', async () => {
    const { rerender } = await cancelThrough(async () => ({ scope: 'agent', cancelled: running().index }))
    await screen.findByText(/cancel sent/i)

    // The refresh the cancel itself triggered, arriving: the agent is gone, the button is
    // correctly refused — and the verdict is still on screen.
    rerender(view(settled(), true, async () => ({ scope: 'agent', cancelled: 0 })))
    expect(screen.getByRole('button', { name: /Cancel agent/ })).toHaveProperty('disabled', true)
    const status = await screen.findByRole('status')
    expect(status.textContent).toMatch(/cancel sent/i)
  })

  it('keeps it when the whole RUN goes terminal underneath it', async () => {
    const { rerender } = await cancelThrough(async () => ({ scope: 'agent', cancelled: running().index }))
    await screen.findByText(/cancel sent/i)
    rerender(view(running(), false, async () => ({ scope: 'agent', cancelled: 0 })))
    expect((await screen.findByRole('status')).textContent).toMatch(/cancel sent/i)
  })

  /**
   * The settle can beat the reply, not just follow it — that is the ordering the engine
   * actually produces. The component is already in its refused branch when `done` lands,
   * and the verdict still has to appear.
   */
  it('renders the verdict even when the settle arrives BEFORE the reply', async () => {
    let release!: (value: unknown) => void
    const pending = new Promise((resolve) => { release = resolve })
    const { rerender } = await cancelThrough(async () => pending)

    rerender(view(settled(), true, async () => pending))
    expect(screen.queryByRole('status')).toBeNull()          // nothing claimed yet

    release({ scope: 'agent', cancelled: 0 })
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/cancel sent/i))
  })

  it('keeps a FAILED cancel’s error too — a refusal is a verdict as well', async () => {
    const { rerender } = await cancelThrough(async () => { throw new Error('control socket gone') })
    await screen.findByRole('alert')
    rerender(view(settled(), true, vi.fn()))
    expect(await screen.findByRole('alert')).toBeTruthy()
    // …and it does not double up as a success.
    expect(screen.queryByText(/cancel sent/i)).toBeNull()
  })
})
