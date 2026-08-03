/**
 * `MockEventSource` — the seam §11.3 requires: "sse.ts latch composition against
 * MockEventSource with fake timers (reconnect-resume, reconnect-reset, terminal-fold
 * latch, resumed-run re-arm — parity #118)".
 *
 * It models the parts of the EventSource contract the latch actually depends on, and
 * nothing else:
 *
 *   • `readyState` transitions, because the client distinguishes "the browser is retrying
 *     with `Last-Event-ID`" (CONNECTING) from "the browser has given up" (CLOSED), and
 *     retries itself only in the second case;
 *   • `lastEventId` on every delivered event, because that — not the record offsets — is
 *     the composite cursor a reconnect resumes from;
 *   • `reconnect()`, which is what a real browser does on its own: it re-opens the SAME
 *     url and replays from the header. The mock records the url per connection so a test
 *     can assert that an explicit `reopen()` built a fresh one and a native reconnect did
 *     not.
 *
 * TEST-ONLY. Nothing under `features/` or `state/` may import it, and nothing does — it
 * is reachable from test files alone, so it never enters the bundle graph.
 */

import type { SseLike } from '../api/sse.js'

export const CONNECTING = 0
export const OPEN = 1
export const CLOSED = 2

export interface MockFrame { s: string; o: number; r: Record<string, unknown> }

export class MockEventSource implements SseLike {
  static instances: MockEventSource[] = []
  /** The most recently constructed instance — the one a test is usually driving. */
  static get last(): MockEventSource {
    const found = MockEventSource.instances[MockEventSource.instances.length - 1]
    if (!found) throw new Error('MockEventSource: nothing has connected yet')
    return found
  }

  /**
   * Every connection attempt in order, native reconnects included. `native: false` means
   * the client built a fresh url (initial open, `reopen()`, or its own retry after a fatal
   * error); `native: true` is the browser reusing the url with `Last-Event-ID`.
   */
  static connections: { url: string; native: boolean }[] = []

  static reset(): void {
    MockEventSource.instances = []
    MockEventSource.connections = []
  }

  /** Every url the CLIENT constructed, in order (native reconnects excluded). */
  static get urls(): string[] { return MockEventSource.instances.map((i) => i.url) }

  readonly url: string
  readyState = CONNECTING
  closedByClient = false
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(url: string) {
    this.url = url
    MockEventSource.instances.push(this)
    MockEventSource.connections.push({ url, native: false })
  }

  addEventListener(type: string, listener: (event: never) => void): void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(listener as (event: unknown) => void)
  }

  removeEventListener(type: string, listener: (event: never) => void): void {
    this.listeners.get(type)?.delete(listener as (event: unknown) => void)
  }

  close(): void {
    this.readyState = CLOSED
    this.closedByClient = true
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  // ---- driving the connection ----------------------------------------------------------

  /** The server accepted the connection. */
  open(): this {
    this.readyState = OPEN
    this.emit('open', { type: 'open' })
    return this
  }

  /** A `batch` frame (§5.6.3). `id` is the composite cursor AFTER the batch. */
  batch(frames: MockFrame[], id?: string): this {
    this.emit('batch', {
      type: 'batch',
      data: JSON.stringify({ f: frames }),
      lastEventId: id ?? '',
    })
    return this
  }

  /** A `sys` frame (§5.6.4). */
  sys(record: Record<string, unknown>, id?: string): this {
    this.emit('sys', {
      type: 'sys',
      data: JSON.stringify({ s: 'sys', r: record }),
      lastEventId: id ?? '',
    })
    return this
  }

  /** Malformed payloads must be counted, never thrown (§6.5). */
  raw(type: string, data: string, id?: string): this {
    this.emit(type, { type, data, lastEventId: id ?? '' })
    return this
  }

  /**
   * A transient drop. The browser will retry the same url with `Last-Event-ID`, so
   * `readyState` goes back to CONNECTING and the client must NOT open its own connection.
   */
  drop(): this {
    this.readyState = CONNECTING
    this.emit('error', { type: 'error' })
    return this
  }

  /** A fatal error: the browser gives up and the client owns the retry. */
  fail(): this {
    this.readyState = CLOSED
    this.emit('error', { type: 'error' })
    return this
  }

  /**
   * What the browser does after `drop()`: re-open the SAME url, resuming from the header.
   * A real EventSource reconnects INSIDE one object — the page never sees a second one —
   * so this reuses `this` and records the attempt as native.
   */
  reconnect(): this {
    MockEventSource.connections.push({ url: this.url, native: true })
    return this.open()
  }
}

/** A constructor usable as `EventSourceImpl`. */
export const MockEventSourceCtor = MockEventSource as unknown as
  new (url: string, init?: { withCredentials?: boolean }) => SseLike
