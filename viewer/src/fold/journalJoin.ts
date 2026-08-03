/**
 * The client half of §6.4's **journal join**, maintained incrementally from the SSE
 * journal feed (§5.6.5).
 *
 * The server joins `journal.jsonl` into `RunDetail` up to `detail.offsets.journal`, and
 * the stream is opened at exactly that offset — so the client never re-reads what the
 * server already folded. What it maintains is a DELTA, and the join is
 * `combine(base, delta)` per agent key:
 *
 *   base   the server's join, captured at seed time (`journalBaseFromDetail`)
 *   delta  every journal record streamed since (`ingestJournalRecord`)
 *
 * Why a delta and not "re-derive from the fold": the events fold cannot carry these
 * facts. `attempts` counts journal `result` RECORDS (the folded results map is last-wins
 * and hides retries — §6.4 J), `usage` is the LIFETIME sum over all of a key's result
 * records (Sol-13) while an agent event's own `usage` field is only the last attempt's —
 * so `foldAgent` legitimately writes the attempt value into `usage` and the join must
 * overwrite it, exactly as `snapshot.js` does after `materializeFold`.
 */

import type { AgentView, MailView, QuestionView, RunDetail } from '../api/types.js'
import { isLegacyEngine, mailSignature, type MaterializedFold } from './index.js'

export interface Usage { input: number; output: number; cost: number }
export interface LiveTokens { input: number; output: number }

/** The per-key facts the journal — and only the journal — can supply. */
export interface JournalFacts {
  attempts: number
  /** Lifetime: summed over every result record for the key (Sol-13). */
  usage: Usage | null
  /** The LAST attempt's own result record. */
  attemptUsage: Usage | null
  durationMs: number | null
  resultPreview: string | null
  resultBytes: number | null
  resultTruncated: boolean
  sessionId: string | null
  liveTokens: LiveTokens | null
  /**
   * Zero-reset-aware lifetime-to-date from the cum stream — §6.2 `AgentView.cumTokens`.
   * Optional so a caller can state the facts it cares about without restating the chain.
   */
  cumTokens?: LiveTokens | null
}

interface DeltaFacts extends JournalFacts {
  hasResult: boolean
  hasSession: boolean
  hasLiveTokens: boolean
  /**
   * The chain has to cross the seam between the server's join and this delta, and the
   * delta cannot see the base while it is ingesting. So it records its OWN first cum
   * report and its own internal chain; `combine` closes the seam by measuring the first
   * report against the base's last one (`base.liveTokens`) and adding the result to the
   * base's banked total. Idempotent, because the delta is monotonic and `combine` is pure.
   */
  cumFirst: LiveTokens | null
  cumChain: LiveTokens
  index: number | null
}

export interface JournalMailRecord {
  t?: number
  key?: string
  id?: string
  text?: string
  origin?: string
  callsite?: string
}

export interface JournalDelta {
  byKey: Map<string, DeltaFacts>
  /** `result` records also carry `index`, which is the only key→index map the stream has. */
  indexByKey: Map<string, number>
  answers: Map<string, unknown>
  mailById: Map<string, JournalMailRecord>
  mailDoneById: Map<string, { dropped?: boolean; skipped?: boolean }>
  legacyMail: JournalMailRecord[]
  spend: Usage
  records: number
  unknown: number
}

const RESULT_PREVIEW_BYTES = 200
const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null
const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null

const num = (v: unknown): number => (Number(v) || 0)

const asUsage = (v: unknown): Usage | null =>
  v && typeof v === 'object'
    ? {
      input: num((v as Usage).input),
      output: num((v as Usage).output),
      cost: num((v as Usage).cost),
    }
    : null

const addUsage = (into: Usage, value: Usage | null): void => {
  if (!value) return
  into.input += value.input
  into.output += value.output
  into.cost += value.cost
}

const sumUsage = (a: Usage | null, b: Usage | null): Usage | null => {
  if (!a) return b ? { ...b } : null
  if (!b) return { ...a }
  return { input: a.input + b.input, output: a.output + b.output, cost: a.cost + b.cost }
}

const serialize = (value: unknown): string => {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch { return String(value) }
}

/** Byte length and byte-domain truncation, matching `snapshot.js`'s Buffer arithmetic. */
export function byteLength(text: string): number {
  if (encoder) return encoder.encode(text).length
  let n = 0
  for (const ch of text) n += ch.codePointAt(0)! < 0x80 ? 1 : ch.codePointAt(0)! < 0x800 ? 2 : ch.codePointAt(0)! < 0x10000 ? 3 : 4
  return n
}

