/**
 * §9.2's `state/stores.ts` — the `useSyncExternalStore` pattern.
 *
 * The store primitive itself is React-free and lives in `lib/store.ts`, so every store in
 * this directory is testable in the node environment without a renderer (§11.1's split
 * exists because a suite of pure tests can pass while the composition is broken). This
 * module is the React binding and nothing more.
 */

import { useSyncExternalStore } from 'react'
import { createStore, type Store } from '../lib/store.js'

export { createStore }
export type { Store }

/** Subscribe a component to a store. The snapshot is reference-stable per commit. */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

/**
 * Subscribe to a projection of a store.
 *
 * `select` runs on every notification, so it must be cheap and must return a
 * reference-stable value for unchanged input — deriving a fresh array or object here
 * re-renders on every commit and defeats the point. Pick fields; do not build.
 */
export function useStoreSelector<T, S>(store: Store<T>, select: (state: T) => S): S {
  const read = () => select(store.getSnapshot())
  return useSyncExternalStore(store.subscribe, read, read)
}
