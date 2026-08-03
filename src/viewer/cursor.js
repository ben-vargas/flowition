// Pure composite-cursor codec (DESIGN §5.6.2). Unknown components are ignored so a
// newer writer can talk to an older reader; ambiguity in any known component makes the
// whole cursor malformed and lets the stream layer apply reset semantics.

export const CURSOR_VERSION = 'v1'
const AGENT_KEY = /^a(0|[1-9][0-9]*)$/
const OFFSET = /^(0|[1-9][0-9]*)$/

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

function parseOffset(value) {
  if (!OFFSET.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

/**
 * @returns {{e?: number, j?: number, [agent: `a${number}`]: number|'tail'}|null}
 */
export function parseCursor(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16 * 1024) return null
  const parts = value.split(';')
  if (parts.shift() !== CURSOR_VERSION) return null
  const cursor = {}
  const seen = new Set()

  for (const part of parts) {
    const equals = part.indexOf('=')
    if (equals <= 0) return null
    const key = part.slice(0, equals)
    const raw = part.slice(equals + 1)
    const known = key === 'e' || key === 'j' || AGENT_KEY.test(key)
    if (!known) continue
    if (seen.has(key)) return null
    seen.add(key)
    if (raw === 'tail' && AGENT_KEY.test(key)) cursor[key] = 'tail'
    else {
      const offset = parseOffset(raw)
      if (offset === null) return null
      cursor[key] = offset
    }
  }
  return cursor
}

function checkedValue(key, value) {
  if (value === 'tail' && AGENT_KEY.test(key)) return value
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`invalid cursor offset for ${key}`)
  return String(value)
}

/** Canonical encoding: events, journal, then agents in numeric order. */
export function encodeCursor(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('cursor must be an object')
  const fields = []
  if (own(value, 'e')) fields.push(`e=${checkedValue('e', value.e)}`)
  if (own(value, 'j')) fields.push(`j=${checkedValue('j', value.j)}`)
  const agents = Object.keys(value)
    .filter((key) => AGENT_KEY.test(key))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))
  for (const key of agents) fields.push(`${key}=${checkedValue(key, value[key])}`)
  return [CURSOR_VERSION, ...fields].join(';')
}

export const formatCursor = encodeCursor

export function cursorKeyForStream(stream) {
  if (stream === 'events' || stream === 'e') return 'e'
  if (stream === 'journal' || stream === 'j') return 'j'
  if (typeof stream === 'number' && Number.isSafeInteger(stream) && stream >= 0) return `a${stream}`
  if (typeof stream === 'string' && AGENT_KEY.test(stream)) return stream
  return null
}

export function selectCursor({ lastEventId, queryCursor } = {}) {
  const headerPresent = typeof lastEventId === 'string'
  const header = headerPresent ? parseCursor(lastEventId) : null
  if (header) return { cursor: header, source: 'last-event-id', reset: false }

  const queryPresent = typeof queryCursor === 'string'
  const query = queryPresent ? parseCursor(queryCursor) : null
  if (query) return { cursor: query, source: 'query', reset: false }

  return {
    cursor: {},
    source: 'default',
    reset: headerPresent || queryPresent,
  }
}