function previewBytes(text: string, max = RESULT_PREVIEW_BYTES): string {
  if (!encoder || !decoder) return text.slice(0, max)
  const bytes = encoder.encode(text)
  if (bytes.length <= max) return text
  // A split multibyte sequence decodes to U+FFFD here and on the server (Buffer's
  // toString('utf8') does the same), so the two previews agree byte for byte.
  return decoder.decode(bytes.subarray(0, max))
}

function blankDelta(): DeltaFacts {
  return {
    attempts: 0,
    usage: null,
    attemptUsage: null,
    durationMs: null,
    resultPreview: null,
    resultBytes: null,
    resultTruncated: false,
    sessionId: null,
    liveTokens: null,
    cumTokens: null,
    hasResult: false,
    hasSession: false,
    hasLiveTokens: false,
    cumFirst: null,
    cumChain: { input: 0, output: 0 },
    index: null,
  }
}

export function createJournalDelta(): JournalDelta {
  return {
    byKey: new Map(),
    indexByKey: new Map(),
    answers: new Map(),
    mailById: new Map(),
    mailDoneById: new Map(),
    legacyMail: [],
    spend: { input: 0, output: 0, cost: 0 },
    records: 0,
    unknown: 0,
  }
}

function entry(delta: JournalDelta, key: string): DeltaFacts {
  let found = delta.byKey.get(key)
  if (!found) delta.byKey.set(key, (found = blankDelta()))
  return found
}

/**
 * Fold one streamed journal record. Only the six types §5.6.5 forwards are applied; the
 * stream never carries `meta` (its `args` can hold secrets) and nothing here throws on an
 * unrecognized type — it is counted for §6.5's debug row.
 */
export function ingestJournalRecord(delta: JournalDelta, record: unknown): JournalDelta {
  const rec = record as Record<string, unknown> | null
  if (!rec || typeof rec !== 'object') return delta
  delta.records++
  const key = typeof rec.key === 'string' ? rec.key : null

  switch (rec.type) {
    case 'result': {
      if (!key) break
      const facts = entry(delta, key)
      facts.attempts++
      facts.hasResult = true
      const attempt = asUsage(rec.usage)
      facts.attemptUsage = attempt
      facts.usage = sumUsage(facts.usage, attempt)
      addUsage(delta.spend, attempt)
      facts.durationMs = Number.isFinite(rec.durationMs) ? rec.durationMs as number : null
      if (Number.isInteger(rec.index)) {
        facts.index = rec.index as number
        delta.indexByKey.set(key, rec.index as number)
      }
      // **Every result field belongs to THIS record, or to no record at all.**
      //
      // A retry writes a second `result` for the same key, and it may carry no inline
      // value: a failed attempt records none, and §5.6.5 strips an oversize one before
      // forwarding. Carrying the previous attempt's preview and size forward would pair
      // the newest attempt's status and duration with an older attempt's output — the one
      // reading of the numbers that is wrong in a way the operator cannot see. Cleared
      // first, then re-supplied below only from this record.
      facts.resultPreview = null
      facts.resultBytes = null
      facts.resultTruncated = false
      if (Object.prototype.hasOwnProperty.call(rec, 'result')) {
        const text = serialize(rec.result)
        facts.resultBytes = byteLength(text)
        facts.resultTruncated = facts.resultBytes > 64 * 1024
        facts.resultPreview = previewBytes(text)
      } else if (rec.resultTruncated) {
        // §5.6.5's oversize preview: the value was stripped upstream. Take the size and
        // the flag; the preview stays null rather than being invented from a record that
        // deliberately does not carry the value — and rather than being inherited from an
        // earlier attempt, which is the same lie with a plausible face.
        facts.resultBytes = Number.isFinite(rec.resultBytes) ? rec.resultBytes as number : null
        facts.resultTruncated = true
      }
      break
    }
    case 'session':
      if (!key) break
      entry(delta, key).sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : null
      entry(delta, key).hasSession = true
      break
    case 'usage-cum': {
      if (!key) break
      const facts = entry(delta, key)
      const cum = rec.cum as LiveTokens | undefined
      // `{0,0}` is a RESET MARKER, not a datum (RECON-flowition §1.4) — and it wins over
      // the base exactly like any later record, which is how a re-attempt's counter
      // returns to zero instead of appearing to stall at the old total.
      const next = { input: num(cum?.input), output: num(cum?.output) }
      // …which is exactly why the LIVE counter cannot also be the lifetime figure: the
      // reset takes the earlier attempts' tokens with it. `cumChain` banks the positive
      // deltas so the restart costs nothing (§6.2 `AgentView.cumTokens`).
      if (!facts.hasLiveTokens) facts.cumFirst = next
      else {
        const prev = facts.liveTokens!
        facts.cumChain.input += Math.max(0, next.input - prev.input)
        facts.cumChain.output += Math.max(0, next.output - prev.output)
      }
      facts.liveTokens = next
      facts.hasLiveTokens = true
      break
    }
    case 'answer':
      if (rec.qid != null) delta.answers.set(String(rec.qid), rec.value)
      break
    case 'mail': {
      const mail = rec as JournalMailRecord
      if (mail.id != null) delta.mailById.set(String(mail.id), mail)
      else delta.legacyMail.push(mail)
      break
    }
    case 'mail-done':
      if (rec.id != null) {
        delta.mailDoneById.set(String(rec.id), rec as { dropped?: boolean; skipped?: boolean })
      }
      break
    default:
      delta.unknown++
  }
  return delta
}

