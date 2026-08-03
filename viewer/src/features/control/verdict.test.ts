// The §7.2 send-verdict vocabulary and failure mapping, pure (§11.1's node half).
//
// The acceptance criterion this file carries: "the send-verdict vocabulary
// (live/queued/replayed/dropped/pending) faithfully". Faithfully means all five are
// distinguishable, `dropped` is the amber one that says "agent already settled", and a
// verdict this build has never heard of survives as the engine's own word.

import { describe, expect, it } from 'vitest'
import { SEND_VERDICTS, classifyFailure, describeVerdict, failureCopy } from './verdict.js'

describe('§7.2 delivery verdicts', () => {
  it('carries all five verdicts the bridge can return, each distinguishable', () => {
    expect([...SEND_VERDICTS]).toEqual(['live', 'queued', 'replayed', 'dropped', 'pending'])
    const copies = SEND_VERDICTS.map((verdict) => describeVerdict(verdict))
    expect(copies.every((copy) => copy.known)).toBe(true)
    expect(new Set(copies.map((copy) => copy.detail)).size).toBe(5)
    expect(new Set(copies.map((copy) => copy.label)).size).toBe(5)
  })

  it('reads each verdict the way the engine means it', () => {
    expect(describeVerdict('live').detail).toContain('current turn')
    expect(describeVerdict('queued').detail).toContain('next turn')
    expect(describeVerdict('replayed').detail).toContain('replay-suppressed')
    // §7.2: "`dropped` renders amber with 'agent already settled'".
    expect(describeVerdict('dropped')).toMatchObject({ tone: 'warn' })
    expect(describeVerdict('dropped').detail).toContain('agent already settled')
    expect(describeVerdict('pending').detail).toContain('before the agent started')
  })

  it('shows a verdict from a NEWER engine verbatim rather than blanking it (§6.5)', () => {
    const copy = describeVerdict('teleported')
    expect(copy.known).toBe(false)
    expect(copy.label).toBe('teleported')
    expect(copy.verdict).toBe('teleported')
    expect(copy.detail).toContain('does not know this verdict')
  })

  it('says "no verdict" instead of inventing one when the engine reported none', () => {
    for (const value of [null, undefined, '']) {
      const copy = describeVerdict(value)
      expect(copy.verdict).toBeNull()
      expect(copy.label).toBe('no verdict')
    }
  })
})

describe('§7.2 failure mapping', () => {
  const err = (status: number, code: string, message: string) => ({ status, code, message })

  it('reads a 409 on ANSWER as "another operator answered first", not as a bad request', () => {
    const failure = classifyFailure(err(409, 'conflict', 'no pending question q_7f2a'), 'answer')
    expect(failure.kind).toBe('already-answered')
    expect(failure.refresh).toBe(true)
    expect(failureCopy(failure)).toContain('another operator answered first')
    // The same status on another mutation is an ordinary conflict — a resume against a
    // running run, say — and must not borrow the answer copy.
    expect(classifyFailure(err(409, 'conflict', 'run is running'), 'resume').kind).toBe('conflict')
  })

  it('maps 503 run_not_live to §7.2’s retryable "may have finished"', () => {
    const failure = classifyFailure(
      err(503, 'run_not_live', 'run is not live — it may have finished'), 'send',
    )
    expect(failure).toMatchObject({ kind: 'not-live', retryAfterMs: 2000, refresh: true })
    expect(failureCopy(failure)).toContain('not live')
  })

  it('maps the other §5.2 codes without ever producing a generic failure', () => {
    expect(classifyFailure(err(403, 'forbidden', 'viewer is read-only'), 'delete').kind).toBe('forbidden')
    expect(failureCopy(classifyFailure(err(403, 'forbidden', 'viewer is read-only'))))
      .toContain('--control')
    expect(classifyFailure(err(400, 'bad_request', 'agent must be…'), 'cancel').kind).toBe('invalid')
    expect(classifyFailure(err(410, 'gone', 'deleted'), 'resume').kind).toBe('gone')
    expect(classifyFailure(err(401, 'unauthorized', 'token rejected')).kind).toBe('unauthorized')
    expect(classifyFailure(err(0, 'unreachable', 'x')).message).toContain('flowition viewer')
    // Anything thrown that is not an ApiError still lands somewhere honest.
    expect(classifyFailure(new Error('kaboom')).message).toBe('kaboom')
    expect(classifyFailure('string failure').message).toBe('string failure')
  })
})
