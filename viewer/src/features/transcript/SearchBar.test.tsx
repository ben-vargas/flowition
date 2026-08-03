// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SearchBar } from './SearchBar.js'

afterEach(cleanup)

describe('in-transcript search', () => {
  it('enforces the server 2–256 character query contract before sending', () => {
    const search = vi.fn()
    render(<SearchBar runId="r1" agent={3} open search={search} onClose={() => {}} onMatch={() => 'loaded'} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'x' } })
    expect((screen.getByRole('button', { name: 'Find' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.submit(screen.getByRole('search'))
    expect(search).not.toHaveBeenCalled()
    expect(input.getAttribute('maxlength')).toBe('256')
  })

  it('uses bounded server substring search, filters to this agent, and walks matches', async () => {
    const search = vi.fn(async () => ({
      matches: [
        { agent: 2, o: 10, kind: 'text', snippet: 'other' },
        { agent: 3, o: 20, kind: 'text', snippet: 'first' },
        { agent: 3, o: 30, kind: 'tool-result', snippet: 'second' },
      ],
      truncated: false,
    }))
    const onMatch = vi.fn(() => 'loaded' as const)
    render(<SearchBar runId="r1" agent={3} open search={search} onClose={() => {}} onMatch={onMatch} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'needle' } })
    fireEvent.submit(screen.getByRole('search'))
    await waitFor(() => expect(search).toHaveBeenCalledWith('r1', 'needle', expect.objectContaining({ limit: 200 })))
    await waitFor(() => expect(onMatch).toHaveBeenCalledWith(20))
    expect(screen.getByText('1/2')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }))
    expect(onMatch).toHaveBeenLastCalledWith(30)
  })

  it('reports no matches without throwing', async () => {
    render(<SearchBar runId="r1" agent={3} open search={async () => ({ matches: [], truncated: false })} onClose={() => {}} onMatch={() => 'loaded'} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'none' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByText('no matches in agent 3')).toBeTruthy()
  })

  it('does not claim an agent has no matches when the scan was truncated', async () => {
    render(<SearchBar runId="r1" agent={3} open search={async () => ({
      matches: [{ agent: 2, o: 10, kind: 'text', snippet: 'other' }],
      truncated: true,
    })} onClose={() => {}} onMatch={() => 'loaded'} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'needle' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByText(/no matches for agent 3 in the first 200 results — the scan stopped early/)).toBeTruthy()
    expect(screen.queryByText('no matches in agent 3')).toBeNull()
  })

  it('does not claim an agent has no matches when the result limit was saturated', async () => {
    render(<SearchBar runId="r1" agent={3} open search={async () => ({
      matches: Array.from({ length: 200 }, (_, index) => ({
        agent: 2, o: index + 1, kind: 'text', snippet: `other ${index}`,
      })),
      truncated: false,
    })} onClose={() => {}} onMatch={() => 'loaded'} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'needle' } })
    fireEvent.submit(screen.getByRole('search'))
    expect(await screen.findByText(/no matches for agent 3 in the first 200 results — the result limit was reached/)).toBeTruthy()
    expect(screen.queryByText('no matches in agent 3')).toBeNull()
  })

  it.each([
    ['before-window', 'before the loaded window'],
    ['after-window', 'after the loaded window'],
  ] as const)('surfaces a %s match instead of silently scrolling to an unrelated row', async (result, message) => {
    render(
      <SearchBar
        runId="r1"
        agent={3}
        open
        search={async () => ({
          matches: [{ agent: 3, o: 900, kind: 'text', snippet: 'outside' }],
          truncated: false,
        })}
        onClose={() => {}}
        onMatch={() => result}
      />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'outside' } })
    fireEvent.submit(screen.getByRole('search'))
    expect((await screen.findByRole('status')).textContent).toContain(message)
  })
})
