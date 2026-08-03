export class Semaphore {
  constructor(limit) {
    // NaN would make every comparison false and deadlock the first acquire
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`Semaphore limit must be an integer >= 1 (got ${limit})`)
    this.limit = limit
    this.active = 0
    this.queue = []
  }
  // Admission gauge for the queued/running events (DESIGN §8 E4). Only `queued` is
  // an accessor: `active` is an assigned field (the constructor's `this.active = 0`
  // would throw against a prototype getter in strict mode) — read it directly.
  get queued() { return this.queue.length }
  async acquire() {
    if (this.active < this.limit) { this.active++; return }
    await new Promise((resolve) => this.queue.push(resolve))
    // slot handed off directly by release() — active count already transferred
  }
  release() {
    const next = this.queue.shift()
    if (next) next() // direct handoff, no decrement — prevents over-admission
    else this.active--
  }
  async with(fn) {
    await this.acquire()
    try { return await fn() } finally { this.release() }
  }
}
