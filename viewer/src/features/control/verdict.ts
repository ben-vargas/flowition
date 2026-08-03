/**
 * The §7.2 send-verdict vocabulary and the failure vocabulary around it.
 *
 * A steer is not a request that either "worked" or "failed": the engine answers with a
 * DELIVERY VERDICT that says what actually happened to the message, and §7.2 requires the
 * composer to show it verbatim. The five the engine can produce today
 * (src/viewer/control-bridge.js:85, from src/agent-proc.js:151–177 and src/engine.js:1159):
 *
 *   live      — written into the agent's current turn; the model has it now
 *   queued    — held in the agent's mail queue; it arrives on the agent's next turn
 *   replayed  — replay-suppressed: this exact delivery already happened before the
 *               interruption, so nothing new was sent (and nothing was journaled twice)
 *   dropped   — the agent had already settled; §7.2's amber case, "agent already settled"
 *   pending   — accepted before the agent was admitted (a spawn handle's send); delivered
 *               when the job starts, dropped if it never does
 *
 * A verdict this build has never heard of is shown VERBATIM as an unknown verdict rather
 * than blanked: §6.5's degradation contract runs in both directions, and the bridge
 * deliberately passes the engine's word through without filtering it.
 */

export const SEND_VERDICTS = ['live', 'queued', 'replayed', 'dropped', 'pending'] as const

export type SendVerdict = typeof SEND_VERDICTS[number]

/** Visual weight, mapped to §3.2's status colors by `control.css` — never a raw color. */
export type VerdictTone = 'delivered' | 'waiting' | 'warn' | 'muted'

export interface VerdictCopy {
  /** Exactly what the engine said, including a word this build does not know. */
  verdict: string | null
  known: boolean
  tone: VerdictTone
  label: string
  detail: string
}

const TABLE: Record<SendVerdict, { tone: VerdictTone; label: string; detail: string }> = {
  live: {
    tone: 'delivered',
    label: 'live',
    detail: 'delivered into the agent’s current turn',
  },
  queued: {
    tone: 'waiting',
    label: 'queued',
    detail: 'held in the agent’s mail queue — it arrives on the agent’s next turn',
  },
  replayed: {
    tone: 'muted',
    label: 'replayed',
    detail: 'replay-suppressed — this delivery already happened before the interruption, '
      + 'so nothing new was sent',
  },
  dropped: {
    tone: 'warn',
    label: 'dropped',
    detail: 'agent already settled — nothing was delivered',
  },
  pending: {
    tone: 'waiting',
    label: 'pending',
    detail: 'accepted before the agent started — it is delivered when the agent runs, and '
      + 'dropped if it never does',
  },
}

export const isSendVerdict = (value: unknown): value is SendVerdict =>
  typeof value === 'string' && (SEND_VERDICTS as readonly string[]).includes(value)

/** §7.2's verdict copy. Never throws, never blanks an unrecognized word. */
export function describeVerdict(verdict: string | null | undefined): VerdictCopy {
  if (verdict == null || verdict === '') {
    return {
      verdict: null,
      known: false,
      tone: 'muted',
      label: 'no verdict',
      detail: 'the engine reported no delivery verdict for this message',
    }
  }
  if (isSendVerdict(verdict)) return { verdict, known: true, ...TABLE[verdict] }
  return {
    verdict,
    known: false,
    tone: 'muted',
    label: verdict,
    detail: 'this viewer does not know this verdict — it is the engine’s own word, shown '
      + 'as it came',
  }
}

// ---- failures (§7.2's failure-mapping column) ----------------------------------------

/**
 * The kinds a mutation failure can be, and the copy each one deserves.
 *
 * `already-answered` is the one that carries product meaning rather than an error: §7.2
 * reads a 409 on `answer` as *another operator answered first*, which is a reason to
 * refresh the question list, not a reason to blame this operator's input. It is the bug
 * class W8b's multi-question card hit from the other side (a stale snapshot re-offering an
 * answered qid), so it is named here and handled, never surfaced as "request failed".
 */
export type FailureKind =
  | 'already-answered'
  | 'not-live'
  | 'forbidden'
  | 'conflict'
  | 'invalid'
  | 'unreachable'
  | 'unauthorized'
  | 'gone'
  | 'error'

export interface MutationFailure {
  kind: FailureKind
  /** The server's own words wherever there are any — never paraphrased away. */
  message: string
  /** §7.2's `503 run_not_live` carries `retryAfterMs: 2000`. */
  retryAfterMs?: number
  /** True when the right response is to re-read the run rather than to retry the write. */
  refresh: boolean
}

interface ErrorLike { status?: number; code?: string; message?: string; retryAfterMs?: number }

/**
 * Map an `ApiError` (or anything else that got thrown) onto §7.2's failure vocabulary.
 *
 * Deliberately duck-typed rather than `instanceof ApiError`: a rejected fetch, a thrown
 * string and a test double all have to land somewhere honest, and the whole point of this
 * layer is that no mutation ever fails silently or generically.
 */
export function classifyFailure(error: unknown, op?: 'answer' | 'send' | 'cancel' | 'resume' | 'delete'): MutationFailure {
  const err = (error ?? {}) as ErrorLike
  const status = typeof err.status === 'number' ? err.status : null
  const code = typeof err.code === 'string' ? err.code : null
  const message = typeof err.message === 'string' && err.message
    ? err.message
    : String(error ?? 'the request failed')

  if (status === 0 || code === 'unreachable') {
    return {
      kind: 'unreachable',
      message: 'the viewer API did not answer — is `flowition viewer` still running?',
      refresh: false,
    }
  }
  if (status === 401) return { kind: 'unauthorized', message, refresh: false }
  if (status === 403) return { kind: 'forbidden', message, refresh: true }
  if (status === 400) return { kind: 'invalid', message, refresh: false }
  if (status === 410) return { kind: 'gone', message, refresh: true }
  if (status === 503 || code === 'run_not_live') {
    return {
      kind: 'not-live',
      message,
      retryAfterMs: typeof err.retryAfterMs === 'number' ? err.retryAfterMs : 2000,
      refresh: true,
    }
  }
  if (status === 409) {
    if (op === 'answer') {
      return {
        kind: 'already-answered',
        message,
        refresh: true,
      }
    }
    return { kind: 'conflict', message, refresh: true }
  }
  return { kind: 'error', message, refresh: false }
}

/** The operator-facing sentence for a failure — the server's message plus what it means. */
export function failureCopy(failure: MutationFailure): string {
  switch (failure.kind) {
    case 'already-answered':
      return `${failure.message} — another operator answered first; refreshing the questions`
    case 'not-live':
      return `${failure.message} — retrying is worth it for about ${
        Math.round((failure.retryAfterMs ?? 2000) / 1000)}s`
    case 'forbidden':
      return `${failure.message} — restart the viewer with \`--control\` to enable this`
    default:
      return failure.message
  }
}
