// journal.jsonl — the resume log. Entry types:
//   meta      {runId, workflowFile, fileHash, graphHash, args, seed, createdAt, keyVersion, defaults, budgetTotal}
//   started   {key, index, label, adapter}
//   session   {key, sessionId}          — provider session id, enables cross-run agent resume
//   usage-cum {key, cum}                — running-total usage snapshot: the provider thread's
//                                         cumulative totals for codex, the job's own running
//                                         totals (journaled per usage event) for per-event
//                                         adapters; a {0,0} record marks a restart of the totals
//   mail      {key, id, text, origin, seq, sender, callsite} — steering message accepted for an
//                                         agent (origin 'operator' | 'workflow'; absent =
//                                         operator). Workflow-origin records carry sender — the
//                                         sending context's resume-key branch (sendTo() capture /
//                                         spawn() handle creation; control-socket sends carry
//                                         none) — callsite: the workflow-side call position
//                                         file:line:column — and seq: the 1-based ordinal of that
//                                         (sender, callsite)'s sends to the key within the run.
//                                         Replay identity is key+sender+callsite+text+seq (legacy
//                                         records fall back a layer at a time: callsite-less match
//                                         on sender+text+seq, sender-less on text+seq, seq-less on
//                                         text alone)
//   mail-done {key, id, skipped?, dropped?} — delivered into the provider session, or terminally
//                                         declared undeliverable; skipped:true marks a legacy
//                                         resume tombstone (no longer written — pending workflow
//                                         mail now restores instead), dropped:true a
//                                         deliver-or-declare drop — both record mail that never
//                                         actually reached the provider.
//                                         Written at turn end only when a resumable session id
//                                         exists; a sessionless turn's deliveries are journaled by
//                                         the engine alongside the COMPLETED result record instead
//   result    {key, index, status, result, usage, durationMs, adapter, model, seeded?}
//                                       — seeded {from, index, usage} marks a cross-run
//                                         seed hit (--seed-from): the result was imported
//                                         from run `from` (its index/usage are provenance
//                                         only) and the record's own usage is null so
//                                         imported spend never enters budget aggregates
//   step-start {key, name, args}       — durable step() callback about to execute. A
//                                         start with no matching step-result is an
//                                         ambiguous crash window: the callback may or
//                                         may not have performed its side effect. Policy:
//                                         resume RE-RUNS it (callbacks must be idempotent
//                                         or carry their own idempotency keys).
//   step-result {key, name, status, result?, error?, durationMs} — step outcome. Only
//                                         status 'completed' is replayed on resume;
//                                         failed steps re-run like unfinished work.
//   answer    {qid, value}              — operator answers to ask(), replayed on resume
//   end       {status, error?}
import path from 'node:path'
import fs from 'node:fs'
import { appendJsonl, readJsonlStrict } from './util.js'

// Replay identity of a workflow-origin send: sender branch + call site + text
// + per-(key,sender,callsite) send ordinal. A re-send is absorbed only when
// ALL match — without the sender, recovery that changes control flow could
// cross-absorb a DIFFERENT branch's send that shares text AND position;
// without the call site, sequential call sites within ONE branch (if/else
// arms, consecutive lines) share an identity and a recovery that switches
// arms could still absorb a different logical send. With both, neither
// different branches nor different call sites can ever absorb each other's
// sends. Legacy records keep their narrower identities (callsite-less →
// sender+text+seq, sender-less → text+seq, seq-less → text-only), bounded to
// old journals.
export const wfMailKey = (text, seq, sender, callsite) => (sender == null ? '' : 'b' + sender + '\0') + (callsite == null ? '' : 'c' + callsite + '\0') + (seq == null ? 't\0' : 's' + seq + '\0') + text

export class Journal {
  constructor(dir) {
    this.file = path.join(dir, 'journal.jsonl')
  }
  append(obj) { appendJsonl(this.file, { t: Date.now(), ...obj }) }
  exists() { return fs.existsSync(this.file) }

