// @vitest-environment jsdom
//
// §2.6's raw download. The property that matters is the one an `<a href>` cannot have:
// the request carries the bearer token, because `/result/raw` is not an SSE route and
// `http.js` accepts a query token on nothing else.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ApiError, clearTokens, setToken } from '../../api/client.js'
import { downloadRawResult } from './download.js'

afterEach(() => { clearTokens(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
beforeEach(() => { clearTokens() })

const blobRes = (body = '{"ok":true}') => ({
  ok: true,
  status: 200,
  blob: async () => new Blob([body], { type: 'application/json' }),
}) as unknown as Response

describe('§2.6 raw result download', () => {
  it('asks the §5.4.5 raw route with an Authorization header, never a query token', async () => {
    setToken('tok-123')
    const fetchImpl = vi.fn(async () => blobRes())
    await downloadRawResult('flo_a b', { fetchImpl: fetchImpl as never, doc: null })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/runs/flo_a%20b/result/raw')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-123')
    expect(url).not.toContain('token=')
    expect(init.credentials).toBe('omit')
  })

  it('clicks a same-document object URL named for the run, and revokes it', async () => {
    setToken('tok')
    const createObjectURL = vi.fn(() => 'blob:fake')
    const revokeObjectURL = vi.fn()
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL }))
    vi.useFakeTimers()

    let clicked: HTMLAnchorElement | null = null
    const realClick = HTMLAnchorElement.prototype.click
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      clicked = this
    }
    try {
      const out = await downloadRawResult('flo_x', { fetchImpl: (async () => blobRes()) as never })
      expect(out.filename).toBe('flo_x.result.json')
      expect(clicked).not.toBeNull()
      expect(clicked!.download).toBe('flo_x.result.json')
      expect(clicked!.getAttribute('href')).toBe('blob:fake')
      // Detached again — the helper must not leave anchors in the document.
      expect(clicked!.isConnected).toBe(false)
      vi.advanceTimersByTime(1)
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:fake')
    } finally {
      HTMLAnchorElement.prototype.click = realClick
      vi.useRealTimers()
    }
  })

  it('maps a 401 onto the api client’s own unauthorized error', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response)
    await expect(downloadRawResult('r', { fetchImpl: fetchImpl as never, doc: null }))
      .rejects.toMatchObject({ status: 401, code: 'unauthorized' })
  })

  it('maps a dead listener onto the same "unreachable" the rest of the app renders', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('failed to fetch') })
    const err = await downloadRawResult('r', { fetchImpl: fetchImpl as never, doc: null })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(0)
  })

  it('names the run in a non-401 failure rather than failing silently', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response)
    await expect(downloadRawResult('flo_y', { fetchImpl: fetchImpl as never, doc: null }))
      .rejects.toMatchObject({ status: 500, runId: 'flo_y' })
  })
})
