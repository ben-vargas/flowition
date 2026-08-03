// @vitest-environment jsdom
//
// §7.2's confirmation contracts, row by row. The acceptance criterion is that the mapping
// table is EXACT — so each test names the row it pins:
//
//   cancel run  → modal, two-step, DEFAULT FOCUS ON KEEP, pending disables (no double-cancel)
//   resume      → modal, distinct replay/recover copy, "launch accepted and nothing more"
//   delete      → modal, TYPE-TO-CONFIRM the runId, trash + 7-day purge, lands in trash

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CancelRunDialog, DeleteDialog, ResumeDialog } from './Confirmations.js'
import { IconSprite } from '../../ui/Icon.js'

afterEach(cleanup)

const RUN = { runId: 'r_2f91c4a8', name: 'judge-panel-auth-refactor' }
const apiError = (status: number, code: string, message: string) =>
  Object.assign(new Error(message), { status, code })

const later = <T,>(value: T) => {
  let release!: (v: T) => void
  const promise = new Promise<T>((resolve) => { release = resolve })
  return { promise, resolve: () => release(value) }
}

describe('§7.2 cancel the whole run', () => {
  it('is a two-step modal whose DEFAULT FOCUS is Keep running', () => {
    render(<><IconSprite /><CancelRunDialog
      run={{ ...RUN, state: 'running' }} onClose={() => {}}
      cancelRunFn={async () => ({ scope: 'run', cancelled: 'run' })}
    /></>)
    expect(screen.getByRole('heading', { name: /Cancel run judge-panel-auth-refactor/ })).toBeTruthy()
    expect(screen.getByText(/Agents in flight will be killed/)).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Keep running' }))
  })

  it('disables the destructive button while the request is in flight (no double-cancel)', async () => {
    const gate = later({ scope: 'run' as const })
    const cancelRunFn = vi.fn(() => gate.promise)
    render(<><IconSprite /><CancelRunDialog
      run={RUN} onClose={() => {}} cancelRunFn={cancelRunFn}
    /></>)
    const button = screen.getByRole('button', { name: /Cancel run/ })
    fireEvent.click(button)
    await screen.findByRole('button', { name: /Cancelling…/ })
    fireEvent.click(screen.getByRole('button', { name: /Cancelling…/ }))
    fireEvent.click(screen.getByRole('button', { name: /Cancelling…/ }))
    gate.resolve()
    await waitFor(() => expect(cancelRunFn).toHaveBeenCalledTimes(1))
  })

  it('closes with a status outcome the caller can toast', async () => {
    const onClose = vi.fn()
    const onDone = vi.fn()
    render(<><IconSprite /><CancelRunDialog
      run={RUN} onClose={onClose} onDone={onDone}
      cancelRunFn={async () => ({ scope: 'run', cancelled: 'run' })}
    /></>)
    fireEvent.click(screen.getByRole('button', { name: /Cancel run/ }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onDone.mock.calls[0]![0].message).toContain('Cancel sent to r_2f91c4a8')
  })

  it('says so when the server cancelled ONE AGENT instead of the run (critique N5)', async () => {
    const onDone = vi.fn()
    render(<><IconSprite /><CancelRunDialog
      run={RUN} onClose={() => {}} onDone={onDone}
      cancelRunFn={async () => ({ scope: 'agent', cancelled: 3 })}
    /></>)
    fireEvent.click(screen.getByRole('button', { name: /Cancel run/ }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(onDone.mock.calls[0]![0]).toMatchObject({ tone: 'warn' })
    expect(onDone.mock.calls[0]![0].message).toContain('not the run')
  })

  it('surfaces the server’s own words on a 503, with §7.2’s retry hint', async () => {
    render(<><IconSprite /><CancelRunDialog
      run={RUN} onClose={() => {}}
      cancelRunFn={async () => { throw apiError(503, 'run_not_live', 'run is not live — it may have finished') }}
    /></>)
    fireEvent.click(screen.getByRole('button', { name: /Cancel run/ }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('run is not live')
    expect(alert.textContent).toContain('2s')
    // The dialog stays up: a failed mutation the operator cannot see is the failure mode.
    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

describe('§7.3 resume / replay', () => {
  it('uses REPLAY copy for a completed run', () => {
    render(<><IconSprite /><ResumeDialog
      run={{ ...RUN, state: 'completed' }} onClose={() => {}}
      resumeFn={async () => ({ mode: 'replay', launchAccepted: true })}
    /></>)
    expect(screen.getByRole('heading', { name: /Replay/ })).toBeTruthy()
    expect(screen.getByText(/no providers are re-invoked unless control flow changes/)).toBeTruthy()
  })

  it('uses RECOVER copy for a stale run, and states the integrity scope either way', () => {
    render(<><IconSprite /><ResumeDialog
      run={{ ...RUN, state: 'stale' }} onClose={() => {}}
      resumeFn={async () => ({ mode: 'resume', launchAccepted: true })}
    /></>)
    expect(screen.getByRole('heading', { name: /Resume/ })).toBeTruthy()
    expect(screen.getByText(/detached process/)).toBeTruthy()
    // §1.3 / §7.3: local graph pinned, environment and packages NOT.
    expect(screen.getByText(/does/).textContent).toMatch(/not.*cover/s)
    expect(screen.getByText(/installed packages/)).toBeTruthy()
  })

  it('reports 202 as LAUNCH ACCEPTED and nothing more (§7.3)', async () => {
    const onDone = vi.fn()
    render(<><IconSprite /><ResumeDialog
      run={{ ...RUN, state: 'stale' }} onClose={() => {}} onDone={onDone}
      resumeFn={async () => ({ mode: 'resume', launchAccepted: true })}
    /></>)
    fireEvent.click(screen.getByRole('button', { name: /Resume run/ }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(onDone.mock.calls[0]![0].message).toContain('launch accepted, nothing more')
  })

  it('states graphDynamic in all THREE of its states (§7.3 × §6.5)', () => {
    const { unmount } = render(<><IconSprite /><ResumeDialog
      run={{ ...RUN, state: 'stale', graphDynamic: true }} onClose={() => {}}
      resumeFn={async () => ({})}
    /></>)
    expect(screen.getByText(/graph was dynamic/)).toBeTruthy()
    unmount()

    // `false` is a POSITIVE fact the journal recorded, and it is not the same statement as
    // "we do not know" — the preflight has a graph hash to compare in one case and the
    // viewer is guessing in the other.
    const second = render(<><IconSprite /><ResumeDialog
      run={{ ...RUN, state: 'stale', graphDynamic: false }} onClose={() => {}}
      resumeFn={async () => ({})}
    /></>)
    expect(screen.getByText(/statically verifiable module graph/)).toBeTruthy()
    expect(screen.queryByText(/graph was dynamic/)).toBeNull()
    second.unmount()

    // Absent → an OLD RUN, journalled before `meta.graphDynamic` existed (§6.5). Not a
    // claim that the graph was static.
    render(<><IconSprite /><ResumeDialog
      run={{ ...RUN, state: 'stale' }} onClose={() => {}} resumeFn={async () => ({})}
    /></>)
    expect(screen.getByText(/journalled before the engine recorded/)).toBeTruthy()
  })

  /**
   * The fourth state, and the reason round 2 needed one: "the snapshot said nothing" and
   * "nothing read the snapshot" are different facts, and only the first is §6.5's. A
   * caller with no `RunDetail` in hand (Home, before it fetches one) that passes a bare
   * `null` makes a false claim about the run AND drops the preflight warning.
   */
  it('distinguishes an UNREADABLE snapshot from an old run (§6.5 is not a catch-all)', () => {
    render(<><IconSprite /><ResumeDialog
      run={{ ...RUN, state: 'stale', graphDynamic: null, graphSource: 'unavailable' }}
      onClose={() => {}} resumeFn={async () => ({})}
    /></>)
    expect(screen.getByText(/could not read the run/)).toBeTruthy()
    expect(screen.queryByText(/journalled before the engine recorded/)).toBeNull()
    expect(screen.queryByText(/statically verifiable module graph/)).toBeNull()
  })

  it('surfaces a 409 as the conflict it is, not as a generic failure', async () => {
    render(<><IconSprite /><ResumeDialog
      run={{ ...RUN, state: 'running' }} onClose={() => {}}
      resumeFn={async () => { throw apiError(409, 'conflict', 'run r_2f91c4a8 is running — cancel it before resuming') }}
    /></>)
    fireEvent.click(screen.getByRole('button', { name: /Resume run/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('cancel it before resuming')
  })
})

describe('§7.3 delete', () => {
  const mount = (deleteFn: (runId: string) => Promise<Record<string, unknown>>, onDone = vi.fn()) => {
    render(<><IconSprite /><DeleteDialog
      run={RUN} onClose={() => {}} onDone={onDone} deleteFn={deleteFn}
    /></>)
    return onDone
  }

  it('is TYPE-TO-CONFIRM: Delete stays disabled until the runId matches exactly', () => {
    mount(async () => ({}))
    const button = screen.getByRole('button', { name: /Delete run/ })
    const input = screen.getByLabelText(/Type/)
    const disabled = () => (button as HTMLButtonElement).disabled
    expect(disabled()).toBe(true)
    for (const near of ['r_2f91c4a', 'R_2F91C4A8', ' r_2f91c4a8 ', 'r_2f91c4a8x']) {
      fireEvent.change(input, { target: { value: near } })
      expect(disabled(), `"${near}" must not unlock delete`).toBe(true)
    }
    fireEvent.change(input, { target: { value: 'r_2f91c4a8' } })
    expect(disabled()).toBe(false)
  })

  it('states the trash contract before the operator commits', () => {
    mount(async () => ({}))
    expect(screen.getByText(/moves the run to flowition's trash|moves the run to flowition’s trash/)).toBeTruthy()
    expect(screen.getByText(/purged after 7 days/)).toBeTruthy()
  })

  it('reports WHERE it went — the trash entry and the purge window', async () => {
    const onDone = mount(async () => ({
      ok: true, trashEntry: 'r_2f91c4a8.1764000000000', trashedAt: 1, trashTtlDays: 7,
    }))
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: RUN.runId } })
    fireEvent.click(screen.getByRole('button', { name: /Delete run/ }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(onDone.mock.calls[0]![0].message).toContain('r_2f91c4a8.1764000000000')
    expect(onDone.mock.calls[0]![0].message).toContain('purged after 7 days')
  })

  it('surfaces the server’s 409 on a live run instead of pretending it worked', async () => {
    mount(async () => { throw apiError(409, 'conflict', 'run r_2f91c4a8 is running — refuse') })
    fireEvent.change(screen.getByLabelText(/Type/), { target: { value: RUN.runId } })
    fireEvent.click(screen.getByRole('button', { name: /Delete run/ }))
    expect((await screen.findByRole('alert')).textContent).toContain('is running')
  })

  it('takes focus on the confirm input, so the destructive button is never the default', () => {
    mount(async () => ({}))
    expect(document.activeElement).toBe(screen.getByLabelText(/Type/))
  })
})
