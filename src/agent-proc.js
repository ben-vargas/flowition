// AgentJob — one logical agent() call, possibly spanning multiple provider turns:
//   turn 1..n: initial prompt → [schema-corrective turn] → [queued-mail follow-up turns]
// Live-steer adapters (claude, amp, mock) receive injected user messages on stdin
// mid-process; turn-steer adapters (codex, droid, opencode, pi) get queued mail
// delivered via a session-resume follow-up turn. Session ids, accepted steering
// messages, and cumulative-usage baselines are journaled, so an interrupted agent
// can be continued (not restarted) on `flowition resume` without losing steering.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { makeParser } from './adapters/protocols.js'
import { wfMailKey } from './journal.js'
import { LineSplitter, RingBuffer, truncate, parseJsonLoose } from './util.js'
import { validate, schemaInstruction } from './schema.js'

export class AgentError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message)
    this.code = code
    this.retryable = retryable
  }
}

const DEFAULT_STALL_MS = 30 * 60_000

export class AgentJob {
  constructor({ adapter, spec, prompt, index, key, label, runId, scratch, transcript, journal, priorSessionId, pendingMail, deliveredWorkflowMail, restoredWorkflowMail, usageCum, controlSock, binPath }) {
    Object.assign(this, { adapter, spec, prompt, index, key, label, runId, scratch, transcript, journal, priorSessionId, deliveredWorkflowMail, restoredWorkflowMail, controlSock, binPath })
    this.sessionId = priorSessionId ?? (adapter.caps.selfSession ? crypto.randomUUID() : null)
    this.usage = { input: 0, output: 0, cost: 0 }
    // Cumulative-usage baseline: codex reports the THREAD's running totals each
    // turn; we charge only the delta. Restored from the journal across runs —
    // but a baseline is only meaningful for a thread we can resume: with no
    // journaled prior session the restored baseline's thread cannot be
    // continued, and a DOUBLY-sessionless new attempt (no session event ever
    // fires) would clamp its deltas against it forever. Discard it now and
    // journal the zero-reset so Journal.load chaining doesn't clamp either;
    // the session-event reset below still covers thread changes.
    this.cumBase = usageCum ?? null
    if (this.cumBase != null && priorSessionId == null) {
      this.cumBase = null
      journal.append({ type: 'usage-cum', key: this.key, cum: { input: 0, output: 0 } })
    }
    this.mailQueue = (pendingMail ?? []).map((m) => ({ id: m.id, text: m.text }))
    this.mailWaiters = []
    // Per-(key,sender,callsite) ordinals of workflow-origin sends within the
    // run: a re-executing sender branch replays each call site's sends in
    // order, so the Nth re-send from that branch AND call site is the same
    // logical send as the original run's Nth — sender+callsite+seq is the
    // replay identity (see send()).
    this.wfSendSeq = new Map() // sender branch + callsite -> count
    this.child = null
    this.liveWrite = null
    this.cancelled = false
    this.started = false
    this.settled = false
    this.pendingDelivery = null
    // Mail delivered by turns that never captured a session id (degenerate
    // stream): not durable yet — the engine journals mail-done for these only
    // when it writes the COMPLETED result record. See runTurn.
    this.sessionlessDelivered = []
    this.lastTool = null
  }

