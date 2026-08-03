// @vitest-environment jsdom
//
// The transcript footer's steer composer and per-agent cancel (§2.5, §7.2's `send` and
// per-agent `cancel` rows).
//
// The acceptance criterion this file carries is the honest one: "a queued send shows
// queued, a dropped send shows dropped with the reason". So every verdict the engine can
// return gets its own assertion, and so does a verdict from an engine newer than this build.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ARM_MS, SteerComposer, queuePosition } from './SteerComposer.js'
import { IconSprite } from '../../ui/Icon.js'
import { LIVE_RUN, NOW, UNSUPPORTED } from '../cockpit/fixtures.js'
import type { AgentView, RunDetail } from '../../api/types.js'

// Only `Date` is faked by default: `findBy*`/`waitFor` poll on real timers, and faking
// those deadlocks every asynchronous assertion in this file. The one test that needs the
// arm window to expire opts into fake `setTimeout` for its own duration.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterEach(() => { cleanup(); vi.useRealTimers() })

const agentIn = (detail: RunDetail, state: AgentView['state']): AgentView =>
  detail.agents.find((agent) => agent.state === state)!

const mount = (
  agent: AgentView,
  props: Partial<Parameters<typeof SteerComposer>[0]> = {},
  detail: RunDetail = LIVE_RUN,
) => {
  const sendFn = props.sendFn ?? vi.fn(async () => ({ delivery: 'live' }))
  const cancelAgentFn = props.cancelAgentFn ?? vi.fn(async () => ({ scope: 'agent' as const, cancelled: agent.index }))
  render(
    <>
      <IconSprite />
      <SteerComposer
        runId={detail.runId} detail={detail} agent={agent} runLive
        capabilities={['send', 'cancel', 'answer', 'resume', 'delete']}
        {...props}
        sendFn={sendFn} cancelAgentFn={cancelAgentFn}
      />
    </>,
  )
  return { sendFn, cancelAgentFn }
}

const input = () => document.querySelector<HTMLInputElement>('.steer-inp')!
const sendButton = () => screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement

