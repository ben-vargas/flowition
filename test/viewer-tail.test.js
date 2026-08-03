import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ByteTail, MAX_LINE_BYTES, MAX_READ_BYTES, drainTail, readChunk } from '../src/viewer/tail.js'

const fakeHandle = (source, requests = []) => ({
  async read(buffer, _bufferOffset, length, position) {
    requests.push({ length, position })
    const bytes = source.subarray(position, position + length)
    bytes.copy(buffer)
    return { bytesRead: bytes.length, buffer }
  },
})

test('tail: torn lines stay raw until their newline arrives', () => {
  const tail = new ByteTail()
  const first = tail.push(Buffer.from('{"a":'))
  assert.deepEqual(first.events, [])
  assert.equal(tail.offset, 0)
  assert.equal(tail.readOffset, 5)

  const second = tail.push(Buffer.from('1}\n'))
  assert.equal(second.events.length, 1)
  assert.equal(second.events[0].bytes.toString(), '{"a":1}')
  assert.equal(second.events[0].offset, 8)
  assert.equal(tail.offset, 8)
})

test('tail: a UTF-8 sequence split across chunks decodes only after newline', () => {
  const source = Buffer.from('{"text":"café"}\n')
  const split = source.indexOf(Buffer.from('é')) + 1
  const tail = new ByteTail()
  tail.push(source.subarray(0, split))
  assert.deepEqual(tail.pendingBytes(), source.subarray(0, split))
  const [{ bytes, offset }] = tail.push(source.subarray(split)).events
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), { text: 'café' })
  assert.equal(offset, source.length)
})

test('tail: shrink and identity rotation reset offset and torn carry', () => {
  const tail = new ByteTail({ offset: 5 })
  tail.observe({ size: 20, dev: 1, ino: 10 })
  tail.push(Buffer.from('partial'))
  assert.equal(tail.observe({ size: 3, dev: 1, ino: 10 }).reset, true)
  assert.equal(tail.readOffset, 0)
  assert.equal(tail.pendingBytes().length, 0)

  tail.observe({ size: 10, dev: 1, ino: 10 })
  tail.push(Buffer.from('x\n'))
  assert.equal(tail.observe({ size: 10, dev: 1, ino: 11 }).reset, true)
  assert.equal(tail.offset, 0)
})

test('tail: missing-file errors propagate without importing fs', async () => {
  const missing = {
    async read() {
      const error = new Error('gone')
      error.code = 'ENOENT'
      throw error
    },
  }
  await assert.rejects(() => readChunk(missing, 0), (error) => error.code === 'ENOENT')
})

test('tail: oversize lines are discarded with bounded carry and later lines survive', () => {
  const tail = new ByteTail({ maxLineBytes: 8 })
  let result = tail.push(Buffer.from('12345678'))
  assert.equal(tail.pendingBytes().length, 8)
  result = tail.push(Buffer.from('9'))
  assert.equal(tail.pendingBytes().length, 0)
  assert.equal(tail.discarding, true)
  result = tail.push(Buffer.from('0\nok\n'))
  assert.deepEqual(result.events.map(({ bytes, skipped, offset }) => ({
    ...(bytes ? { bytes: bytes.toString() } : {}),
    ...(skipped ? { skipped } : {}),
    offset,
  })), [
    { skipped: true, offset: 11 },
    { bytes: 'ok', offset: 14 },
  ])
  assert.equal(tail.skippedLines, 1)
})

test('tail: default line carry never grows beyond the 1 MiB cap', () => {
  const tail = new ByteTail()
  tail.push(Buffer.alloc(MAX_LINE_BYTES, 0x78))
  assert.equal(tail.pendingBytes().length, MAX_LINE_BYTES)
  tail.push(Buffer.from('x'))
  assert.equal(tail.pendingBytes().length, 0)
  assert.equal(tail.discarding, true)
})

test('tail: readChunk clamps every request to 1 MiB', async () => {
  const requests = []
  const source = Buffer.alloc(MAX_READ_BYTES + 17, 0x61)
  const handle = fakeHandle(source, requests)
  const first = await readChunk(handle, 0, MAX_READ_BYTES * 8)
  assert.equal(first.bytes.length, MAX_READ_BYTES)
  assert.equal(first.eof, false)
  const second = await readChunk(handle, first.nextOffset, MAX_READ_BYTES * 8)
  assert.equal(second.bytes.length, 17)
  assert.equal(second.eof, true)
  assert.deepEqual(requests.map((request) => request.length), [MAX_READ_BYTES, MAX_READ_BYTES])
})

test('tail: draining a large unread region uses bounded sequential reads', async () => {
  const requests = []
  const record = Buffer.from('{"x":1}\n')
  const source = Buffer.concat(Array.from({ length: Math.ceil((MAX_READ_BYTES * 2 + 20) / record.length) }, () => record))
  const tail = new ByteTail()
  let lines = 0
  await drainTail(fakeHandle(source, requests), tail, { onLine: () => { lines++ } })
  assert.ok(lines > 100_000)
  assert.ok(requests.length >= 3)
  assert.ok(requests.every(({ length }) => length <= MAX_READ_BYTES))
})

test('tail: a full chunk yields to the event loop before reading the next MiB', async () => {
  const source = Buffer.alloc(MAX_READ_BYTES * 2, 0x78)
  const tail = new ByteTail()
  let timerFired = false
  setImmediate(() => { timerFired = true })
  let secondReadSawTimer = false
  let reads = 0
  const handle = {
    async read(buffer, _bufferOffset, length, position) {
      reads++
      if (reads === 2) secondReadSawTimer = timerFired
      const bytes = source.subarray(position, position + length)
      bytes.copy(buffer)
      return { bytesRead: bytes.length, buffer }
    },
  }
  await drainTail(handle, tail)
  assert.equal(secondReadSawTimer, true)
})