  // Returns 'live' | 'queued' | 'replayed'. Live = injected into the running
  // process now; queued = will be delivered as a follow-up turn (or to a waiting
  // direct adapter); replayed = crash-resume suppression, see below.
  // Every accepted message is journaled and only marked done once it has actually
  // reached the provider session, so steering survives interruption and resume.
  // origin: 'operator' (control socket) vs 'workflow' (sendTo/spawn handle) — the
  // engine restores ALL pending mail on resume; a re-executing workflow's
  // re-sends of workflow-origin text are absorbed against the restored and
  // delivered multisets below. Default 'operator' for safety: a possible
  // duplicate beats loss.
  send(message, origin = 'operator', sender = null, callsite = null) {
    const text = String(message)
    // Crash-window replay: this send's identity is
    // key+SENDER+CALLSITE+text+ORDINAL — sender is the sending context's
    // resume-key branch (sendTo() captures it at call time, a spawn() handle
    // at creation; operator mail carries none), callsite the workflow-side
    // call position file:line:column (deterministic across replays — resume
    // pins the workflow file and graph byte-for-byte), and seq the Nth
    // workflow send from that sender AND call site to this agent in the run.
    // Each call site replays its sends in order under re-execution, so a
    // re-send is absorbed only when sender, callsite, text AND seq all match
    // a delivery/restoration from before the interruption. Without the
    // sender, recovery that legitimately changes control flow (a retried
    // agent succeeding alters branches) could cross-absorb a DIFFERENT
    // branch's send sharing text and position; without the callsite,
    // SEQUENTIAL call sites within one branch (if/else arms, consecutive
    // lines) share an identity and a recovery that switches arms could still
    // absorb a different logical send. With both, different branches and
    // different call sites can never absorb each other's sends — uncertainty
    // duplicates (at-least-once into the continued session), never
    // suppresses. Legacy records fall back one layer at a time: journaled
    // without callsite to sender+text+seq, without sender to text+seq, and
    // seq-less to text-only — all bounded to old journals.
    let seq = null
    if (origin === 'workflow') {
      const sk = (sender ?? '') + '\0' + (callsite ?? '')
      seq = (this.wfSendSeq.get(sk) ?? 0) + 1
      this.wfSendSeq.set(sk, seq)
      const absorb = (m, note) => {
        if (!m) return false
        for (const mk of [wfMailKey(text, seq, sender, callsite), wfMailKey(text, seq, sender, null), wfMailKey(text, seq, null, null), wfMailKey(text, null, null, null)]) {
          const n = m.get(mk) ?? 0
          if (n > 0) {
            m.set(mk, n - 1)
            this.transcript.write('status', { text: note + truncate(text, 200) })
            return true
          }
        }
        return false
      }
      // Delivered before the crash (mail-done journaled, result record lost):
      // the continued session already has it — deliver nothing, journal NOTHING.
      if (absorb(this.deliveredWorkflowMail, 'workflow mail replay-suppressed — already delivered before the interruption: ')) return 'replayed'
      // Restored-pending: the matching send sits in this job's queue, restored
      // from the journal — the restored copy carries the delivery under its
      // original id, so the re-send is absorbed rather than doubled.
      if (absorb(this.restoredWorkflowMail, 'workflow mail replay-suppressed — the restored pending copy carries the delivery: ')) return 'replayed'
    }
    // A settled agent has no turn left to consume mail — journaling it would
    // strand a pending record forever (resume replays the cached result and
    // never constructs a job for this key again).
    if (this.settled) {
      this.transcript.write('status', { text: 'mail dropped — agent already settled: ' + truncate(text, 200) })
      return 'dropped'
    }
    const mail = { id: crypto.randomUUID(), text }
    this.transcript.write('mail-in', { text: mail.text })
    this.journal.append({ type: 'mail', key: this.key, id: mail.id, text: mail.text, origin, ...(seq != null ? { seq } : {}), ...(sender != null ? { sender } : {}), ...(callsite != null ? { callsite } : {}) })
    if (this.adapter.caps.steer === 'live' && this.liveWrite && this.liveWrite(mail)) return 'live'
    const waiter = this.mailWaiters.shift()
    if (waiter) {
      // delivered into the current direct turn — done only when that turn completes
      ;(this.liveDelivered ??= []).push(mail)
      waiter(mail.text)
      return 'live'
    }
    this.mailQueue.push(mail)
    return 'queued'
  }

