// @vitest-environment jsdom
//
// §11.1's DOM half, for the React binding. `lib/store.ts` is proven in the node
// environment; what needs a renderer is the `useSyncExternalStore` contract itself —
// that a commit reaches a mounted component, that a selector re-renders only when its
// slice moves, and that unmounting unsubscribes.

import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createStore, useStore, useStoreSelector } from './stores.js'

const renders = { full: 0, slice: 0 }
afterEach(() => { renders.full = 0; renders.slice = 0 })

interface State { n: number; label: string }

function Full({ store }: { store: ReturnType<typeof createStore<State>> }) {
  const state = useStore(store)
  renders.full++
  return <span data-testid="full">{state.n}:{state.label}</span>
}

function Slice({ store }: { store: ReturnType<typeof createStore<State>> }) {
  const label = useStoreSelector(store, (s) => s.label)
  renders.slice++
  return <span data-testid="slice">{label}</span>
}

describe('useStore / useStoreSelector', () => {
  it('renders the snapshot and re-renders on commit', () => {
    const store = createStore<State>({ n: 1, label: 'a' })
    render(<Full store={store} />)
    expect(screen.getByTestId('full').textContent).toBe('1:a')
    act(() => store.set({ n: 2, label: 'a' }))
    expect(screen.getByTestId('full').textContent).toBe('2:a')
  })

  it('a selector re-renders only when its slice moves', () => {
    const store = createStore<State>({ n: 1, label: 'a' })
    render(<Slice store={store} />)
    const before = renders.slice
    act(() => store.set({ n: 2, label: 'a' }))
    expect(renders.slice).toBe(before)
    act(() => store.set({ n: 3, label: 'b' }))
    expect(renders.slice).toBe(before + 1)
    expect(screen.getByTestId('slice').textContent).toBe('b')
  })

  it('unmounting unsubscribes — a store outliving its page leaks nothing', () => {
    const store = createStore<State>({ n: 1, label: 'a' })
    const view = render(<Full store={store} />)
    expect(store.listenerCount).toBe(1)
    view.unmount()
    expect(store.listenerCount).toBe(0)
    const listener = vi.fn()
    store.subscribe(listener)
    act(() => store.set({ n: 9, label: 'z' }))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
