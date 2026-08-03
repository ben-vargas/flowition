// The fetch layer (DESIGN §9.2 `api/client.ts`, §7.1.2 token handling).
//
// Rules this file exists to keep in one place:
//   • the read token travels as `Authorization: Bearer`, NEVER as a query parameter on a
//     fetch (§7.1.2 allows `?token=` only for EventSource, which cannot set headers);
//   • tokens live in sessionStorage, never localStorage — a token that survives the tab
//     survives longer than the operator expects;
//   • a 401 clears the stored token exactly once and surfaces `unauthorized`, so the app
//     can show the paste-token screen instead of looping (critique M7 / Sol-6);
//   • mutations additionally send the ephemeral control token in `x-flowition-control`
//     and `content-type: application/json` (§7.1.5).

import type {
  CancelAccepted, DeleteAccepted, JsonlPage, ResultPayload, ResumeAccepted,
  RunDetail, RunsPage, SearchResults, SendAccepted, Session,
} from './types.js'

export const TOKEN_KEY = 'flowition.viewer.token'
export const CONTROL_TOKEN_KEY = 'flowition.viewer.controlToken'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly runId: string | undefined
  constructor(status: number, code: string, message: string, runId?: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.runId = runId
  }
  /** True for the transport failures Home renders as "API unreachable" (parity #40). */
  get unreachable() { return this.status === 0 }
  get unauthorized() { return this.status === 401 }
}

const store = {
  get(key: string): string | null {
    try { return sessionStorage.getItem(key) } catch { return null }
  },
  set(key: string, value: string | null) {
    try {
      if (value == null) sessionStorage.removeItem(key)
      else sessionStorage.setItem(key, value)
    } catch { /* private mode — the app still works for this page load via memory */ }
  },
}

let memoryToken: string | null = null
let memoryControlToken: string | null = null

export const getToken = (): string | null => memoryToken ?? store.get(TOKEN_KEY)
export const getControlToken = (): string | null =>
  memoryControlToken ?? store.get(CONTROL_TOKEN_KEY)

// ---- the read token as an OBSERVABLE ------------------------------------------------
//
// A 401 can arrive on ANY request — the Home listing, the rail's poll, a detail fetch —
// and `clearTokens` below drops the credential when it does. Without a way to observe
// that, the shell learned about it only if the 401 happened to land on its own session
// probe: a viewer whose token was revoked mid-session kept the authenticated frame and
// its now-unauthenticated data on screen until the operator reloaded by hand. So the
// token is a `useSyncExternalStore` source, and App re-probes `/api/session` on change.

const tokenListeners = new Set<() => void>()

/** Subscribe to read-token changes. Returns an unsubscribe, `useSyncExternalStore`-shaped. */
export function subscribeToken(fn: () => void): () => void {
  tokenListeners.add(fn)
  return () => { tokenListeners.delete(fn) }
}

/** Notified only when the value actually MOVED — a redundant clear must not re-probe. */
function notifyToken() {
  for (const fn of [...tokenListeners]) fn()
}

export function setToken(token: string | null) {
  const before = getToken()
  memoryToken = token
  store.set(TOKEN_KEY, token)
  if (before !== token) notifyToken()
}
export function setControlToken(token: string | null) {
  memoryControlToken = token
  store.set(CONTROL_TOKEN_KEY, token)
}
/** 401 handling: drop the credential so the next render is the paste-token screen. */
export function clearTokens() {
  setToken(null)
  setControlToken(null)
}