describe('§2.5 steer composer — enablement', () => {
  it('is enabled for a RUNNING agent on a live run', () => {
    mount(agentIn(LIVE_RUN, 'running'))
    expect(input().disabled).toBe(false)
  })

  it('is disabled for a QUEUED agent, with §2.5’s reason and its queue position', () => {
    const queued = agentIn(LIVE_RUN, 'queued')
    mount(queued)
    expect(input().disabled).toBe(true)
    expect(screen.getByText(/hasn't started yet|hasn’t started yet/)).toBeTruthy()
    expect(screen.getByText(/in the queue/)).toBeTruthy()
  })

  it('refuses to invent a queue position on a pre-E4 run (§6.5)', () => {
    const old: RunDetail = { ...LIVE_RUN, caps: UNSUPPORTED }
    mount(agentIn(LIVE_RUN, 'queued'), {}, old)
    expect(screen.getByText(/queue position unavailable/)).toBeTruthy()
    expect(queuePosition(old, agentIn(LIVE_RUN, 'queued'))).toBeNull()
  })

  it('ranks queued agents by admission order, not by index', () => {
    const detail: RunDetail = {
      ...LIVE_RUN,
      agents: [
        { ...agentIn(LIVE_RUN, 'queued'), index: 9, state: 'queued', queuedAt: 100 },
        { ...agentIn(LIVE_RUN, 'queued'), index: 4, state: 'queued', queuedAt: 200 },
      ],
    }
    expect(queuePosition(detail, detail.agents[0]!)).toBe(1)
    expect(queuePosition(detail, detail.agents[1]!)).toBe(2)
  })

  it('is disabled for a SETTLED agent and says a send would be dropped', () => {
    mount(agentIn(LIVE_RUN, 'done'))
    expect(input().disabled).toBe(true)
    expect(screen.getByText(/would come back `dropped`/)).toBeTruthy()
  })

  it('is disabled when the RUN is not live, even for a `running` agent', () => {
    mount(agentIn(LIVE_RUN, 'running'), { runLive: false })
    expect(input().disabled).toBe(true)
    expect(screen.getByText(/run is not live/)).toBeTruthy()
  })

  it('is LOCKED with its explanation on a read-only viewer — never hidden', () => {
    mount(agentIn(LIVE_RUN, 'running'), { capabilities: [] })
    expect(input().disabled).toBe(true)
    expect(sendButton().disabled).toBe(true)
    expect(screen.getAllByText(/--control=send/).length).toBeGreaterThan(0)
    // …and the per-agent Cancel is locked too, with ITS own flag on the chip beside it —
    // as VISIBLE TEXT inside the chip, never a tooltip (round 6, B1).
    expect(screen.getByRole('button', { name: /Cancel agent/ })).toHaveProperty('disabled', true)
    const chips = [...document.querySelectorAll('.lock-chip')]
    expect(chips.some((chip) => chip.querySelector('.lock-why')?.textContent?.includes('--control=cancel')))
      .toBe(true)
    expect(chips.every((chip) => chip.getAttribute('title') === null)).toBe(true)
  })
})

describe('§7.2 delivery verdicts, surfaced verbatim', () => {
  const cases: [string, RegExp][] = [
    ['live', /delivered into the agent/],
    ['queued', /next turn/],
    ['replayed', /replay-suppressed/],
    ['dropped', /agent already settled/],
    ['pending', /before the agent started/],
  ]

  for (const [verdict, detail] of cases) {
    it(`shows \`${verdict}\` with the sentence that explains it`, async () => {
      mount(agentIn(LIVE_RUN, 'running'), { sendFn: async () => ({ delivery: verdict }) })
      fireEvent.change(input(), { target: { value: 'check the SSE endpoint' } })
      fireEvent.click(sendButton())
      const receipt = await screen.findByRole('status')
      expect(receipt.textContent).toContain(verdict)
      expect(receipt.textContent).toMatch(detail)
      expect(receipt.textContent).toContain('check the SSE endpoint')
    })
  }

  it('renders `dropped` in the amber tone §7.2 asks for', async () => {
    mount(agentIn(LIVE_RUN, 'running'), { sendFn: async () => ({ delivery: 'dropped' }) })
    fireEvent.change(input(), { target: { value: 'too late' } })
    fireEvent.click(sendButton())
    await screen.findByRole('status')
    expect(document.querySelector('.verdict-chip.t-warn')).toBeTruthy()
  })

  it('passes through a verdict from a NEWER engine instead of blanking it (§6.5)', async () => {
    mount(agentIn(LIVE_RUN, 'running'), { sendFn: async () => ({ delivery: 'teleported' }) })
    fireEvent.change(input(), { target: { value: 'hello' } })
    fireEvent.click(sendButton())
    const receipt = await screen.findByRole('status')
    expect(receipt.textContent).toContain('teleported')
    expect(receipt.textContent).toContain('does not know this verdict')
  })

  it('says "no verdict" when the engine reported none — never a fake success', async () => {
    mount(agentIn(LIVE_RUN, 'running'), { sendFn: async () => ({ delivery: null }) })
    fireEvent.change(input(), { target: { value: 'hello' } })
    fireEvent.click(sendButton())
    expect((await screen.findByRole('status')).textContent).toContain('no verdict')
  })

  it('sends on ⌘↵, addressed to this agent’s index', async () => {
    const { sendFn } = mount(agentIn(LIVE_RUN, 'running'))
    fireEvent.change(input(), { target: { value: 'look at auth.js' } })
    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(sendFn).toHaveBeenCalledWith(
      LIVE_RUN.runId, agentIn(LIVE_RUN, 'running').index, 'look at auth.js',
    ))
  })

  it('surfaces a failed send with the server’s words and keeps the text', async () => {
    mount(agentIn(LIVE_RUN, 'running'), {
      sendFn: async () => {
        throw Object.assign(new Error('run is not live — it may have finished'), {
          status: 503, code: 'run_not_live',
        })
      },
    })
    fireEvent.change(input(), { target: { value: 'keep this' } })
    fireEvent.click(sendButton())
    expect((await screen.findByRole('alert')).textContent).toContain('not live')
    expect(input().value).toBe('keep this')
  })
})

describe('§7.2 per-agent cancel — the inline arm', () => {
  /** The armed button, by its §7.2 text. `armed(5)` is exactly "Cancel agent 5?". */
  const armedButton = (index: number) =>
    screen.getByRole('button', { name: new RegExp(`^Cancel agent ${index}\\?$`) })

  it('arms rather than cancelling on the first press, and names the agent', () => {
    const { cancelAgentFn } = mount(agentIn(LIVE_RUN, 'running'))
    fireEvent.click(screen.getByRole('button', { name: /Cancel agent/ }))
    expect(cancelAgentFn).not.toHaveBeenCalled()
    expect(armedButton(agentIn(LIVE_RUN, 'running').index)).toBeTruthy()
  })

  /**
   * §7.2's confirmation is "Cancel agent 3?" verbatim — the canonical index, on a LABELLED
   * agent, which is every agent in this fixture (round 1, B2: the label had replaced the
   * index, so two agents sharing a label confirmed an ambiguous target).
   */
  it('confirms with the canonical INDEX even when the agent has a label', () => {
    const running = agentIn(LIVE_RUN, 'running')
    expect(running.label).toBe('review:tests')      // the label the old copy showed instead
    mount(running)
    fireEvent.click(screen.getByRole('button', { name: /Cancel agent/ }))
    const armed = armedButton(running.index)
    expect(armed.textContent).toBe(`Cancel agent ${running.index}?`)
    expect(armed.textContent).not.toContain(running.label!)
  })

  it('confirms a QUEUED agent by index too, as a removal from the queue', () => {
    const queued = agentIn(LIVE_RUN, 'queued')
    // A queued agent's cancel is enabled (§7.2: "the engine's abort covers admission").
    mount(queued)
    fireEvent.click(screen.getByRole('button', { name: /Remove from queue/ }))
    const armed = screen.getByRole('button', {
      name: new RegExp(`^Remove agent ${queued.index} from the queue\\?$`),
    })
    expect(armed.textContent).toBe(`Remove agent ${queued.index} from the queue?`)
  })

  it('disarms itself after 3s — an armed destructive button does not wait forever', () => {
    vi.useRealTimers()
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(NOW)
    const running = agentIn(LIVE_RUN, 'running')
    mount(running)
    fireEvent.click(screen.getByRole('button', { name: /Cancel agent/ }))
    act(() => { vi.advanceTimersByTime(ARM_MS + 10) })
    expect(screen.getByRole('button', { name: /^Cancel agent$/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Cancel agent \d+\?/ })).toBeNull()
  })

  /**
   * The armed hint says "Esc or wait to disarm", and round 1 (M1) shipped only the wait: on
   * the desktop surface Escape left the destructive action armed under an instruction that
   * said it would not. Both places the operator's focus can be — the armed button itself and
   * the composer beside it — disarm, because the handler is on the window.
   */
  describe('Escape disarms it, as the hint promises (round 1, M1)', () => {
    for (const from of ['the armed button', 'the steer input beside it']) {
      it(`from ${from}`, () => {
        const running = agentIn(LIVE_RUN, 'running')
        const { cancelAgentFn } = mount(running)
        fireEvent.click(screen.getByRole('button', { name: /Cancel agent/ }))
        expect(screen.getByText(/Esc or wait to disarm/)).toBeTruthy()
        fireEvent.keyDown(
          from === 'the armed button' ? armedButton(running.index) : input(),
          { key: 'Escape' },
        )
        expect(screen.getByRole('button', { name: /^Cancel agent$/ })).toBeTruthy()
        expect(screen.queryByRole('button', { name: /Cancel agent \d+\?/ })).toBeNull()
        expect(cancelAgentFn).not.toHaveBeenCalled()
      })
    }

    it('consumes the key, so one Escape does not also close what is behind it', () => {
      const seen: string[] = []
      const listener = (event: Event) => seen.push((event as KeyboardEvent).key)
      window.addEventListener('keydown', listener)
      try {
        mount(agentIn(LIVE_RUN, 'running'))
        fireEvent.click(screen.getByRole('button', { name: /Cancel agent/ }))
        fireEvent.keyDown(input(), { key: 'Escape' })
        expect(seen).toEqual([])
        // …and once disarmed it is out of the way again.
        fireEvent.keyDown(input(), { key: 'Escape' })
        expect(seen).toEqual(['Escape'])
      } finally {
        window.removeEventListener('keydown', listener)
      }
    })
  })

  it('cancels on the second press, with the agent index (never a run-scoped body)', async () => {
    const running = agentIn(LIVE_RUN, 'running')
    const { cancelAgentFn } = mount(running)
    fireEvent.click(screen.getByRole('button', { name: /Cancel agent/ }))
    fireEvent.click(armedButton(running.index))
    await waitFor(() => expect(cancelAgentFn).toHaveBeenCalledWith(LIVE_RUN.runId, running.index))
  })

  it('labels a queued agent’s cancel "Remove from queue" (§7.2)', () => {
    mount(agentIn(LIVE_RUN, 'queued'))
    expect(screen.getByRole('button', { name: /Remove from queue/ })).toBeTruthy()
  })

  it('reports a cancel that came back RUN-scoped as the surprise it is (N5)', async () => {
    const running = agentIn(LIVE_RUN, 'running')
    mount(running, {
      cancelAgentFn: async () => ({ scope: 'run' as const, cancelled: 'run' }),
    })
    fireEvent.click(screen.getByRole('button', { name: /Cancel agent/ }))
    fireEvent.click(armedButton(running.index))
    expect((await screen.findByRole('alert')).textContent).toContain('WHOLE RUN')
  })

  it('is disabled for an agent that has already settled', () => {
    mount(agentIn(LIVE_RUN, 'done'))
    expect(screen.getByRole('button', { name: /Cancel agent/ })).toHaveProperty('disabled', true)
  })
})