  cancel() {
    this.cancelled = true
    const c = this.child
    if (c) {
      try { c.kill('SIGTERM') } catch { /* already dead */ }
      const t = setTimeout(() => { try { c.kill('SIGKILL') } catch { /* gone */ } }, 5000)
      t.unref?.()
    }
    // unblock any direct adapter waiting on mail
    for (const w of this.mailWaiters.splice(0)) w('__cancelled__')
  }

  canFollowUp() {
    return this.adapter.caps.resume && !!this.sessionId
  }

  async execute() {
    let prompt = this.prompt
    if (this.spec.schema && this.adapter.caps.schema === 'prompt') prompt += schemaInstruction(this.spec.schema)
    // Continue an interrupted session rather than starting over — both across runs
    // (a prior run journaled a session id) and across in-process retries (a failed
    // first attempt already captured a session). selfSession adapters (pi) ignore
    // the mode but still need the interruption nudge.
    const continuing = this.priorSessionId != null || (this.started && !!this.sessionId && this.adapter.caps.resume)
    let mode = 'fresh'
    if (continuing) {
      prompt = 'You were interrupted while working on a task in a previous session. Any command that appears rejected or cancelled at the end of that session was killed by the infrastructure interruption — it was NOT a user refusal. Pick up where you left off: re-run or skip the interrupted step as appropriate, then complete the task and deliver the final answer. Do not ask for confirmation.\n\nOriginal task:\n' + prompt
      mode = 'resume'
    }
    this.started = true
    let schemaRetries = 0
    for (;;) {
      if (this.cancelled) throw new AgentError('cancelled', 'agent cancelled')
      const turn = await this.runTurn(prompt, mode)
      mode = 'resume'
      if (this.spec.schema) {
        const value = turn.structured !== undefined ? turn.structured : parseJsonLoose(turn.text)
        const errs = value === undefined ? ['no JSON value found in final message'] : validate(this.spec.schema, value)
        if (errs.length) {
          if (schemaRetries < 1 && this.canFollowUp() && !this.cancelled) {
            schemaRetries++
            this.transcript.write('status', { text: 'schema validation failed, requesting correction: ' + errs.join('; ') })
            prompt = 'Your previous final answer failed schema validation:\n- ' + errs.join('\n- ') +
              '\nReturn ONLY a corrected JSON value conforming to the schema.' + schemaInstruction(this.spec.schema)
            continue
          }
          throw new AgentError('schema_invalid', 'structured output failed schema: ' + errs.join('; '))
        }
        turn.structured = value
      }
      if (this.mailQueue.length && this.canFollowUp() && !this.cancelled) {
        const mail = this.mailQueue.splice(0)
        this.transcript.write('status', { text: `delivering ${mail.length} queued message(s) via follow-up turn` })
        prompt = 'Message(s) from the orchestrator while you were working:\n' + mail.map((m) => '- ' + m.text).join('\n') +
          '\nIncorporate them and provide your updated final answer.'
        if (this.spec.schema && this.adapter.caps.schema === 'prompt') prompt += schemaInstruction(this.spec.schema)
        this.pendingDelivery = mail
        continue
      }
      // dropped:true — the text never reached the provider (like the legacy
      // resume tombstones' skipped:true): a plain mail-done here would count into
      // Journal.load's delivered multiset and replay-suppress the resumed
      // workflow's genuine re-send after a crash-before-result.
      for (const mail of this.mailQueue.splice(0)) {
        this.journal.append({ type: 'mail-done', key: this.key, id: mail.id, dropped: true })
        this.transcript.write('status', { text: 'mail DROPPED undelivered because the provider session cannot take a follow-up turn: ' + truncate(mail.text, 200) })
      }
      // Acceptance closes HERE, in the same synchronous segment as the final
      // queue check above: once execute()'s promise resolves, workflow
      // microtasks can run before the engine's finally sets settled, and a
      // send() landing in that window would journal a mail record no turn
      // will ever consume (completed keys replay from cache — the pending
      // record strands forever). Failure/throw paths must NOT settle: the
      // engine retries retryable errors with this same job, and mail accepted
      // between attempts still has a turn to ride.
      this.settled = true
      return turn
    }
  }