// ---- base capture -----------------------------------------------------------------------

/** The per-mail facts §6.4 J supplies — see `JOURNAL_DERIVED_MAIL_FIELDS` for provenance. */
export interface MailFacts {
  origin: 'operator' | 'workflow' | null
  callsite: string | null
  /** Only ever `'skipped'`: the one verdict no mail event can produce. */
  delivery: string | null
  approximate: boolean
}

/**
 * **The whole journal layer, in one clearable object.**
 *
 * A `sys/reset` on the journal stream means the file every one of these describes no
 * longer exists (§5.6.4), so the reset is `base = createJournalBase(); delta =
 * createJournalDelta()` and nothing else — one assignment per layer, with no journal
 * projection left hiding inside the fold to survive it. `seedFoldState` is the other half:
 * what it strips out of the fold is exactly what this captures.
 */
export interface JournalBase {
  /** Agent facts by `key` — §6.4 J's primary join. */
  byKey: Map<string, JournalFacts>
  /** Agent facts for KEYLESS agents, which the server joins by index (snapshot.js:76). */
  byIndex: Map<number, JournalFacts>
  /** Pre-E7 answers: those runs answer only in the journal (src/engine.js:699). */
  answers: Map<string, unknown>
  /** Mail enrichment, by `mailSignature`. */
  mail: Map<string, MailFacts>
  /**
   * **Steer provenance, by `mailId`** — the same journal fact as `MailFacts.origin`,
   * reached through the other index.
   *
   * `emitSteered` (src/engine.js:653–660) emits `state`, `delivery`, `mailId`, `phase` and
   * `phaseIndex` — and no `origin`, for either of its senders (the control socket at :691
   * and the workflow handle at :1131/:1267). So `foldAgent`'s `ev.origin === 'workflow' ?
   * … : 'operator'` (fold.js:235) reads `'operator'` for EVERY real steer, and the
   * `workflow` verdict on a snapshot came from `snapshot.js:123–129`, which looks the
   * steer's `mailId` up in the journal's mail records. That makes it a journal projection
   * like every other entry in this object: cleared by a `sys/reset` on the journal stream,
   * re-derived from the stream's own mail records, and never left behind in the fold.
   */
  steerOrigin: Map<string, 'operator' | 'workflow'>
  /** `detail.spend` — an aggregate over the journal's result records, nothing else. */
  spend: Usage | null
}

export function createJournalBase(): JournalBase {
  return {
    byKey: new Map(),
    byIndex: new Map(),
    answers: new Map(),
    mail: new Map(),
    steerOrigin: new Map(),
    spend: null,
  }
}

const factsOf = (agent: AgentView): JournalFacts => ({
  attempts: agent.attempts ?? 0,
  usage: agent.usage ? { ...agent.usage } : null,
  attemptUsage: agent.attemptUsage ? { ...agent.attemptUsage } : null,
  durationMs: agent.durationMs ?? null,
  resultPreview: agent.resultPreview ?? null,
  resultBytes: agent.resultBytes ?? null,
  resultTruncated: Boolean(agent.resultTruncated),
  sessionId: agent.sessionId ?? null,
  liveTokens: agent.liveTokens ? { ...agent.liveTokens } : null,
  cumTokens: agent.cumTokens ? { ...agent.cumTokens } : null,
})