  // Throws on interior corruption. {repair:true} (engine only, under the run lock)
  // additionally fixes a torn tail; readers must never mutate a journal they don't own.
  static load(dir, { repair = false } = {}) {
    const { entries, repaired } = readJsonlStrict(path.join(dir, 'journal.jsonl'), { repair })
    const state = {
      meta: null,
      results: new Map(),   // key -> result entry (last wins)
      sessions: new Map(),  // key -> provider session id
      usageCum: new Map(),  // key -> last cumulative usage snapshot
      pendingMail: new Map(), // key -> [{id, text, origin, seq?, sender?, callsite?}] accepted but not yet delivered
      // key -> Map(wfMailKey -> count): workflow-origin mail DELIVERED into the
      // provider session (mail-done'd; skipped tombstones and deliver-or-declare
      // drops excluded). The engine
      // hands each re-run agent its map so the re-executing workflow's
      // deterministic re-sends of an already-delivered
      // sender+callsite+text+ordinal are suppressed instead of landing twice
      // in the continued session.
      deliveredWorkflowMail: new Map(),
      // key -> Map(wfMailKey -> count): workflow-origin mail still PENDING
      // (accepted, never delivered). The engine restores it into the re-run
      // agent's queue — the restored copy is authoritative for delivery — and
      // hands the agent this map so a re-executing workflow's matching re-send
      // is absorbed rather than landing alongside the restored copy. Computed
      // below, after mail-done records have cleared what was delivered or dropped.
      restoredWorkflowMail: new Map(),
      // key -> step-result entry with status 'completed' (last wins). A separate
      // map from `results` on purpose: agent keys and step keys come from
      // independent counters and must never satisfy each other's lookups.
      stepResults: new Map(),
      stepStarted: new Map(), // key -> step-start entry (observability; NEVER replayed as success)
      // Every key that ever ACCEPTED steering mail (any origin, delivered or not).
      // Cross-run seeding (src/seed.js) excludes these conservatively: mail is not
      // part of the resume key, so a steered result's shape can differ from what the
      // same call would produce unsteered — key equality alone doesn't cover it.
      mailedKeys: new Set(),
      started: new Map(),   // key -> started entry
      // key -> number of result records seen for it (E9). `results` is last-wins and
      // hides history; this is the attempt count a resumed attempt numbers itself from.
      attemptCounts: new Map(),
      answers: new Map(),   // qid -> value
      indexByKey: new Map(),
      maxIndex: -1,
      end: null,
      repaired,
      // Spend from failed/cancelled attempts: real cost that must survive resume.
      failedUsage: { input: 0, output: 0, cost: 0 },
      // Spend from COMPLETED results, summed here so the engine can seed the run
      // totals at start: replaying it only through the cache-hit path would lose
      // it whenever resumed control flow skips a completed key.
      completedUsage: { input: 0, output: 0, cost: 0 },
    }
    const recordedUsage = new Map() // key -> usage summed over every result record
    const wfMail = new Map() // mail id -> {key, text, seq, sender, callsite} for workflow-origin records (ids are uuids)
    const cumTrack = new Map() // key -> {prev, spent}: chained positive deltas across usage-cum records (zero-reset aware)
    for (const e of entries) {
      switch (e.type) {
        case 'meta': state.meta = e; break
        case 'started':
          state.started.set(e.key, e)
          state.indexByKey.set(e.key, e.index)
          state.maxIndex = Math.max(state.maxIndex, e.index)
          break
        case 'session': state.sessions.set(e.key, e.sessionId); break
        case 'usage-cum': {
          state.usageCum.set(e.key, e.cum)
          const t = cumTrack.get(e.key) ?? { prev: { input: 0, output: 0 }, spent: { input: 0, output: 0 } }
          t.spent.input += Math.max(0, (e.cum?.input ?? 0) - t.prev.input)
          t.spent.output += Math.max(0, (e.cum?.output ?? 0) - t.prev.output)
          t.prev = { input: e.cum?.input ?? 0, output: e.cum?.output ?? 0 }
          cumTrack.set(e.key, t)
          break
        }
        case 'mail': {
          state.mailedKeys.add(e.key)
          if (!state.pendingMail.has(e.key)) state.pendingMail.set(e.key, [])
          // pre-origin journals restore as operator: possible duplicate beats loss
          state.pendingMail.get(e.key).push({ id: e.id, text: e.text, origin: e.origin ?? 'operator', ...(e.seq != null ? { seq: e.seq } : {}), ...(e.sender != null ? { sender: e.sender } : {}), ...(e.callsite != null ? { callsite: e.callsite } : {}) })
          if (e.origin === 'workflow') wfMail.set(e.id, { key: e.key, text: e.text, seq: e.seq, sender: e.sender, callsite: e.callsite })
          break
        }
        case 'mail-done': {
          const q = state.pendingMail.get(e.key)
          if (q) {
            const i = q.findIndex((m) => m.id === e.id)
            if (i !== -1) q.splice(i, 1)
          }
          // a legacy skipped tombstone or a deliver-or-declare drop records a
          // NEVER-delivered send — counting either would suppress a re-send
          // that genuinely still needs to go out (they still clear pendingMail)
          const wf = e.skipped || e.dropped ? null : wfMail.get(e.id)
          if (wf) {
            wfMail.delete(e.id)
            let m = state.deliveredWorkflowMail.get(wf.key)
            if (!m) state.deliveredWorkflowMail.set(wf.key, (m = new Map()))
            const mk = wfMailKey(wf.text, wf.seq, wf.sender, wf.callsite)
            m.set(mk, (m.get(mk) ?? 0) + 1)
          }
          break
        }
        case 'result':
          state.results.set(e.key, e)
          state.attemptCounts.set(e.key, (state.attemptCounts.get(e.key) ?? 0) + 1)
          state.indexByKey.set(e.key, e.index)
          state.maxIndex = Math.max(state.maxIndex, e.index)
          if (e.usage) {
            const agg = e.status === 'completed' ? state.completedUsage : state.failedUsage
            agg.input += e.usage.input ?? 0
            agg.output += e.usage.output ?? 0
            agg.cost += e.usage.cost ?? 0
          }
          if (e.usage) {
            const r = recordedUsage.get(e.key) ?? { input: 0, output: 0 }
            r.input += e.usage.input ?? 0
            r.output += e.usage.output ?? 0
            recordedUsage.set(e.key, r)
          }
          break
        case 'step-start': state.stepStarted.set(e.key, e); break
        case 'step-result':
          // Only completed outcomes are replayable; a failed step re-runs on
          // resume exactly like unfinished work. Keep last-wins so a later
          // successful retry supersedes an earlier failure record.
          if (e.status === 'completed') state.stepResults.set(e.key, e)
          else state.stepResults.delete(e.key)
          break
        case 'answer': state.answers.set(e.qid, e.value); break
        case 'end': state.end = e; break
      }
    }
    // Crash-window spend: usage-cum is journaled per provider report, result
    // records only at attempt end. Tokens reported after the last result record
    // of a crashed attempt would otherwise vanish — the restored baseline
    // suppresses them from future deltas too. The chained cumTrack total (which
    // survives session-change zero-resets and later completions, and is
    // recomputed from the journal on every load, so it is durable) minus what the
    // result records already charged is exactly that window.
    for (const [key, t] of cumTrack) {
      const r = recordedUsage.get(key) ?? { input: 0, output: 0 }
      state.failedUsage.input += Math.max(0, t.spent.input - r.input)
      state.failedUsage.output += Math.max(0, t.spent.output - r.output)
    }
    for (const [key, q] of state.pendingMail) {
      for (const m of q) {
        if (m.origin !== 'workflow') continue
        let r = state.restoredWorkflowMail.get(key)
        if (!r) state.restoredWorkflowMail.set(key, (r = new Map()))
        const mk = wfMailKey(m.text, m.seq, m.sender, m.callsite)
        r.set(mk, (r.get(mk) ?? 0) + 1)
      }
    }
    return state
  }
}