async function call<T>(
  path: string,
  { method = 'GET', body, control = false, signal }: {
    method?: string; body?: unknown; control?: boolean; signal?: AbortSignal
  } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (control) {
    const c = getControlToken()
    if (c) headers['x-flowition-control'] = c
  }

  let res: Response
  try {
    const init: RequestInit = { method, headers, credentials: 'omit' }
    if (body !== undefined) init.body = JSON.stringify(body)
    if (signal) init.signal = signal
    res = await fetch(path, init)
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw err
    // Status 0 is "the listener is gone" — the one case Home names the CLI for.
    throw new ApiError(0, 'unreachable', 'the viewer API did not answer')
  }

  if (res.status === 401) {
    clearTokens()
    throw new ApiError(401, 'unauthorized', 'the read token was rejected')
  }
  if (!res.ok) {
    let code = 'error'
    let message = `request failed with ${res.status}`
    let runId: string | undefined
    try {
      const parsed = await res.json() as { error?: { code?: string; message?: string; runId?: string } }
      if (parsed?.error) {
        code = parsed.error.code ?? code
        message = parsed.error.message ?? message
        runId = parsed.error.runId
      }
    } catch { /* not an envelope; keep the generic message */ }
    throw new ApiError(res.status, code, message, runId)
  }
  if (res.status === 204) return undefined as T
  return await res.json() as T
}

export interface RunsQuery {
  limit?: number
  cursor?: string | null
  /** RunState names only — §5.4.2 rejects anything else, and "blocked" is not a RunState. */
  state?: string | null
  q?: string | null
  signal?: AbortSignal
}

