import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeCursor, parseCursor, selectCursor } from '../src/viewer/cursor.js'

test('cursor: canonical round trip is order-insensitive on parse', () => {
  const parsed = parseCursor('v1;a7=tail;j=44100;a3=88211;e=182930')
  assert.deepEqual(parsed, { a7: 'tail', j: 44100, a3: 88211, e: 182930 })
  assert.equal(encodeCursor(parsed), 'v1;e=182930;j=44100;a3=88211;a7=tail')
  assert.deepEqual(parseCursor(encodeCursor(parsed)), parsed)
})

test('cursor: unknown keys and future flag tokens are ignored', () => {
  assert.deepEqual(parseCursor('v1;future=anything;e=9;a2=tail'), { e: 9, a2: 'tail' })
  assert.equal(encodeCursor({ z: 4, e: 1 }), 'v1;e=1')
})

test('cursor: malformed known fields fail closed while absent is null', () => {
  for (const value of [undefined, '', 'v2;e=1', 'v1;flag', 'v1;e=-1', 'v1;e=1.2', 'v1;e=01', 'v1;e=1;e=2', 'v1;j=tail', `v1;e=${Number.MAX_SAFE_INTEGER + 1}`]) {
    assert.equal(parseCursor(value), null, String(value))
  }
})

test('cursor: parse accepts a version-only cursor and zero offsets', () => {
  assert.deepEqual(parseCursor('v1'), {})
  assert.deepEqual(parseCursor('v1;e=0;j=0;a0=0'), { e: 0, j: 0, a0: 0 })
})

test('cursor: a parseable Last-Event-ID wins; malformed header falls back to query', () => {
  assert.deepEqual(selectCursor({ lastEventId: 'v1;e=20', queryCursor: 'v1;e=1' }), {
    cursor: { e: 20 }, source: 'last-event-id', reset: false,
  })
  assert.deepEqual(selectCursor({ lastEventId: 'broken', queryCursor: 'v1;e=1' }), {
    cursor: { e: 1 }, source: 'query', reset: false,
  })
  assert.deepEqual(selectCursor({ queryCursor: 'broken' }), {
    cursor: {}, source: 'default', reset: true,
  })
  assert.deepEqual(selectCursor({ queryCursor: '' }), {
    cursor: {}, source: 'default', reset: true,
  })
})