  runTurn(prompt, mode) {
    this.liveDelivered = []
    const done = this.adapter.direct ? this.runDirectTurn(prompt, mode) : this.runProcessTurn(prompt, mode)
    // Mail (queued-in-prompt or live-injected) counts as delivered only once the
    // turn that carried it completes; a failed turn requeues it (at-least-once).
    return done.then(
      (r) => {
        // Delivery is durable only if the session is resumable: with a session
        // id, resume continues the SAME provider thread and the mail is already
        // in it. A turn that completed WITHOUT ever emitting a session event
        // cannot be continued — journaling mail-done now would lose the
        // guidance if the engine dies before the result record (resume starts
        // a FRESH session, operator mail is no longer pending, and workflow
        // re-sends are replay-suppressed). Stash instead: the engine journals
        // these once the COMPLETED result record makes the delivery durable.
        const delivered = [...(this.pendingDelivery ?? []), ...this.liveDelivered]
        if (this.sessionId != null) {
          for (const m of delivered) this.journal.append({ type: 'mail-done', key: this.key, id: m.id })
        } else {
          this.sessionlessDelivered.push(...delivered)
        }
        this.pendingDelivery = null
        this.liveDelivered = []
        return r
      },
      (err) => {
        // Requeue preserving ACCEPTANCE order, ahead of not-yet-delivered mail:
        // pendingDelivery (accepted before the turn) precedes liveDelivered
        // (accepted during it) — pushing the live batch to the back would
        // re-apply steering out of order on retry.
        this.mailQueue.unshift(...(this.pendingDelivery ?? []), ...this.liveDelivered)
        this.pendingDelivery = null
        this.liveDelivered = []
        throw err
      },
    )
  }

  async runDirectTurn(prompt, mode) {
    const io = {
      emit: (e) => this.handleEvent(e),
      waitMail: () => {
        const m = this.mailQueue.shift()
        if (m) {
          ;(this.liveDelivered ??= []).push(m)
          return Promise.resolve(m.text)
        }
        return new Promise((resolve) => this.mailWaiters.push(resolve))
      },
      mode,
      sessionId: this.sessionId,
      isCancelled: () => this.cancelled,
    }
    const out = await this.adapter.direct({ prompt, spec: this.spec, io })
    if (this.cancelled) throw new AgentError('cancelled', 'agent cancelled')
    this.transcript.write('text', { text: out.text })
    return { text: out.text, structured: out.structured }
  }