export const api = {
  session: (signal?: AbortSignal) => call<Session>('/api/session', signal ? { signal } : {}),

  runs({ limit, cursor, state, q, signal }: RunsQuery = {}) {
    const params = new URLSearchParams()
    if (limit != null) params.set('limit', String(limit))
    if (cursor) params.set('cursor', cursor)
    if (state) params.set('state', state)
    if (q) params.set('q', q)
    const qs = params.toString()
    return call<RunsPage>(`/api/runs${qs ? `?${qs}` : ''}`, signal ? { signal } : {})
  },

  runDetail(runId: string, signal?: AbortSignal) {
    return call<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`, signal ? { signal } : {})
  },

  /**
   * §13 Q4's "show args" read, and the ONLY request in the client that asks for them.
   *
   * It is a separate method rather than a flag on `runDetail` on purpose. `runDetail` is
   * called by the run store's poll, the rail and Home; if it took an `includeArgs` option,
   * a future caller could put the run's arguments — which §13 Q4 says may contain secrets —
   * into the default payload of a loop that runs every few seconds. §5.4.1 has the server
   * write an `args-read` audit line for every one of these (critique N2), so each call is a
   * traceable operator act, and this shape keeps it that way: args are fetched by exactly
   * one caller, on exactly one click. §5.6.5 keeps them off the stream entirely.
   *
   * Response shape (§5.4.1): `args` is inlined when it fits the 1 MiB cap; past it the
   * server omits the value and sets `argsTruncated: true`.
   */
  runArgs(runId: string, signal?: AbortSignal) {
    return call<RunDetail>(
      `/api/runs/${encodeURIComponent(runId)}?include=args`,
      signal ? { signal } : {},
    )
  },

  // ---- paged reads (§5.4.4–§5.4.7) ----------------------------------------------------
  //
  // `from` is a BYTE OFFSET or the literal `tail`, never a record index — the same unit the
  // SSE cursor speaks (§5.6.3), which is what lets a page and a stream be stitched without
  // translating between them. A 404 here means "no transcript yet"; §5.4.4 is explicit
  // that it may appear later, so callers treat it as an empty state, not an error.

  agentPage(
    runId: string,
    index: number,
    { from, maxBytes, signal }: { from?: number | 'tail'; maxBytes?: number; signal?: AbortSignal } = {},
  ) {
    const params = new URLSearchParams()
    if (from !== undefined) params.set('from', String(from))
    if (maxBytes != null) params.set('maxBytes', String(maxBytes))
    const qs = params.toString()
    return call<JsonlPage>(
      `/api/runs/${encodeURIComponent(runId)}/agents/${index}/page${qs ? `?${qs}` : ''}`,
      signal ? { signal } : {},
    )
  },

  eventsPage(
    runId: string,
    { from, maxBytes, signal }: { from?: number | 'tail'; maxBytes?: number; signal?: AbortSignal } = {},
  ) {
    const params = new URLSearchParams()
    if (from !== undefined) params.set('from', String(from))
    if (maxBytes != null) params.set('maxBytes', String(maxBytes))
    const qs = params.toString()
    return call<JsonlPage>(
      `/api/runs/${encodeURIComponent(runId)}/events/page${qs ? `?${qs}` : ''}`,
      signal ? { signal } : {},
    )
  },

  runResult(runId: string, signal?: AbortSignal) {
    return call<ResultPayload>(`/api/runs/${encodeURIComponent(runId)}/result`, signal ? { signal } : {})
  },

  /** The full value behind an `AgentView`'s `resultTruncated` (§5.4.5, critique M8). */
  agentResult(runId: string, index: number, signal?: AbortSignal) {
    return call<ResultPayload>(
      `/api/runs/${encodeURIComponent(runId)}/agents/${index}/result`,
      signal ? { signal } : {},
    )
  },

  search(runId: string, q: string, { limit, signal }: { limit?: number; signal?: AbortSignal } = {}) {
    const params = new URLSearchParams({ q })
    if (limit != null) params.set('limit', String(limit))
    return call<SearchResults>(
      `/api/runs/${encodeURIComponent(runId)}/search?${params.toString()}`,
      signal ? { signal } : {},
    )
  },

  /**
   * §7.2 answer. The affordance is W8b's (the Home attention strip is useless without
   * it); the confirmation/toast/optimistic layer around mutations is W12's.
   */
  answer(runId: string, qid: string, value: unknown) {
    return call<unknown>(`/api/runs/${encodeURIComponent(runId)}/answer`, {
      method: 'POST', control: true, body: { qid, value },
    })
  },

  /**
   * §7.2 send — steer one running agent. W12.
   *
   * `agent` is a canonical index or a non-empty label and is REQUIRED
   * (src/viewer/routes.js:116-121): unlike cancel there is no run-scoped send, so an
   * absent agent is a 400 rather than a broadcast.
   */
  send(runId: string, agent: number | string, message: string) {
    return call<SendAccepted>(`/api/runs/${encodeURIComponent(runId)}/send`, {
      method: 'POST', control: true, body: { agent, message },
    })
  },

  /**
   * §7.2 cancel — critique N5's split, expressed in TWO methods rather than one optional
   * argument. The engine reads `agent == null` as "cancel the whole run"
   * (src/engine.js:711), so a single `cancel(runId, agent?)` whose caller passed an
   * undefined index would silently become a run abort. There is no argument these two
   * functions could be given that turns one into the other.
   */
  cancelAgent(runId: string, agent: number | string) {
    return call<CancelAccepted>(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST', control: true, body: { agent },
    })
  },

  /** §7.2 whole-run cancel — the body has NO `agent` key, and cannot grow one. */
  cancelRun(runId: string) {
    return call<CancelAccepted>(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST', control: true, body: {},
    })
  },

  /**
   * §7.3 delete — guarded delete-to-trash. Every guard (symlink refusal, containment, the
   * artifact requirement, the run lock, the re-derive under it) lives in `retention.js`
   * behind this route; the client adds no pre-check of its own, because a check taken
   * outside that lock could only produce a different answer from the authoritative one.
   */
  remove(runId: string) {
    return call<DeleteAccepted>(`/api/runs/${encodeURIComponent(runId)}`, {
      method: 'DELETE', control: true, body: {},
    })
  },

  /**
   * §7.3 resume/replay. Same W8b/W12 boundary as `answer`: the affordance belongs to the
   * screen that surfaces the problem (a stale card whose Resume button does not resume is
   * a lie), the confirmation modal and toast layer are W12's.
   *
   * The body is `{}` and stays `{}`: `validateMutationBody` discards it
   * (src/viewer/routes.js:143-145) — a resume takes its runId from the path and nothing
   * else, because the engine re-reads the journal meta and re-runs its own preflight. It
   * is sent anyway rather than omitted, because `gateMutation` requires
   * `content-type: application/json` on EVERY mutation (src/viewer/http.js:427) — that
   * header is a CSRF gate (no `<form>` can produce it), not a description of a payload.
   */
  resume(runId: string) {
    return call<ResumeAccepted>(`/api/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST', control: true, body: {},
    })
  },
}