/**
 * Capture the server's join out of a snapshot — every part of it.
 *
 * It has to be captured rather than read back off the fold at commit time because
 * `foldAgent` overwrites `usage` from an agent event's own (single-attempt) `usage` field,
 * and because a value with two homes is a value a reset cannot clear.
 */
export function journalBaseFromDetail(detail: RunDetail): JournalBase {
  const base = createJournalBase()
  const legacy = isLegacyEngine(detail.caps)

  for (const agent of detail.agents ?? []) {
    const facts = factsOf(agent)
    if (agent.key != null) base.byKey.set(agent.key, facts)
    else base.byIndex.set(agent.index, facts)
    // A steer with an id is a steer the journal wrote a mail record for (`out.mailId` is
    // set on the line before the append, src/agent-proc.js:165–167), so the snapshot's
    // origin for it IS that record's. One without an id was never journaled — a dropped or
    // replay-suppressed send returns before the append — and has nothing here to capture.
    for (const steer of agent.steers ?? []) {
      if (steer.mailId != null) base.steerOrigin.set(steer.mailId, steer.origin)
    }
  }

  if (legacy) for (const q of detail.questions ?? []) if (q.answered) base.answers.set(q.qid, q.answer ?? null)

  const scopes = (detail.attemptScopes ?? []).length
    ? detail.attemptScopes!.map((s) => s.mail ?? [])
    : [detail.mail ?? []]
  for (const mail of scopes.flat() as (MailView & { approximate?: boolean })[]) {
    const facts: MailFacts = {
      origin: mail.origin ?? null,
      callsite: mail.callsite ?? null,
      delivery: mail.delivery === 'skipped' ? 'skipped' : null,
      approximate: Boolean(mail.approximate),
    }
    if (facts.origin || facts.callsite || facts.delivery || facts.approximate) {
      base.mail.set(mailSignature(mail), facts)
    }
  }

  base.spend = detail.spend ? { ...detail.spend } : null
  return base
}

function combine(base: JournalFacts | undefined, d: DeltaFacts | undefined): JournalFacts | null {
  if (!base && !d) return null
  if (!d) return base ?? null
  return {
    attempts: (base?.attempts ?? 0) + d.attempts,
    usage: sumUsage(base?.usage ?? null, d.usage),
    attemptUsage: d.hasResult ? d.attemptUsage : base?.attemptUsage ?? null,
    durationMs: d.hasResult ? d.durationMs : base?.durationMs ?? null,
    // `hasResult`, not "has a value": the LAST result record owns these fields whether or
    // not it carries one. Falling back to the base here would re-attach the snapshot's
    // (earlier) attempt output to a newer attempt — see the note in `ingestJournalRecord`.
    // A null then means "the journal says nothing", and `write` leaves the events fold's
    // own `resultPreview` (engine.js:1061) standing, exactly as `snapshot.js` does.
    resultPreview: d.hasResult ? d.resultPreview : base?.resultPreview ?? null,
    resultBytes: d.hasResult ? d.resultBytes : base?.resultBytes ?? null,
    resultTruncated: d.hasResult ? d.resultTruncated : Boolean(base?.resultTruncated),
    sessionId: d.hasSession ? d.sessionId : base?.sessionId ?? null,
    liveTokens: d.hasLiveTokens ? d.liveTokens : base?.liveTokens ?? null,
    cumTokens: chainCum(base, d),
  }
}

/**
 * Close the base/delta seam of the `usage-cum` chain (§6.2 `AgentView.cumTokens`).
 *
 * The delta's first report is measured against the base's LAST one, not against zero —
 * otherwise a continued thread-cumulative counter would be banked a second time on top of
 * the total the server already chained, which is the double-count the whole field exists
 * to avoid.
 */
function chainCum(base: JournalFacts | undefined, d: DeltaFacts): LiveTokens | null {
  if (!d.cumFirst) return base?.cumTokens ?? null
  const prev = base?.liveTokens ?? { input: 0, output: 0 }
  const banked = base?.cumTokens ?? { input: 0, output: 0 }
  return {
    input: banked.input + d.cumChain.input + Math.max(0, d.cumFirst.input - prev.input),
    output: banked.output + d.cumChain.output + Math.max(0, d.cumFirst.output - prev.output),
  }
}

// ---- application ------------------------------------------------------------------------

