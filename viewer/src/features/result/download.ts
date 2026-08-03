/**
 * §2.6's "download link to `GET …/result/raw`", built the only way it can be built here.
 *
 * It is NOT an `<a href>`. §7.1.2 authenticates every read with `Authorization: Bearer`, and
 * `http.js` accepts a `?token=` query only on the SSE route (`allowQueryToken: route.sse`) —
 * deliberately, because a URL-borne credential lands in history, referrers and shoulder
 * range. So a plain anchor to `/result/raw` is a guaranteed 401, and a "download raw"
 * affordance that 401s is worse than none: it appears exactly when the value is too big to
 * read any other way.
 *
 * The fetch therefore carries the header, and the response becomes an object URL the browser
 * downloads under the run's name. Two consequences stated rather than hidden:
 *   • the whole file passes through memory once — acceptable because this path exists for a
 *     file the operator has ASKED to have on disk, and the alternative is not having it;
 *   • the object URL is revoked on the next frame, so a large result is not pinned for the
 *     life of the tab.
 *
 * `default-src 'none'` (§7.1.4) has no say here: a same-document `blob:` download is not a
 * fetch directive's subject, and `viewer.spec.ts` proves the download actually arrives in
 * Chrome rather than taking that on trust.
 */

import { ApiError, getToken } from '../../api/client.js'

export interface RawDownload {
  bytes: number
  filename: string
}

export async function downloadRawResult(
  runId: string,
  { fetchImpl = fetch, doc = typeof document === 'undefined' ? null : document } = {},
): Promise<RawDownload> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`

  let res: Response
  try {
    res = await fetchImpl(
      `/api/runs/${encodeURIComponent(runId)}/result/raw`,
      { method: 'GET', headers, credentials: 'omit' },
    )
  } catch {
    throw new ApiError(0, 'unreachable', 'the viewer API did not answer')
  }
  if (!res.ok) {
    throw new ApiError(
      res.status,
      res.status === 401 ? 'unauthorized' : 'error',
      res.status === 401
        ? 'the read token was rejected'
        : `result.json could not be downloaded (${res.status})`,
      runId,
    )
  }

  const blob = await res.blob()
  const filename = `${runId}.result.json`
  if (doc) {
    const url = URL.createObjectURL(blob)
    const anchor = doc.createElement('a')
    anchor.href = url
    anchor.download = filename
    doc.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    // Next task, not next tick: the click has to have been dispatched before the URL dies.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  return { bytes: blob.size, filename }
}
