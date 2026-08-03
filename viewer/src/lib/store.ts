/**
 * The `useSyncExternalStore` shape, hand-rolled (DESIGN §9.1: no react-query; §9.3:
 * "Hand-rolled stores on `useSyncExternalStore`").
 *
 * Deliberately not a React module: nothing here imports React, so every store built on it
 * is testable in the node environment without a renderer (§11.1's split). The React
 * bindings are three lines at the call site.
 */

export interface Store<T> {
  /** Stable identity per commit — `useSyncExternalStore` compares by reference. */
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  /** Replace the snapshot. A reference-equal value notifies nobody. */
  set(next: T): void
  /** Derive the next snapshot from the current one. */
  update(fn: (current: T) => T): void
  readonly listenerCount: number
}

export function createStore<T>(initial: T): Store<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    set(next) {
      if (Object.is(next, snapshot)) return
      snapshot = next
      // Iterate a copy: a listener that unsubscribes during notification is normal
      // (React does it on unmount) and must not skip the next one.
      for (const listener of [...listeners]) listener()
    },
    update(fn) { this.set(fn(snapshot)) },
    get listenerCount() { return listeners.size },
  }
}