  async runProcessTurn(prompt, mode) {
    let built = null
    let child = null
    let turnResult = null
    let turnError = null
    let stalled = false
    let outstanding = 1
    let stdinOpen = true
    let stallTimer = null
    const parser = makeParser(this.adapter.protocol)
    const stderrTail = new RingBuffer()

    try {
      built = this.adapter.build({ spec: this.spec, prompt, mode, sessionId: this.sessionId, scratch: this.scratch })
      child = spawn(this.adapter.bin(), built.argv, {
        cwd: this.spec.cwd || process.cwd(),
        env: {
          ...process.env,
          FLOWITION_RUN_ID: this.runId,
          FLOWITION_AGENT_INDEX: String(this.index),
          FLOWITION_CONTROL_SOCK: this.controlSock ?? '',
          FLOWITION_BIN: this.binPath ?? '',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      this.child = child

      const endStdin = () => { if (stdinOpen) { stdinOpen = false; try { child.stdin.end() } catch { /* closed */ } } }
      if (built.stdin != null) child.stdin.write(built.stdin)
      if (!built.keepOpen) endStdin()
      else {
        this.liveWrite = (mail) => {
          if (!stdinOpen) return false
          outstanding++
          this.liveDelivered.push(mail)
          const undo = () => {
            outstanding--
            const i = this.liveDelivered.indexOf(mail)
            if (i !== -1) this.liveDelivered.splice(i, 1)
          }
          try {
            child.stdin.write(this.adapter.userMessage(mail.text) + '\n', (err) => {
              // async write failure (e.g. EPIPE): the message never reached the
              // agent — requeue it for a follow-up turn, at the FRONT so this
              // earlier-accepted message retries ahead of mail queued after it.
              // (Exact total order under multiple interleaved broken-pipe
              // failures is best-effort: callbacks fire in write order, so
              // several failed writes unshift in reverse among themselves.)
              // Its journal 'mail' record still stands (never marked done), so
              // no re-append.
              if (err) { undo(); this.mailQueue.unshift(mail) }
            })
            return true
          } catch {
            undo()
            return false
          }
        }
      }
      child.stdin.on('error', () => { stdinOpen = false })

      const stallMs = this.spec.stallMs ?? DEFAULT_STALL_MS
      const resetStall = () => {
        if (stallTimer) clearTimeout(stallTimer)
        stallTimer = setTimeout(() => { stalled = true; try { child.kill('SIGKILL') } catch { /* gone */ } }, stallMs)
        stallTimer.unref?.()
      }
      resetStall()

      const splitter = new LineSplitter()
      const consume = (events) => {
        for (const e of events) {
          if (e.k === 'result') {
            turnResult = { text: e.text, structured: e.structured, isError: e.isError }
            if (this.adapter.protocol !== 'claude-stream-eof') {
              outstanding--
              if (built.keepOpen && outstanding <= 0) endStdin()
            }
          } else if (e.k === 'turn-end') {
            outstanding--
            if (built.keepOpen && outstanding <= 0) endStdin()
          } else if (e.k === 'error') {
            turnError = e.message
            this.handleEvent(e)
          } else this.handleEvent(e)
        }
      }
      const onLine = (line) => {
        resetStall()
        let obj
        try { obj = JSON.parse(line) } catch { this.transcript.write('raw', { text: line }); return }
        // A parser bug on a weird event must fail this agent, not the engine.
        try { consume(parser.push(obj)) } catch (err) {
          this.transcript.write('status', { text: 'parser exception (event skipped): ' + err.message })
        }
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (c) => splitter.push(c, onLine))
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (c) => stderrTail.push(c))

      const [code, signal] = await new Promise((resolve, reject) => {
        child.on('error', (err) => reject(new AgentError('spawn_failed', `failed to spawn ${this.adapter.bin()}: ${err.message}`)))
        child.on('close', (c, s) => resolve([c, s]))
      })
      splitter.flush(onLine)
      try { consume(parser.finish()) } catch (err) {
        this.transcript.write('status', { text: 'parser exception at EOF: ' + err.message })
      }

      if (this.cancelled) throw new AgentError('cancelled', 'agent cancelled')
      if (stalled) throw new AgentError('stalled', `no output for ${Math.round((this.spec.stallMs ?? DEFAULT_STALL_MS) / 60000)}m — killed`, { retryable: true })
      if (turnError) throw new AgentError('provider_error', turnError)
      // Multi-message live turns: an earlier in-turn result must not stand in for
      // messages that never got answered (they'd be falsely marked delivered).
      if (built.keepOpen && outstanding > 0) {
        throw new AgentError('truncated', `process exited (code ${code}${signal ? `, signal ${signal}` : ''}) with ${outstanding} injected message(s) unanswered — refusing stale result`, { retryable: signal != null })
      }
      // Refuse results synthesized from partial output. Protocols with an explicit
      // completion event (codex/droid/pi/claude/amp) must have shown it regardless
      // of exit code; EOF-terminated protocols (opencode) additionally need exit 0.
      if (turnResult != null && parser.sawTerminal === false && (parser.terminalRequired || code !== 0)) {
        throw new AgentError('truncated', `process exited (code ${code}${signal ? `, signal ${signal}` : ''}) before the protocol's completion event — refusing partial result`, { retryable: signal != null })
      }
      if (turnResult == null) {
        const tail = stderrTail.toString().slice(-800)
        throw new AgentError('no_result', `process exited (code ${code}${signal ? `, signal ${signal}` : ''}) without a final result${tail ? '; stderr: ' + tail : ''}`, { retryable: signal != null })
      }
      if (turnResult.isError) throw new AgentError('provider_error', 'provider reported an error result: ' + truncate(turnResult.text ?? '', 400))
      return turnResult
    } finally {
      if (stallTimer) clearTimeout(stallTimer)
      this.child = null
      this.liveWrite = null
      for (const f of built?.tempFiles ?? []) {
        try { fs.unlinkSync(f) } catch { /* already gone */ }
      }
    }
  }

  handleEvent(e) {
    switch (e.k) {
      case 'session':
        if (e.id && e.id !== this.sessionId) {
          // a NEW provider thread starts its cumulative usage from zero — the old
          // baseline would clamp every delta until the new totals overtook it.
          // The baseline belongs to the journaled prior thread: only resuming
          // that SAME thread keeps it, anything else zeroes it. (A baseline
          // restored WITHOUT a prior session was already discarded in the
          // constructor — no session event is guaranteed to arrive at all.)
          if (this.cumBase != null && e.id !== this.priorSessionId) {
            this.cumBase = null
            this.journal.append({ type: 'usage-cum', key: this.key, cum: { input: 0, output: 0 } })
          }
          this.sessionId = e.id
          this.journal.append({ type: 'session', key: this.key, sessionId: e.id })
        }
        break
      case 'text': this.transcript.write('text', { text: e.text }); break
      case 'reasoning': this.transcript.write('reasoning', { text: e.text }); break
      case 'tool':
        this.lastTool = e.name
        this.transcript.write('tool', { name: e.name, input: e.input })
        break
      case 'tool-result': this.transcript.write('tool-result', { name: e.name, output: e.output, isError: e.isError }); break
      case 'usage':
        if (e.cumulative) {
          // Thread-cumulative report (codex): charge only the growth since the
          // journaled baseline. cachedInput is a subset of input — never added.
          const cum = { input: e.input ?? 0, output: e.output ?? 0 }
          const base = this.cumBase ?? { input: 0, output: 0 }
          this.usage.input += Math.max(0, cum.input - (base.input ?? 0))
          this.usage.output += Math.max(0, cum.output - (base.output ?? 0))
          this.cumBase = cum
          this.journal.append({ type: 'usage-cum', key: this.key, cum })
        } else {
          // Per-event report (claude/amp/droid/opencode/pi/mock): journal the
          // job's RUNNING totals after every event — one line per usage event,
          // an accepted volume — so Journal.load's cumTrack chaining charges
          // crash-window spend (tokens reported after the last result record)
          // for these adapters exactly as it does for codex. The totals are
          // monotone within a job; a restored baseline means a prior attempt's
          // records exist that this attempt's from-zero totals would clamp
          // against, so journal the zero-reset first, exactly like the codex
          // session-change path. (A prior sessionless attempt's baseline was
          // already discarded — and its reset journaled — in the constructor.)
          if (this.cumBase != null) {
            this.cumBase = null
            this.journal.append({ type: 'usage-cum', key: this.key, cum: { input: 0, output: 0 } })
          }
          this.usage.input += e.input ?? 0
          this.usage.output += e.output ?? 0
          this.usage.cost += e.cost ?? 0
          this.journal.append({ type: 'usage-cum', key: this.key, cum: { input: this.usage.input, output: this.usage.output } })
        }
        break
      case 'error': this.transcript.write('status', { text: 'error: ' + e.message }); break
    }
  }
}