export interface JoinResult {
  /** `detail.spend` plus the delta's result usages, or null when nothing ever reported. */
  spend: Usage | null
  openQuestions: number
}

/**
 * Apply `combine(base, delta)` onto a freshly materialized projection, IN PLACE.
 *
 * Mutation is safe and deliberate: `materializeFold` hands back new objects on every call
 * (that is the §6.4-step-8 contract), so this never touches a rendered snapshot.
 */
export function applyJournalJoin(
  projected: MaterializedFold,
  base: JournalBase,
  delta: JournalDelta,
  { dead = false } = {},
): JoinResult {
  const agents = projected.agents as AgentView[]
  const byIndex = new Map<number, AgentView>(agents.map((a) => [a.index, a]))

  const write = (agent: AgentView | undefined, facts: JournalFacts | null): void => {
    if (!agent || !facts) return
    if (facts.attempts > 0) agent.attempts = facts.attempts
    if (facts.usage) agent.usage = facts.usage
    if (facts.attemptUsage) agent.attemptUsage = facts.attemptUsage
    if (facts.durationMs != null) agent.durationMs = facts.durationMs
    if (facts.resultPreview != null) agent.resultPreview = facts.resultPreview
    if (facts.resultBytes != null) agent.resultBytes = facts.resultBytes
    agent.resultTruncated = facts.resultTruncated
    if (facts.sessionId != null) agent.sessionId = facts.sessionId
    if (facts.liveTokens) agent.liveTokens = facts.liveTokens
    if (facts.cumTokens) agent.cumTokens = facts.cumTokens
  }

  const keys = new Set<string>([...base.byKey.keys(), ...delta.byKey.keys()])
  for (const key of keys) {
    const agent = agents.find((a) => a.key === key)
      ?? (delta.indexByKey.has(key) ? byIndex.get(delta.indexByKey.get(key)!) : undefined)
    write(agent, combine(base.byKey.get(key), delta.byKey.get(key)))
  }
  // Keyless agents (§6.4 J's key→index fallback, snapshot.js:76): the stream's own records
  // are keyed, so only the captured base can speak for them — and it is cleared by a reset
  // exactly like the keyed half.
  for (const [index, facts] of base.byIndex) {
    const agent = byIndex.get(index)
    if (agent && agent.key == null) write(agent, facts)
  }

  // E7 pre-dates nothing on the stream, but a run recorded before it answers only in the
  // journal, so this is the path that un-blocks the Inbox for old runs. The delta (a record
  // streamed since the snapshot) outranks the base (the snapshot's own join).
  for (const q of projected.questions as QuestionView[]) {
    if (q.answered) continue
    const source = delta.answers.has(q.qid) ? delta.answers : base.answers.has(q.qid) ? base.answers : null
    if (!source) continue
    q.answered = true
    q.answer = source.get(q.qid) as string | null
    q.abandoned = false
  }

  joinMail(projected, base, delta)
  joinSteers(agents, base, delta)

  const spend = delta.spend.input || delta.spend.output || delta.spend.cost
    ? sumUsage(base.spend, delta.spend)
    : base.spend
  const openQuestions = dead
    ? 0
    : (projected.questions as QuestionView[]).filter((q) => !q.answered && !q.abandoned).length
  projected.openQuestions = openQuestions
  return { spend, openQuestions }
}

/**
 * Steering provenance, the mirror of `joinMail`'s `mailId` pass (snapshot.js:123–129).
 *
 * The `steered` EVENT carries no `origin` (src/engine.js:653–660), so the fold's steers are
 * uniformly `'operator'` and this is the only thing that can say otherwise — which is
 * precisely why it lives in the journal layer: a live `spawn()`/`sendTo()` steer reads
 * `workflow` the moment its journal mail record arrives on the stream, a re-fold of the
 * events stream (a `sys/reset` on `e`) has it re-applied here rather than losing it, and a
 * `sys/reset` on `j` empties both maps and it correctly reverts to the event's own answer.
 *
 * `materializeFold` copies each steer (fold.js:489), so mutating them cannot reach back
 * into the accumulator and accumulate.
 *
 * A steer with no `mailId` is unreachable from here BY CONSTRUCTION — nothing was
 * journaled (agent-proc.js:107–108: a suppressed or dropped send journals nothing), so a
 * `replayed`/`dropped` workflow steer reads `operator` until the engine adds `origin` to
 * the `steered` event, which `fold.js:235` already consumes and which this function then
 * leaves alone. The server's snapshot has exactly the same blind spot, so the two agree.
 */
function joinSteers(agents: AgentView[], base: JournalBase, delta: JournalDelta): void {
  if (!base.steerOrigin.size && !delta.mailById.size) return
  for (const agent of agents) {
    for (const steer of agent.steers ?? []) {
      if (steer.mailId == null) continue
      const rec = delta.mailById.get(steer.mailId)
      // The delta outranks the base, exactly as everywhere else in this file.
      if (rec) steer.origin = rec.origin === 'workflow' ? 'workflow' : 'operator'
      else {
        const captured = base.steerOrigin.get(steer.mailId)
        if (captured) steer.origin = captured
      }
    }
  }
}

/**
 * E8 exact correlation, then §6.4 J's legacy TWO-HOP fallback (critique N4): journal mail
 * records carry `key`, not an index, so map key→index and match `(index, text, |Δt| ≤ 5s)`,
 * flagged approximate. A key that never acquired an index stays run-scoped rather than
 * being attached to a guess.
 *
 * **Where key→index comes from.** It used to come from `delta.indexByKey` alone, which only
 * `result` records populate — so on a live legacy run a streamed mail record stayed
 * unjoined (`origin`/`callsite` null, no `approximate` flag) until the agent it belongs to
 * FINISHED, which for the long-running agent an operator is actually watching can be
 * minutes. The projection already knows the answer: an agent event carries `key` and
 * `index` together, so `projected.agents` holds the relation from the moment the agent
 * starts. That is consulted first, with the delta's own result records behind it for an
 * agent the events fold has not seen (a `sys/reset` on `e` mid-replay).
 *
 * The mapping is deliberately NOT captured into `JournalBase`. That object is "the whole
 * journal layer, in one clearable object" and a `sys/reset` on the journal stream empties
 * it; key→index is an EVENTS fact, and a journal reset that could take it away would be
 * §9.4's per-stream rule broken in the other direction.
 */
function joinMail(projected: MaterializedFold, base: JournalBase, delta: JournalDelta): void {
  const scopes = projected.attemptScopes ?? []
  const allMail: MailView[] = scopes.length
    ? scopes.flatMap((s) => s.mail as MailView[])
    : (projected.mail as MailView[])

  // The snapshot's own enrichment first (it was stripped out of the fold at seed time), so
  // that a record the stream has said nothing new about still reads exactly as the server
  // joined it — and reads as bare mail once a reset has emptied this map.
  if (base.mail.size) {
    for (const mail of allMail) {
      const facts = base.mail.get(mailSignature(mail))
      if (!facts) continue
      mail.origin = facts.origin
      mail.callsite = facts.callsite
      if (facts.delivery) mail.delivery = facts.delivery
      if (facts.approximate) (mail as MailView & { approximate?: boolean }).approximate = true
    }
  }

  for (const mail of allMail) {
    if (mail.mailId == null) continue
    const rec = delta.mailById.get(mail.mailId)
    if (rec) {
      mail.origin = (rec.origin === 'workflow' ? 'workflow' : 'operator')
      mail.callsite = rec.callsite ?? null
    }
    const done = delta.mailDoneById.get(mail.mailId)
    if (done?.dropped) mail.delivery = 'dropped'
    else if (done?.skipped) mail.delivery = 'skipped'
  }

  if (!delta.legacyMail.length) return
  const indexByKey = new Map<string, number>()
  for (const agent of projected.agents as AgentView[]) {
    if (agent.key != null && Number.isInteger(agent.index) && !indexByKey.has(agent.key)) {
      indexByKey.set(agent.key, agent.index)
    }
  }
  for (const rec of delta.legacyMail) {
    const index = rec.key != null
      ? indexByKey.get(rec.key) ?? delta.indexByKey.get(rec.key)
      : undefined
    if (!Number.isInteger(index)) continue
    let best: MailView | null = null
    let distance = Infinity
    for (const mail of allMail) {
      if (mail.mailId != null || mail.agent !== index) continue
      if (mail.message !== String(rec.text ?? '')) continue
      const d = Math.abs((mail.at ?? 0) - (rec.t ?? 0))
      if (d <= 5000 && d < distance) { best = mail; distance = d }
    }
    if (best) {
      best.origin = (rec.origin === 'workflow' ? 'workflow' : 'operator')
      best.callsite = rec.callsite ?? null
      ;(best as MailView & { approximate?: boolean }).approximate = true
    }
  }
}
