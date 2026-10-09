import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import type {
  FlowitionCockpitDetail as Detail,
  FlowitionCockpitLane as Lane,
  FlowitionCockpitRun as Run,
  FlowitionCockpitTimeline as Timeline,
  FlowitionCockpitWorker as Worker,
  FlowitionCockpitWorkflowFile as WorkflowFile,
} from '../types'
import type { ButtonFaceProps } from './button'
import type { CardProps } from './card'
import type { Ctx } from './ctx'
import { launchView } from './launch-view'
import { logView } from './log-view'
import { structureView } from './structure-view'
import {
  badgeSvg,
  deepLink,
  extractRunId,
  filterRuns,
  foldRepeats,
  fmtAge,
  fmtCost,
  fmtDuration,
  fmtClock,
  fmtTime,
  fmtTokens,
  groupByDay,
  hasEnded,
  isActive,
  isFlowitionLaunch,
  isLive,
  isTerminal,
  catchUpTimeline,
  emptyTimeline,
  laneSpan,
  laneSvg,
  laneText,
  parseRuns,
  parseFilteredRuns,
  listNoteOf,
  keepRuns,
  readLines,
  RUNS_FILTER_JS,
  RUNS_KEPT,
  STATUS_SLIM_JS,
  lifetimeWorkers,
  reconcileWorkers,
  boundDetails,
  boundTimeline,
  clipDraw,
  clipTail,
  newestWithin,
  firstWithin,
  TAB_BUDGET,
  QUESTIONS_BUDGET,
  DRAW_ITEM,
  THREAD_BUDGET,
  pairToolResults,
  shownState,
  isAbandoned,
  readStatus,
  staleDetailIds,
  parseTranscript,
  appendEvents,
  baselineOf,
  launchIdsIn,
  launchesIn,
  type Invocation,
  boundThread,
  phaseGroups,
  placeholder,
  progress,
  progressSvg,
  runDuration,
  sameDetail,
  sameJson,
  shouldWake,
  sliceLines,
  stateColor,
  statusLine,
  stateTally,
  steerHint,
  timelineWindow,
  titleOf,
  transitions,
  withSeen,
  WORKFLOW_FILE,
} from './lib'

const PANE = 'flo'
const TITLE = 'Flowition'
const TICK_MS = 2500

const runsAtom = atom({ plugin: 'flowition-cockpit', key: 'runs' } as const, [])
const detailsAtom = atom({ plugin: 'flowition-cockpit', key: 'details' } as const, {})
const selectedAtom = atom({ plugin: 'flowition-cockpit', key: 'selected' } as const, null)
const attachedAtom = atom({ plugin: 'flowition-cockpit', key: 'attached' } as const, [])
const errorAtom = atom({ plugin: 'flowition-cockpit', key: 'error' } as const, null)
const wakeAtom = atom({ plugin: 'flowition-cockpit', key: 'wake' } as const, [])
const steeringAtom = atom({ plugin: 'flowition-cockpit', key: 'steering' } as const, null)
const confirmAtom = atom({ plugin: 'flowition-cockpit', key: 'confirm' } as const, null)
const recentLimitAtom = atom({ plugin: 'flowition-cockpit', key: 'recentLimit' } as const, 8)
const agentViewAtom = atom({ plugin: 'flowition-cockpit', key: 'agentView' } as const, null)
const threadAtom = atom({ plugin: 'flowition-cockpit', key: 'thread' } as const, null)
const expandedAtom = atom({ plugin: 'flowition-cockpit', key: 'expanded' } as const, [])
const followAtom = atom({ plugin: 'flowition-cockpit', key: 'follow' } as const, true)
const runTabAtom = atom({ plugin: 'flowition-cockpit', key: 'runTab' } as const, 'agents')
const timelineAtom = atom({ plugin: 'flowition-cockpit', key: 'timeline' } as const, null)
const listFilterAtom = atom({ plugin: 'flowition-cockpit', key: 'listFilter' } as const, 'all')
const listQueryAtom = atom({ plugin: 'flowition-cockpit', key: 'listQuery' } as const, '')
const openGroupsAtom = atom({ plugin: 'flowition-cockpit', key: 'openGroups' } as const, [])
const launchAtom = atom({ plugin: 'flowition-cockpit', key: 'launch' } as const, null)
const workflowsAtom = atom({ plugin: 'flowition-cockpit', key: 'workflows' } as const, [])
const listNoteAtom = atom({ plugin: 'flowition-cockpit', key: 'listNote' } as const, null)

/**
 * States a run may be resumed from: `flowition run <file> --resume` re-enters them. As
 * in the viewer (control-bridge's RESUMABLE_STATES), a completed run is one: resuming it
 * is a Replay, every finished agent replayed from the journal.
 */
const RESUMABLE = new Set(['completed', 'failed', 'interrupted', 'stale'])
const FILTER_LABELS = { all: 'All', live: 'Live', attention: 'Needs attention', completed: 'Completed' } as const

// A transcript is read from where the last read stopped; a first read (or one that
// fell too far behind) takes the newest WINDOW bytes, and the thread keeps MAX_EVENTS.
const WINDOW = 1 << 20
const MAX_EVENTS = 200

// Module state: lost on a hot reload, which only costs one extra `runs --json`.
let bin: string | null = null
let home = ''
let lastListAt = 0
let runsDirMtime = -1
let mustList = true
let isBusy = false
let isAgain = false
let lastStatus: string | undefined
// When a live run on screen was last redrawn for its clock alone (see refresh).
let lastClockDraw = 0
// Set when this session launched a run whose id the tool output did not carry
// (a backgrounded Bash call): the next new run created after it is attached.
// Launches Bash backgrounded (no id in their output yet), by when each began: each is
// matched to its own new run as runs are listed, an unmatched one kept until it expires.
const pendingLaunches: { since: number; known: Set<string>; file: string | null; group: number }[] = []
// The runs a backgrounded command's output named (attached already) that no record has
// been reconciled with yet, by command: once listed, each takes back the record of its
// own workflow file, and until then that command's records match nothing.
// `foreground`: the command's new-run launches it did not background, by file (''
// for a file the shell expands), which named runs account for before any record.
const namedByGroup = new Map<number, { names: Set<string>; foreground: Map<string, number> }>()
// Resumes a command named on its command line: attached only on evidence the resume
// ran (the run turns live having not been, or its events grow), never on syntax alone
// (a branch that did not run, a resume that was refused).
const pendingResumes: { runId: string; since: number; wasLive: boolean; size: number | null }[] = []
// Runs a launch's output may have named (a status JSON line inside a foreground run's
// result): attached only once listed as created since the command began, a new run.
// It must also be one of the command's own launches: a new-run launch of its workflow
// (`candidates`, by file) that the runs the output named (`certain`) do not account for.
const pendingNamed: { runId: string; since: number; known: Set<string>; group: number; candidates: { file: string | null; isRepeated: boolean }[]; certain: string[] }[] = []
let launchGroup = 0
// Each attach (a launch, a resume, a re-attach) takes the next generation; a poll that
// began before a run's generation neither writes nor announces anything for that run,
// so its notices start from the baseline attach() installed.
let attachSeq = 0
const attachedSeqOf = new Map<string, number>()
// Runs whose attach() is still writing its baseline: a poll that begins meanwhile treats
// them as attached after it.
const attaching = new Set<string>()

// The handlers behind the desktop's faces (button.tsx, card.tsx), by the face's key:
// each render sets its own, stamped with the render's number, and a face's click
// (`ui.message` with `{ press }`) runs the newest. Pruned at the end of a render (never
// during one, which would strand faces it already drew), keeping the last two renders'.
const pressHandlers = new Map<string, { fn: () => unknown; render: number; surface: string }>()
// Renders are counted per surface, and a render prunes only its own surface's handlers:
// a terminal redraw never strands the faces a desktop pane still shows.
const renderCounts = new Map<string, number>()
// When each run's status was last read, and its events.jsonl size then: a cached
// terminal detail is read again when the file has grown (a resume ran, here or
// elsewhere) or a minute has passed, so a resume ending in the same state still shows.
const polledAt = new Map<string, number>()
const eventsSizeAt = new Map<string, number>()
const REVALIDATE_MS = 60_000

// Bumped by each message sent: part of the fields' keys, so a sent field draws empty.
let sent = 0

const whoOf = (w: Worker): string => [w.adapter, w.model, w.effort].filter(Boolean).join(' · ') || 'agent'
const dirname = (p: string): string => p.slice(0, Math.max(1, p.lastIndexOf('/')))
const firstLine = (s: string): string => s.trim().split('\n')[0] ?? ''

// ---- the CLI ---------------------------------------------------------------------

/** Where flowition may live: $FLOWITION_BIN, PATH, then the usual global-install dirs. */
async function binCandidates($: EngineInterface): Promise<string[]> {
  const out: string[] = []
  const explicit = await $.env.get('FLOWITION_BIN')
  if (explicit) out.push(explicit)
  out.push('flowition')
  const userHome = (await $.env.get('HOME')) ?? ''
  if (userHome) {
    try {
      const versions = await $.fs.list(`${userHome}/.nvm/versions/node`)
      const names = versions.filter((v) => v.kind === 'dir').map((v) => v.name)
      names.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      for (const name of names) out.push(`${userHome}/.nvm/versions/node/${name}/bin/flowition`)
    } catch {
      // no nvm
    }
    out.push(`${userHome}/.volta/bin/flowition`, `${userHome}/.bun/bin/flowition`, `${userHome}/.local/bin/flowition`)
  }
  out.push('/opt/homebrew/bin/flowition', '/usr/local/bin/flowition')
  return out
}

/** Runs the flowition CLI by argv (no shell, so `flo` the zsh function is never needed). */
async function flo($: EngineInterface, args: string[], timeoutMs = 15_000): Promise<ProcessRunResult> {
  const candidates = bin ? [bin] : await binCandidates($)
  let failure: unknown = new Error('flowition was not found on PATH or in the usual install dirs; set FLOWITION_BIN')
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      try {
        await $.fs.stat(candidate)
      } catch {
        continue
      }
    }
    // A global npm install's shebang is `env node`: put its own bin dir first so that
    // node resolves even when the host's PATH lacks it (nvm, desktop app sessions).
    const env = candidate.includes('/') ? { PATH: `${dirname(candidate)}:${(await $.env.get('PATH')) ?? '/usr/bin:/bin'}` } : undefined
    try {
      const ran = await $.process.run([candidate, ...args], { env, timeoutMs })
      if (ran.exitCode === 127 || /env: .*node.*: No such file/.test(ran.stderr)) {
        failure = new Error(ran.stderr.trim() || `${candidate} could not start`)
        continue
      }
      bin = candidate
      return ran
    } catch (err) {
      failure = err
    }
  }
  bin = null
  throw failure
}

/** The environment a node program (lib's *_JS) runs in after the resolved CLI. */
async function nodeEnv($: EngineInterface, js: string): Promise<Record<string, string>> {
  const env: Record<string, string> = { FLOWITION_COCKPIT_JS: js }
  if (bin?.includes('/')) env.PATH = `${dirname(bin)}:${(await $.env.get('PATH')) ?? '/usr/bin:/bin'}`
  return env
}

// The filtered listing goes to a private temp file whose path and size come back; the
// file is then read in chunks and removed.
const LIST_TO_FILE =
  'f=$(mktemp "${TMPDIR:-/tmp}/flowition-cockpit-runs.XXXXXX") || exit 1; ' +
  'if "$0" runs --json | node -e "$FLOWITION_COCKPIT_JS" "$1" "$2" > "$f"; then printf "%s\\n" "$f"; wc -c < "$f"; else rm -f "$f"; exit 1; fi'

/**
 * Every run, for a history too long for one `runs --json` read (over $.process.run's
 * 4 MiB stdout): every unfinished run, the newest RUNS_KEPT and this session's runs
 * (`attached`, however old), with the full count,
 * however many rows that is. Null when it cannot run: the caller falls back to the
 * newest rows it did read.
 */
async function listLongHistory($: EngineInterface, attached: string[]): Promise<{ runs: Run[]; total: number | null; isComplete: boolean } | null> {
  if (!bin) return null
  let file = ''
  try {
    const made = await $.process.run(['/bin/sh', '-c', LIST_TO_FILE, bin, String(RUNS_KEPT), JSON.stringify(attached)], { env: await nodeEnv($, RUNS_FILTER_JS), timeoutMs: 60_000 })
    const [path, size] = made.stdout.split('\n')
    if (made.exitCode !== 0 || !path?.startsWith('/')) return null
    file = path
    const bytes = Number(size?.trim())
    if (!Number.isSafeInteger(bytes)) return null
    const read = await readLines(file, bytes, (argv) => $.process.run(argv, { timeoutMs: 10_000 }))
    const out = parseFilteredRuns(read.lines)
    return out.total === null ? null : { ...out, isComplete: read.isComplete }
  } catch {
    return null
  } finally {
    if (file) await $.process.run(['rm', '-f', file]).catch(() => undefined)
  }
}

/**
 * A status too large to read whole (a huge completed result) read again without the
 * result's value, so its workers and totals still show. Null when that is not possible.
 */
async function slimStatus($: EngineInterface, runId: string): Promise<ProcessRunResult | null> {
  if (!bin) return null
  try {
    const ran = await $.process.run(['/bin/sh', '-c', '"$0" status "$1" --json | node -e "$FLOWITION_COCKPIT_JS"', bin, runId], { env: await nodeEnv($, STATUS_SLIM_JS), timeoutMs: 30_000 })
    return ran.exitCode === 0 && !ran.isStdoutTruncated ? ran : null
  } catch {
    return null
  }
}

/** A control command (`send`, `answer`, `cancel`): its JSON reply, or why it failed. */
async function control($: EngineInterface, args: string[]): Promise<{ ok: boolean; reply: Record<string, unknown>; error: string | null }> {
  try {
    const ran = await flo($, args)
    let reply: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(ran.stdout)
      if (parsed && typeof parsed === 'object') reply = parsed as Record<string, unknown>
    } catch {
      // not JSON: the error is on stderr
    }
    const ok = ran.exitCode === 0 && reply.ok === true
    const error = ok ? null : typeof reply.error === 'string' ? reply.error : firstLine(ran.stderr) || `exit ${ran.exitCode}`
    return { ok, reply, error }
  } catch (err) {
    return { ok: false, reply: {}, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---- polling ---------------------------------------------------------------------

/** $FLOWITION_HOME, else ~/.flowition: read once, by whichever caller needs it first. */
async function ensureHome($: EngineInterface): Promise<string> {
  if (!home) home = (await $.env.get('FLOWITION_HOME')) ?? `${(await $.env.get('HOME')) ?? ''}/.flowition`
  return home
}

async function refresh($: EngineInterface, force = false): Promise<void> {
  if (isBusy) {
    isAgain ||= force
    return
  }
  isBusy = true
  // The attach generation this whole refresh is of (its listing, polls and writes): a run
  // attached after this point keeps attach()'s baseline and gets no notice from it.
  const pollSeq = attachSeq
  const attachingAtStart = new Set(attaching)
  try {
    await ensureHome($)
    const now = await $.clock.now()
    let list: Run[] = await read($, runsAtom)

    let mtime = runsDirMtime
    try {
      mtime = (await $.fs.stat(`${home}/runs`)).mtimeMs
    } catch {
      // no runs yet
    }
    const isPaneUp = (await $.ui.panes()).some((p) => p.id === PANE)
    const listEvery = list.some((r) => isLive(r.state)) ? 10_000 : isPaneUp ? 15_000 : 60_000
    // A listing that fails keeps the last list and is reported; it never stops the
    // watched runs' polls below (their toasts and wakes).
    let listError: string | null = null
    let listNote: string | null = await read($, listNoteAtom)
    let attached: string[] = await read($, attachedAtom)
    if (mustList || mtime !== runsDirMtime || now - lastListAt >= listEvery) {
      try {
        const ran = await flo($, ['runs', '--json'])
        if (ran.exitCode !== 0) throw new Error(firstLine(ran.stderr) || `flowition runs exited ${ran.exitCode}`)
        let all: Run[]
        let total: number | null
        let isComplete = true
        if (ran.isStdoutTruncated) {
          // Cut short, the listing holds only the newest rows: an older run still live
          // would be missed, so the whole history is filtered down instead.
          const long = await listLongHistory($, attached)
          all = long ? long.runs : parseRuns(ran.stdout)
          total = long ? long.total : null
          isComplete = long?.isComplete ?? false
          // A listing not read whole may lack this session's older runs: their last
          // known rows stay (a complete listing without one means it was deleted).
          if (total === null || !isComplete) {
            const known = await read($, runsAtom)
            const missing = known.filter((r) => attached.includes(r.runId) && !all.some((x) => x.runId === r.runId))
            if (missing.length) all = [...all, ...missing].sort((a, b) => b.createdAt - a.createdAt)
          }
        } else {
          all = parseRuns(ran.stdout)
          total = all.length
        }
        // What the pane keeps of it ($.state holds 4 MiB a value), and says it left out.
        const kept = keepRuns(all, attached)
        list = kept.runs
        listNote = listNoteOf(list.length, total, isComplete && !kept.isCut)
        lastListAt = now
        runsDirMtime = mtime
        mustList = false
      } catch (err) {
        listError = `Listing runs failed: ${err instanceof Error ? err.message : String(err)}`
      }
    }

    // Each backgrounded launch, oldest first, takes the oldest run created since it began
    // that was not listed before it and is not attached, preferring its own workflow file:
    // never a run another session started just before.
    // A doubtful id is a launch only if its run was created since its command began.
    for (let i = 0; i < pendingNamed.length; ) {
      const p = pendingNamed[i] as (typeof pendingNamed)[number]
      const listed = list.find((r) => r.runId === p.runId)
      const certainFiles = p.certain.map((id) => list.find((r) => r.runId === id)?.file)
      // Wait until it and the runs the output named are listed with their workflows.
      if (!listed || listed.file === '?' || certainFiles.some((f) => f === undefined || f === '?')) {
        if (now - p.since > 120_000) pendingNamed.splice(i, 1)
        else i++
        continue
      }
      pendingNamed.splice(i, 1)
      // Listed before the command, or created before it: a run the result refers to.
      if (p.known.has(p.runId) || listed.createdAt < p.since) continue
      // The command's launches its named runs did not account for: one must be this run's.
      // A launch in a loop runs any number of times, so the runs it made never use it up.
      const remaining = [...p.candidates]
      for (const f of certainFiles) {
        const own = remaining.findIndex((c) => c.file === f)
        const at = own >= 0 ? own : remaining.findIndex((c) => c.file === null)
        if (at >= 0 && !remaining[at]?.isRepeated) remaining.splice(at, 1)
      }
      if (!remaining.some((c) => c.file === listed.file || c.file === null)) continue
      // Its launch is accounted for now: a discovery record kept for it goes too.
      const record = pendingLaunches.findIndex((r) => r.group === p.group && r.file === listed.file)
      const loose = record >= 0 ? record : pendingLaunches.findIndex((r) => r.group === p.group && r.file === null)
      if (loose >= 0) pendingLaunches.splice(loose, 1)
      if (!attached.includes(p.runId)) attached = [...attached, p.runId]
      await attach($, p.runId)
    }
    // A resume runs when its run turns live having not been, or its events grow.
    for (let i = 0; i < pendingResumes.length; ) {
      const p = pendingResumes[i] as (typeof pendingResumes)[number]
      const listed = list.find((r) => r.runId === p.runId)
      // Ordinary progress of an attempt already running is no evidence: a new attempt is
      // (the run turning live having not been, or a run-resumed event written since).
      const size = await eventsSize($, p.runId)
      const grown = size !== null && size > (p.size ?? 0) ? await resumedSince($, p.runId, p.size ?? 0, size) : false
      if ((listed && isLive(listed.state) && !p.wasLive) || grown) {
        pendingResumes.splice(i, 1)
        if (!attached.includes(p.runId)) attached = [...attached, p.runId]
        await attach($, p.runId)
      } else if (now - p.since > 120_000) pendingResumes.splice(i, 1)
      else i++
    }
    // First, a command's named runs, once listed, take back their own records.
    // (A run listed before its journal exists reads file '?': it waits until it names its
    // workflow.) A named run first accounts for a foreground launch of its own workflow,
    // and only then takes back a backgrounded one's record.
    for (const [group, { names, foreground }] of namedByGroup) {
      for (const id of [...names]) {
        const run = list.find((r) => r.runId === id)
        if (!run || run.file === '?') continue
        names.delete(id)
        // Exact matches before wildcards: a foreground launch of its file, then a record of
        // its file, then an unknown-file foreground launch, then an unknown-file record.
        const take = (fg: string) => {
          const n = (foreground.get(fg) ?? 1) - 1
          if (n > 0) foreground.set(fg, n)
          else foreground.delete(fg)
        }
        const exactRecord = pendingLaunches.findIndex((p) => p.group === group && p.file === run.file)
        if (foreground.has(run.file)) take(run.file)
        else if (exactRecord >= 0) pendingLaunches.splice(exactRecord, 1)
        else if (foreground.has('')) take('')
        else {
          const loose = pendingLaunches.findIndex((p) => p.group === group && p.file === null)
          if (loose >= 0) pendingLaunches.splice(loose, 1)
        }
      }
      if (!names.size || !pendingLaunches.some((p) => p.group === group)) namedByGroup.delete(group)
    }
    for (let i = 0; i < pendingLaunches.length; ) {
      const { since, known, file, group } = pendingLaunches[i] as (typeof pendingLaunches)[number]
      if (namedByGroup.has(group) && now - since <= 120_000) {
        i++
        continue
      }
      const candidates = [...list].reverse().filter((r) => r.createdAt >= since && !known.has(r.runId) && !attached.includes(r.runId))
      // Its own workflow file when the command named one: never another workflow's run.
      const fresh = file !== null ? candidates.find((r) => r.file === file) : candidates[0]
      if (fresh) {
        pendingLaunches.splice(i, 1)
        attached = [...attached, fresh.runId]
        await attach($, fresh.runId)
      } else if (now - since > 120_000) {
        pendingLaunches.splice(i, 1)
      } else {
        i++
      }
    }

    // Poll the live runs, the ones this session watches, and the one on screen.
    const wake: string[] = await read($, wakeAtom)
    const watched = new Set([...attached, ...wake])
    const selected = await read($, selectedAtom)
    const details: Record<string, Detail> = { ...(await read($, detailsAtom)) }
    const snapshotIds = new Set(Object.keys(details))
    const ids = new Set(list.filter((r) => isLive(r.state)).map((r) => r.runId))
    // A watched run is polled until it ends: a detached launch reads `unknown` until it
    // writes its journal, and is not done.
    for (const id of watched) if (!details[id] || !isTerminal(details[id].state)) ids.add(id)
    // An armed run is polled until a poll reconciles it (finds it ended) and disarms it.
    for (const id of wake) ids.add(id)
    // So is any run whose cached detail the list now contradicts (resumed elsewhere).
    for (const id of staleDetailIds(list, details)) ids.add(id)
    if (selected && (force || !details[selected] || !isTerminal(details[selected].state))) ids.add(selected)
    for (const id of Object.keys(details)) {
      if (ids.has(id) || isLive(details[id]!.state)) continue
      if (now - (polledAt.get(id) ?? 0) >= REVALIDATE_MS || (await eventsSize($, id)) !== eventsSizeAt.get(id)) ids.add(id)
    }

    const toasts: { id: string; text: string }[] = []
    const woken: string[] = []
    const polled = new Set<string>()
    for (const id of ids) {
      // Each run on its own: one status that fails (denied, unstartable, timed out)
      // never holds back the others' updates, toasts and wakes.
      let ran: ProcessRunResult
      try {
        ran = await flo($, ['status', id, '--json'])
      } catch {
        continue
      }
      if (ran.exitCode !== 0) continue
      if (ran.isStdoutTruncated) ran = (await slimStatus($, id)) ?? ran
      polledAt.set(id, now)
      const size = await eventsSize($, id)
      if (size !== null) eventsSizeAt.set(id, size)
      const prev = details[id]
      const next = withSeen(prev, readStatus(ran.stdout, ran.isStdoutTruncated, prev, id, now))
      polled.add(id)
      if (watched.has(id)) toasts.push(...transitions(prev, next).map((text) => ({ id, text })))
      if (hasEnded(prev, next)) mustList = true
      if (shouldWake(prev, next, wake.includes(id))) woken.push(id)
      // An unchanged poll keeps the old object, so nothing is redrawn for it.
      details[id] = prev && sameDetail(prev, next) ? prev : next
    }

    // The list's state lags a poll behind; a detail read in this poll is the truth (a
    // cached one is not: the list may know better, which is why it was re-polled).
    list = list.map((r) => {
      const state = polled.has(r.runId) ? details[r.runId]?.state : undefined
      return state && state !== r.state ? { ...r, state } : r
    })
    // Keep detail only for what the pane or the toasts still need, within what $.state
    // holds: the run on screen and the watched ones first.
    const keep = new Set([...ids, ...watched, ...(selected ? [selected] : [])])
    for (const id of Object.keys(details)) if (!keep.has(id)) delete details[id]
    const kept = boundDetails(details, [...(selected ? [selected] : []), ...watched])

    // Write only what changed: every write redraws the pane, and a redraw landing
    // mid-click can swallow the click on the desktop. A write refused never holds back
    // the toasts and wakes below: they come from this poll, not from the cache.
    let writeError: string | null = null
    const write = async (fn: () => Promise<unknown>) => {
      try {
        await fn()
      } catch (err) {
        writeError = err instanceof Error ? err.message : String(err)
      }
    }
    await write(async () => (sameJson(list, await read($, runsAtom)) ? undefined : update($, runsAtom, () => list)))
    // A run attached (or attached again: a resume) after this refresh began keeps the
    // cache's entry for it (attach()'s baseline), not this poll's, and none of this poll's
    // notices: the next poll sees its change from that baseline. Judged afresh wherever it
    // decides (inside the cache update, retries included, and at each notice and wake),
    // since attach() takes its generation before anything else it does.
    const isLate = (id: string) => (attachedSeqOf.get(id) ?? 0) > pollSeq || attachingAtStart.has(id)
    const withAdded = (cur: Record<string, Detail>) => {
      const added = Object.entries(cur).filter(([id]) => (!snapshotIds.has(id) && !(id in kept)) || isLate(id))
      return added.length ? { ...kept, ...Object.fromEntries(added) } : kept
    }
    await write(async () => {
      const cur = await read($, detailsAtom)
      return sameJson(withAdded(cur), cur) ? undefined : update($, detailsAtom, (latest) => withAdded(latest))
    })
    await write(async () => ((await read($, listNoteAtom)) === listNote ? undefined : update($, listNoteAtom, () => listNote)))
    const shownError = listError ?? writeError
    await write(async () => ((await read($, errorAtom)) === shownError ? undefined : update($, errorAtom, () => shownError)))
    for (const { id, text } of toasts) if (!isLate(id)) $.ui.toast(text, { timeoutMs: 8000 })
    const status = statusLine(list, details)
    if (status !== lastStatus) {
      lastStatus = status
      $.ui.status(status)
    }
    // A live run on screen redraws every few seconds even when nothing it shows changed
    // (polls write only what changed), so its Elapsed keeps time while it waits or works
    // quietly.
    const shownState = selected ? (details[selected]?.state ?? list.find((r) => r.runId === selected)?.state) : undefined
    if (shownState && isLive(shownState) && now - lastClockDraw >= 5_000) {
      lastClockDraw = now
      $.ui.invalidate('ui.render')
    }


    // The opt-in wake: a turn of Claude's own once the session is idle.
    if (woken.length) {
      // Only runs still armed now: one disarmed while this poll's status ran is skipped.
      const armed = await read($, wakeAtom)
      const due = woken.filter((id) => armed.includes(id) && !isLate(id))
      await update($, wakeAtom, (all) => all.filter((id) => !due.includes(id)))
      for (const id of due) {
        if (isLate(id)) {
          // Attached again just now (a resume): the next poll judges its end afresh.
          await update($, wakeAtom, (all) => (all.includes(id) ? all : [...all, id]))
          continue
        }
        const run = list.find((r) => r.runId === id)
        const d = details[id]
        // Not awaited (it resolves only once the session is idle and the turn starts);
        // a prompt refused (dropped, or the call rejected) re-arms the wake.
        void $.prompt
          .submit({
            text: `Flowition run ${id}${run ? ` (${run.file})` : ''} just finished: ${d?.state ?? 'ended'}. Read its result with \`flowition result ${id}\` and give me a short summary.`,
          })
          .then(
            // Taken: this completion's refusals are spent, and a later one starts afresh.
            (r) => (r.drop !== undefined ? rearmWake($, id, r.drop) : void wakeRefusals.delete(id)),
            (err: unknown) => rearmWake($, id, err instanceof Error ? err.message : String(err)),
          )
      }
    }

    // The open thread and the timeline are read last, each on its own: a failed read
    // (a file gone, a command refused) never holds back the toasts and wakes above.
    try {
      await refreshThread($, now)
    } catch {
      // the thread shows what it last read
    }
    try {
      await refreshTimeline($)
    } catch {
      // the tabs show what they last read
    }
  } catch (err) {
    await update($, errorAtom, () => (err instanceof Error ? err.message : String(err)))
  } finally {
    isBusy = false
    if (isAgain) {
      isAgain = false
      void refresh($, true)
    }
  }
}

// events.jsonl is read in chunks well under $.process.run's 4 MiB stdout cap, so no
// read is ever cut short; a large run is caught up over a few polls.
const EVENTS_CHUNK = 2 << 20
// The run whose events.jsonl the last read could not advance (a read refused or
// failing): its tiles say their totals may lean on status for attempts not read.
let timelineFailedFor: string | null = null
const EVENTS_CHUNKS_PER_POLL = 8

/**
 * Folds the selected run's events into its timeline while a tab other than Agents shows:
 * from where the last read stopped, a bounded chunk at a time, so a growing run costs
 * only its growth and a large one is never read (or cached) truncated.
 */
async function refreshTimeline($: EngineInterface): Promise<void> {
  const runId = await read($, selectedAtom)
  if (!runId) return
  const file = `${await ensureHome($)}/runs/${runId}/events.jsonl`
  let size: number
  try {
    size = (await $.fs.stat(file)).size
  } catch {
    return
  }
  const prev = await read($, timelineAtom)
  // A cache of another run, of an older shape, or of a file that since shrank starts over.
  const isUsable = prev !== null && prev.runId === runId && Array.isArray(prev.entries) && typeof prev.consumed === 'number' && prev.consumed <= size
  const from = isUsable ? prev : emptyTimeline(runId)
  if (isUsable && from.consumed === size) return
  let tl: Timeline
  try {
    tl = await catchUpTimeline(from, size, file, (argv) => $.process.run(argv, { timeoutMs: 10_000 }), EVENTS_CHUNK, EVENTS_CHUNKS_PER_POLL)
  } catch (err) {
    timelineFailedFor = runId
    throw err
  }
  timelineFailedFor = tl.consumed < size && tl.consumed === from.consumed ? runId : null
  await update($, timelineAtom, () => boundTimeline(tl))
}

/**
 * Reads what the open agent's transcript gained since the last read: the bytes
 * [consumed, size) through `tail | head`, so a 10 MB transcript costs only its growth.
 */
async function refreshThread($: EngineInterface, now: number): Promise<void> {
  const runId = await read($, selectedAtom)
  const index = await read($, agentViewAtom)
  if (!runId || index === null) return
  const file = `${home}/runs/${runId}/agents/${index}.jsonl`
  let size: number
  try {
    size = (await $.fs.stat(file)).size
  } catch {
    return
  }
  const prev = await read($, threadAtom)
  const isSame = prev !== null && prev.runId === runId && prev.index === index
  if (isSame && size === prev.consumed) return
  let offset = isSame ? prev.consumed : 0
  let events = isSame ? prev.events : []
  let isPartial = isSame ? prev.isPartial : false
  let isAligned = true
  if (size < offset || size - offset > WINDOW) {
    // Rewritten, or too far behind: start over from the newest window.
    offset = Math.max(0, size - WINDOW)
    events = []
    isPartial = offset > 0
    isAligned = offset === 0
  }
  const ran = await $.process.run(['/bin/sh', '-c', 'tail -c +"$1" "$2" | head -c "$3"', 'sh', String(offset + 1), file, String(size - offset)], {
    timeoutMs: 10_000,
  })
  if (ran.exitCode !== 0) return
  const { body, consumed } = sliceLines(ran.stdout, offset, size, isAligned)
  const fresh = parseTranscript(body, (events[events.length - 1]?.seq ?? -1) + 1)
  events = appendEvents(events, fresh)
  if (events.length > MAX_EVENTS) {
    events = events.slice(-MAX_EVENTS)
    isPartial = true
  }
  const bounded = boundThread(events)
  events = bounded.events
  isPartial ||= bounded.isCut
  await update($, threadAtom, () => ({ runId, index, consumed, isPartial, events, fetchedAt: now }))
  if (fresh.length && (await read($, followAtom))) void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
}

// ---- actions ---------------------------------------------------------------------

/** Whether a run's events.jsonl gained a run started/resumed event past byte `from` (up to 1 MiB of it). */
async function resumedSince($: EngineInterface, runId: string, from: number, size: number): Promise<boolean> {
  try {
    const file = `${await ensureHome($)}/runs/${runId}/events.jsonl`
    const ran = await $.process.run(['/bin/sh', '-c', 'tail -c +"$1" "$2" | head -c "$3"', 'sh', String(from + 1), file, String(Math.min(size - from, 1 << 20))], { timeoutMs: 10_000 })
    return ran.stdout.split('\n').some((line) => line.includes('"type":"run"') && /"state":"(resumed|started)"/.test(line))
  } catch {
    return false
  }
}

/** The size of a run's events.jsonl, or null when it cannot be read. */
async function eventsSize($: EngineInterface, runId: string): Promise<number | null> {
  try {
    return (await $.fs.stat(`${await ensureHome($)}/runs/${runId}/events.jsonl`)).size
  } catch {
    return null
  }
}

// Refused wake prompts per run: re-armed (tried again at the next poll) up to
// WAKE_RETRIES times, then the person is told and can ask Claude from the run.
const wakeRefusals = new Map<string, number>()
const WAKE_RETRIES = 3

async function rearmWake($: EngineInterface, runId: string, reason: string): Promise<void> {
  const n = (wakeRefusals.get(runId) ?? 0) + 1
  wakeRefusals.set(runId, n)
  if (n <= WAKE_RETRIES) {
    await update($, wakeAtom, (all) => (all.includes(runId) ? all : [...all, runId]))
    return
  }
  $.ui.toast(`Couldn't tell Claude that ${runId} finished (${reason}). Use Ask Claude… on the run instead.`, { timeoutMs: 10_000 })
}

/** The Refresh button: the run list and everything on screen, now. */
function refreshAll($: EngineInterface): Promise<void> {
  mustList = true
  return refresh($, true)
}

async function attach($: EngineInterface, runId: string): Promise<void> {
  // The generation first, before anything awaited: a poll committing meanwhile sees it,
  // and one beginning before the baseline is written sees the run as attaching.
  attachedSeqOf.set(runId, ++attachSeq)
  attaching.add(runId)
  try {
    await installBaseline($, runId)
  } finally {
    attaching.delete(runId)
  }
}

async function installBaseline($: EngineInterface, runId: string): Promise<void> {
  const now = await $.clock.now()
  // Switching to another run leaves the last one's agent thread and pending prompts, as
  // select() does.
  if ((await read($, selectedAtom)) !== runId) {
    await update($, agentViewAtom, () => null)
    await update($, threadAtom, () => null)
    await update($, expandedAtom, () => [])
    await update($, steeringAtom, () => null)
    await update($, confirmAtom, () => null)
  }
  await update($, attachedAtom, (list) => (list.includes(runId) ? list : [...list, runId]))
  // Its notices start from here: whatever a poll saw of it while it was not watched (its
  // question, its end) was never announced, so the baseline is a fresh placeholder.
  await update($, detailsAtom, (all) => ({ ...all, [runId]: placeholder(runId, now) }))
  await update($, selectedAtom, () => runId)
  mustList = true
}

async function select($: EngineInterface, runId: string | null): Promise<void> {
  await update($, selectedAtom, () => runId)
  await openAgent($, null)
}

/** Opens one agent's thread within the selected run, or (null) goes back to the run. */
async function openAgent($: EngineInterface, index: number | null): Promise<void> {
  await update($, agentViewAtom, () => index)
  await update($, threadAtom, () => null)
  await update($, expandedAtom, () => [])
  await update($, followAtom, () => true)
  await update($, steeringAtom, () => null)
  await update($, confirmAtom, () => null)
  void refresh($, true)
}

/** Opens the run in the live viewer, the token kept off every argv (as flowition does). */
async function openViewer($: EngineInterface, runId: string): Promise<void> {
  let base: string | null = null
  try {
    const ran = await flo($, ['viewer', '--print-url', '--json'])
    if (ran.exitCode === 0) {
      const info: unknown = JSON.parse(ran.stdout)
      if (info && typeof info === 'object' && typeof (info as { url?: unknown }).url === 'string') base = (info as { url: string }).url
    }
  } catch {
    // reported below
  }
  if (!base) {
    $.ui.toast('No flowition viewer is running. Start one with `flowition viewer` (add --control to steer), then press again.', { timeoutMs: 8000 })
    return
  }
  const link = deepLink(base, runId)
  const ran = await $.process.run(['osascript', '-'], { stdin: `open location ${JSON.stringify(link)}` })
  if (ran.exitCode !== 0) $.ui.toast(`Could not open the viewer: ${firstLine(ran.stderr)}`)
}

async function answer($: EngineInterface, runId: string, qid: string, text: string): Promise<void> {
  const value = text.trim()
  if (!value) return
  const res = await control($, ['answer', runId, qid, '--', value])
  if (res.ok) sent += 1
  $.ui.toast(res.ok ? `Answered ${qid}` : `Answer failed: ${res.error}`)
  $.ui.log(`flowition-cockpit: answer ${qid} of ${runId} → ${res.ok ? 'ok' : `failed: ${res.error}`}`)
  void refresh($, true)
}

async function steer($: EngineInterface, runId: string, index: number, label: string, text: string): Promise<void> {
  const message = text.trim()
  if (!message) return
  const res = await control($, ['send', runId, String(index), '--', message])
  const delivery = typeof res.reply.delivery === 'string' ? res.reply.delivery : 'sent'
  $.ui.toast(res.ok ? `${label}: message ${delivery}` : `Steer failed: ${res.error}`)
  $.ui.log(`flowition-cockpit: message to agent ${index} (${label}) of ${runId} → ${res.ok ? delivery : `failed: ${res.error}`}`)
  if (res.ok) {
    sent += 1
    await update($, steeringAtom, () => null)
  }
  void refresh($, true)
}

/** The first of cancel's two presses: arm the confirmation, and say where it is. */
async function askToCancel($: EngineInterface, target: string, label: string): Promise<void> {
  await update($, confirmAtom, () => `cancel:${target}`)
  $.ui.toast(`Press "Yes, cancel" to stop ${label}.`)
}

async function cancel($: EngineInterface, runId: string, index: number | null): Promise<void> {
  await update($, confirmAtom, () => null)
  const what = index === null ? `run ${runId}` : `agent ${index} of ${runId}`
  const res = await control($, index === null ? ['cancel', runId] : ['cancel', runId, '--agent', String(index)])
  $.ui.toast(res.ok ? `Cancelling ${what}` : `Cancel failed: ${res.error}`, { timeoutMs: res.ok ? 4000 : 10_000 })
  // A line in the transcript (not sent to the model): a record of every control used.
  $.ui.log(`flowition-cockpit: cancel ${what} → ${res.ok ? 'ok' : `failed: ${res.error}`}`)
  void refresh($, true)
}

/** Resumes a failed, interrupted or stale run (or replays a completed one), detached, as the viewer does. */
async function resumeRun($: EngineInterface, runId: string, isReplay = false): Promise<void> {
  const verb = isReplay ? 'Replay' : 'Resume'
  await update($, confirmAtom, () => null)
  // The run's workflow file: named by its first event, or (a run that failed before it
  // started, e.g. its module would not load) by its journal's first record, the run's
  // metadata. Only the file is taken from it (the record also holds the run's args).
  // `run --resume --detach` installs the resume handoff marker and restores the run's
  // journaled adapter, cwd and args.
  const firstFile = async (name: string): Promise<string | null> => {
    try {
      const head = await $.process.run(['head', '-n', '1', `${await ensureHome($)}/runs/${runId}/${name}`])
      const first: unknown = JSON.parse(head.stdout)
      const wf = first !== null && typeof first === 'object' ? (first as { workflowFile?: unknown }).workflowFile : undefined
      return typeof wf === 'string' && wf ? wf : null
    } catch {
      return null
    }
  }
  const file = (await firstFile('events.jsonl')) ?? (await firstFile('journal.jsonl'))
  if (!file) {
    $.ui.toast(`Can't ${verb.toLowerCase()} ${runId}: neither its events nor its journal name its workflow file.`, { timeoutMs: 8000 })
    return
  }
  const res = await control($, ['run', file, '--resume', runId, '--detach', '--json'])
  const ok = res.error === null || res.reply.detached === true
  $.ui.toast(ok ? `${isReplay ? 'Replaying' : 'Resuming'} ${runId}` : `${verb} failed: ${res.error}`, { timeoutMs: ok ? 4000 : 10_000 })
  $.ui.log(`flowition-cockpit: ${verb.toLowerCase()} ${runId} → ${ok ? 'started' : `failed: ${res.error}`}`)
  if (ok) await attach($, runId)
  void refresh($, true)
}

/** Moves a run to flowition's trash (`flowition rm`, recoverable for 7 days). */
async function deleteRun($: EngineInterface, runId: string): Promise<void> {
  await update($, confirmAtom, () => null)
  let error: string | null = null
  try {
    const ran = await flo($, ['rm', runId, '--json'])
    if (ran.exitCode !== 0) error = firstLine(ran.stderr) || `exit ${ran.exitCode}`
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  $.ui.toast(error ? `Delete failed: ${error}` : `Moved ${runId} to the trash (recoverable for 7 days)`, { timeoutMs: error ? 10_000 : 5000 })
  $.ui.log(`flowition-cockpit: delete ${runId} → ${error ? `failed: ${error}` : 'moved to trash'}`)
  if (error) return
  await update($, attachedAtom, (all) => all.filter((id) => id !== runId))
  await update($, wakeAtom, (all) => all.filter((id) => id !== runId))
  await select($, null)
  mustList = true
}

/** Puts a question about the run (or one agent) in the prompt box, or asks outright. */
async function askClaude($: EngineInterface, runId: string, file: string | null, state: string, agent: { index: number; label: string } | null): Promise<void> {
  const about = `${agent ? `agent #${agent.index} (${agent.label}) of ` : ''}flowition run ${runId} (${file ? `${file}, ` : ''}${state})`
  let isFilled = false
  try {
    isFilled = (await $.prompt.fill({ text: `About ${about}: `, mode: 'insert' })).isFilled
  } catch {
    isFilled = false
  }
  if (isFilled) $.ui.toast('Finish your question in the prompt box.')
  else void $.prompt.submit({ text: `Look into ${about}: read its status, result and transcripts with the flowition CLI, then tell me how it went and anything that went wrong.` })
}

/** Opens the new-run form with the workflow files under ~/.flowition/workflows, newest first. */
async function openLauncher($: EngineInterface): Promise<void> {
  // The session's folder now (it may have moved since the form last opened), pinned to
  // this form: the form names it, and Start passes it as --cwd, so the run runs there.
  let cwd: string | null = null
  try {
    cwd = (await $.process.run(['pwd'])).stdout.trim() || null
  } catch {
    cwd = null
  }
  await update($, launchAtom, () => ({ file: null, args: '', error: null, query: '', limit: 20, cwd }))
  const found: WorkflowFile[] = []
  const root = `${await ensureHome($)}/workflows`
  try {
    for (const dir of await $.fs.list(root)) {
      if (dir.kind === 'file' && WORKFLOW_FILE.test(dir.name)) found.push({ path: `${root}/${dir.name}`, project: '~', name: dir.name, mtimeMs: dir.mtimeMs })
      if (dir.kind !== 'dir') continue
      try {
        for (const f of await $.fs.list(`${root}/${dir.name}`)) {
          if (f.kind === 'file' && WORKFLOW_FILE.test(f.name)) found.push({ path: `${root}/${dir.name}/${f.name}`, project: dir.name, name: f.name, mtimeMs: f.mtimeMs })
        }
      } catch {
        // an unreadable project folder is skipped
      }
    }
  } catch {
    // no workflows folder yet: the form says so
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs)
  await update($, workflowsAtom, () => found)
}

/** Starts the chosen workflow, detached, and opens its run. */
// A launch in flight: claimed before anything is awaited, so a second press (a double
// click, Enter again) while the CLI starts the run is turned away, never a second run.
let isLaunching = false

async function startRun($: EngineInterface): Promise<void> {
  if (isLaunching) return
  isLaunching = true
  try {
    await launchOnce($)
  } finally {
    isLaunching = false
    await update($, launchAtom, (l) => (l?.isStarting ? { ...l, isStarting: false } : l))
  }
}

async function launchOnce($: EngineInterface): Promise<void> {
  const launch = await read($, launchAtom)
  if (!launch?.file) return
  const args = launch.args.trim()
  if (args) {
    try {
      JSON.parse(args)
    } catch {
      await update($, launchAtom, (l) => (l ? { ...l, error: 'Args must be JSON, e.g. {"topic": "..."}', failures: (l.failures ?? 0) + 1 } : l))
      return
    }
  }
  await update($, launchAtom, (l) => (l ? { ...l, isStarting: true, error: null } : l))
  const ran = await flo($, ['run', launch.file, ...(args ? ['--args', args] : []), ...(launch.cwd ? ['--cwd', launch.cwd] : []), '--detach', '--json'], 30_000).catch((err: unknown) => ({
    exitCode: 1,
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
  }))
  const runId = ran.exitCode === 0 ? extractRunId(ran.stdout) : null
  if (!runId) {
    await update($, launchAtom, (l) => (l ? { ...l, error: firstLine(ran.stderr) || 'flowition did not start the run', failures: (l.failures ?? 0) + 1 } : l))
    return
  }
  $.ui.log(`flowition-cockpit: started ${runId} (${launch.file})`)
  await update($, launchAtom, () => null)
  await attach($, runId)
  void refresh($, true)
}

// ---- the hooks -------------------------------------------------------------------

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    home = ''
    await ensureHome($)
    // A reload may bring new shapes for what $.state still holds from the old module:
    // drop every cache the polls rebuild (details, timeline, thread, workflow files) —
    // except each watched run's notice baseline (its state and question identities), so
    // a run that ended or asked during the reload is still announced, once.
    const watchedIds = new Set([...(await read($, attachedAtom)), ...(await read($, wakeAtom))])
    await update($, detailsAtom, (all) =>
      Object.fromEntries(
        Object.entries(all as Record<string, unknown>)
          .filter(([id]) => watchedIds.has(id))
          .map(([id, cached]) => [id, baselineOf(cached)] as const)
          .filter((e): e is [string, Detail] => e[1] !== null),
      ),
    )
    await update($, timelineAtom, () => null)
    await update($, workflowsAtom, () => [])
    await update($, threadAtom, () => null)
    await update($, steeringAtom, () => null)
    await update($, confirmAtom, () => null)
    await update($, recentLimitAtom, () => 8)
    await update($, launchAtom, () => null)
    await $.command.register({
      name: 'flo',
      description: 'Show flowition runs in a pane (optionally: /flo <runId>)',
      argumentHint: '[runId]',
    })
    $.clock.every(TICK_MS, () => {
      void refresh($)
    })
    void refresh($, true)
    // A reload replaces the module under an open pane: draw it again once this one is
    // set up, so a draw that failed mid-swap does not leave it blank until data changes.
    $.clock.after(400, () => $.ui.invalidate('ui.render'))
    return started
  })

  on('command.run', { command: 'flo' }, async ($, e) => {
    const runId = e.args.trim()
    await select($, runId || (await read($, selectedAtom)))
    await $.ui.open({ id: PANE, title: TITLE })
    void refresh($, true)
    return {}
  })

  // Auto-attach: a run this session launches opens in the pane and toasts when it
  // asks a question or ends.
  on('tool.call', async ($, e, next) => {
    const isBash = e.tool === 'Bash'
    const isLaunch = isBash ? isFlowitionLaunch(e.command) : /flowition_(run|resume)$/.test(String(e.tool))
    if (!isLaunch) return next(e)
    // The runs listed before the command starts: a poll may list the launched run while
    // the command is still running, and it must stay eligible for its launch. And, for each
    // resume the command names, where that run stood: what a resume would change.
    const before = await read($, runsAtom)
    const known = new Set(before.map((r) => r.runId))
    const launches: Invocation[] = isBash ? launchesIn(e.command).invocations : [{ file: null, target: null, isBackground: false, isRepeated: false }]
    const resumeIds = [...new Set(launches.map((l) => l.target).filter((id): id is string => id !== null))]
    // Read fresh, just before the command: a cached listing may be behind (another
    // session resumed it meanwhile). A state that cannot be read counts as live, so it is
    // no evidence; the events boundary still is.
    const freshState = async (runId: string): Promise<string> => {
      try {
        const ran = await flo($, ['status', runId, '--json'])
        return ran.exitCode === 0 ? readStatus(ran.stdout, ran.isStdoutTruncated, undefined, runId, 0).state : 'running'
      } catch {
        return 'running'
      }
    }
    const resumeFrom = await Promise.all(resumeIds.map(async (runId) => ({ runId, wasLive: isLive(await freshState(runId)), size: await eventsSize($, runId) })))
    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    // Bash's own record: its whole stdout (the model may read only a preview of a large
    // one) and whether the command went to the background (explicitly, on timeout, Ctrl+B).
    const record = isBash && ran.result !== null && typeof ran.result === 'object' ? (ran.result as { stdout?: unknown; backgroundTaskId?: unknown }) : {}
    const output = [typeof record.stdout === 'string' ? record.stdout : '', ran.text ?? ''].join('\n')
    const isBackgrounded = typeof record.backgroundTaskId === 'string' || /running in background|moved to the background|manually backgrounded/i.test(ran.text ?? '')
    // Every run the output names, however many (a loop launches more runs than the
    // command text shows); the output's own lines are the evidence they ran.
    const { ids: named, doubtful } = launchIdsIn(output)
    for (const runId of named) await attach($, runId)
    // A failing exit does not mean nothing ran (a workflow that fails exits 1 after its
    // outcome): doubtful ids and resumes are judged on their own evidence either way.
    const group = ++launchGroup
    const fresh = launches.filter((l) => l.target === null)
    const certain = named.filter((id) => !resumeIds.includes(id))
    for (const runId of doubtful) if (!resumeIds.includes(runId)) pendingNamed.push({ runId, since: startedAt - 1000, known, group, candidates: fresh.map((l) => ({ file: l.file, isRepeated: l.isRepeated })), certain })
    // A resume the output did not name waits for evidence it ran.
    const targets = isBash ? resumeIds : []
    for (const r of resumeFrom) if (isBash && !named.includes(r.runId)) pendingResumes.push({ ...r, since: startedAt - 1000 })
    // New runs whose ids the output does not carry (launches Bash backgrounded report none
    // until they end) arm the fallback, one record each.
    // Which new run each launch made is not known from the output (ids carry no file), so
    // every new-run launch Bash or the shell (`… &`) backgrounded keeps a record; the runs
    // the output named are attached already, which discovery skips, and a record nothing
    // matches expires.
    // A failing exit does not mean a backgrounded launch did not run (`… & wait` on a
    // workflow that fails, a later command in the list failing): the records are kept
    // either way, and each takes only a new run of its own workflow.
    if (isBash) {
      const unnamed = fresh.filter((l) => isBackgrounded || l.isBackground)
      const namedNew = named.filter((id) => !targets.includes(id))
      for (const l of unnamed) pendingLaunches.push({ since: startedAt - 1000, known, file: l.file, group })
      if (unnamed.length && namedNew.length) {
        const foreground = new Map<string, number>()
        for (const l of fresh) if (!(isBackgrounded || l.isBackground)) foreground.set(l.file ?? '', (foreground.get(l.file ?? '') ?? 0) + 1)
        namedByGroup.set(group, { names: new Set(namedNew), foreground })
      }
    }
    void $.ui.open({ id: PANE, title: TITLE })
    return ran
  }).catch(($, e, next) => next(e))

  // A face was clicked (button.tsx, card.tsx): run the handler its render registered.
  on('ui.message', async ($, e) => {
    const data = e.data !== null && typeof e.data === 'object' ? (e.data as { press?: unknown }) : {}
    if (data.press === true) await pressHandlers.get(`${e.surface}:${e.element}`)?.fn()
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const render = (renderCounts.get(e.surface) ?? 0) + 1
    renderCounts.set(e.surface, render)
    try {
      const els = $.ui.resolve(e)
      const { Box, Text, Button, Markdown, Code } = els
      // What a surface draws, by its declared element table: the engine completes every
      // table with stand-ins, so a name being present does not mean it draws (the terminal
      // draws no Svg, so it gets the text badges and bars; mobile draws no Input).
      const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : null
      const Input = e.surface !== 'mobile' && 'Input' in els ? els.Input : null
      // On the desktop, controls are Client faces that press on the first click (its
      // native Button takes a first click as focus alone); elsewhere native Buttons,
      // which the keyboard walks (Tab, arrows) where a Client takes keys only once clicked.
      const Client = e.surface === 'desktop' && 'Client' in els ? els.Client : null
      // A card face the whole of which is clickable (card.tsx), or the fallback: a
      // plain Button on the title.
      // The region is as wide as its box, and the box shrinks (a Client alone sizes to
      // what it draws, so a long title would push the badge out of the card).
      const face = (key: string, props: CardProps, onPress: () => unknown, fallback: () => ReturnType<typeof Box>) => {
        if (!Client) return fallback()
        pressHandlers.set(`${e.surface}:${key}`, { fn: onPress, render, surface: e.surface })
        return (
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Client key={key} module="./card.tsx" props={props} width="100%" />
          </Box>
        )
      }
      // `fill`: the face takes its box's width and truncates there, for a label in a
      // column (a Client alone is as wide as what it draws, and would spill out).
      const btn = (key: string, label: string, onPress: () => unknown, variant: ButtonFaceProps['variant'] = 'secondary', fill = false) => {
        if (Client) {
          pressHandlers.set(`${e.surface}:${key}`, { fn: onPress, render, surface: e.surface })
          return fill ? (
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Client key={key} module="./button.tsx" props={{ label, variant }} width="100%" />
            </Box>
          ) : (
            <Client key={key} module="./button.tsx" props={{ label, variant }} />
          )
        }
        return (
          <Button
            key={key}
            label={label}
            onPress={() => void onPress()}
            {...(variant === 'plain' ? { plain: true as const } : variant === 'primary' ? { variant: 'primary' as const } : {})}
          />
        )
      }

      // One round of reads, not eleven in a row: each is a trip across to the host.
      const [runs, details, selected, attached, error, wake, steering, confirm, recentLimit, agentView, now, listNote] = await Promise.all([
        read($, runsAtom),
        read($, detailsAtom),
        read($, selectedAtom),
        read($, attachedAtom),
        read($, errorAtom),
        read($, wakeAtom),
        read($, steeringAtom),
        read($, confirmAtom),
        read($, recentLimitAtom),
        read($, agentViewAtom),
        $.clock.now(),
        read($, listNoteAtom),
      ])

      const badge = (state: string) => {
        if (Svg) {
          const b = badgeSvg(state)
          return <Svg source={b.source} alt={state} width={b.width} height={b.height} />
        }
        return <Text color={stateColor(state)}>● {state}</Text>
      }

      const c: Ctx = { Box, Text, Markdown, Code, Svg, Input, btn, face, badge: (state: string) => badge(state), now }

      const errorBanner = error ? (
        <Box borderStyle="round" borderColor="error" paddingX={1}>
          <Text color="error" wrap="wrap">
            {clipDraw(error, 2_000)}
          </Text>
        </Box>
      ) : null

      // ---- one agent's thread: its transcript, live, with a composer under it ----
      if (selected && agentView !== null) {
        const [thread, expanded, follow, timeline] = await Promise.all([read($, threadAtom), read($, expandedAtom), read($, followAtom), read($, timelineAtom)])
        const d: Detail | undefined = details[selected]
        const th = thread && thread.runId === selected && thread.index === agentView ? thread : null
        const live = isLive(d?.state ?? 'unknown')
        // As the run's Agents tab shows it: spend over every attempt, and work an ended
        // run abandoned as interrupted.
        const lanes = timeline && timeline.runId === selected && Array.isArray(timeline.lanes) ? timeline.lanes : []
        const known = d?.isPartial ? reconcileWorkers(d.workers, lanes) : (d?.workers ?? [])
        const raw = known.filter((x) => x.kind === 'agent' && x.index === agentView)
        const attemptAt = timeline && timeline.runId === selected ? timeline.attemptAt : null
        const w = lifetimeWorkers(raw, lanes).map((x) => ({ ...x, state: isAbandoned(x, d, lanes, attemptAt) ? 'interrupted' : shownState(x.state, live) }))[0]
        const canControl = live && w !== undefined && isActive(w.state)
        const label = w?.label ?? `agent ${agentView}`
        const wid = `${selected}:${agentView}`
        const events = th?.events ?? []
        const { byCall: results, paired, attemptFrom } = pairToolResults(events)
        // What a row draws, roughly, for the window below: the newest rows within the
        // thread's budget, so the newest reply and the controls after it always draw.
        const drawn = (ev: (typeof events)[number]): number => {
          const isOpen = expanded.includes(`ev:${ev.seq}`)
          const cap = (s: string | null | undefined, n = DRAW_ITEM) => Math.min((s ?? '').length, n)
          if (ev.kind === 'tool') return 200 + cap(ev.summary, 300) + (isOpen ? cap(ev.input) + cap(results.get(ev.seq)?.output) : 0)
          if (ev.kind === 'reasoning') return 80 + cap(ev.text, isOpen ? DRAW_ITEM : 280)
          return 120 + cap(ev.text)
        }
        const { shown: windowed, hidden } = newestWithin(events, drawn, THREAD_BUDGET)
        const prompt = events.find((x) => x.kind === 'meta')?.text ?? null
        const toggle = (key: string) => update($, expandedAtom, (all) => (all.includes(key) ? all.filter((k) => k !== key) : [...all, key]))
        const facts = w
          ? [
              [w.adapter, w.model, w.effort].filter(Boolean).join(' · '),
              w.durationMs !== null ? fmtDuration(w.durationMs) : null,
              w.outputTokens ? `${fmtTokens(w.outputTokens)} tokens out` : null,
              w.cost ? fmtCost(w.cost) : null,
            ].filter(Boolean)
          : []

        const row = (ev: (typeof events)[number]) => {
          const key = `ev:${ev.seq}`
          const isOpen = expanded.includes(key)
          switch (ev.kind) {
            case 'meta':
              return ev.seq === events[0]?.seq ? null : (
                <Text bold dimColor>
                  — new attempt —
                </Text>
              )
            case 'attempt':
              return (
                <Text bold>
                  Attempt {ev.attempt ?? '?'}
                </Text>
              )
            case 'text':
              return (
                <Box key={key} flexDirection="column">
                  <Markdown key={`md:${ev.seq}`} text={clipTail(ev.text ?? '')} />
                </Box>
              )
            case 'reasoning': {
              // The visible part of an episode shows even when part of it was withheld.
              const text = ev.text ? (ev.redacted ? `${ev.text} (part of this was withheld by the provider)` : ev.text) : 'Thought privately (the provider withheld the text).'
              const isLong = text.length > 280
              return (
                <Box key={key} flexDirection="column">
                  <Text dimColor italic wrap="wrap">
                    {isLong && !isOpen ? `${text.slice(0, 280)}…` : clipDraw(text)}
                  </Text>
                  {isLong ? btn(`more:${ev.seq}`, isOpen ? 'less' : 'more', () => toggle(key), 'plain') : null}
                </Box>
              )
            }
            case 'tool': {
              const result = results.get(ev.seq)
              const outcome = result
                ? result.isError
                  ? `error · ${(result.output ?? '').split('\n')[0]?.slice(0, 120) ?? ''}`
                  : result.output
                    ? `${result.output.split('\n').length} lines`
                    : 'done'
                : ev.seq < attemptFrom
                  ? 'interrupted: its attempt ended first'
                  : live && isActive(w?.state ?? '')
                    ? 'running…'
                    : ''
              return (
                <Box key={key} flexDirection="column">
                  {btn(`tool:${ev.seq}`, `${isOpen ? '▾' : '▸'} ${ev.name ?? 'tool'}  ${ev.summary ?? ''}`, () => toggle(key), 'plain', true)}
                  {outcome ? (
                    <Text color={result?.isError ? 'error' : 'inactive'} wrap="truncate-end">
                      {'   '}
                      {outcome}
                    </Text>
                  ) : null}
                  {isOpen ? (
                    <Box key={`io:${ev.seq}`} flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
                      {ev.input ? <Code source={clipDraw(ev.input)} language="json" wrap="wrap" /> : null}
                      {result?.output ? <Code source={clipDraw(result.output)} wrap="wrap" /> : null}
                    </Box>
                  ) : null}
                </Box>
              )
            }
            case 'tool-result':
              return paired.has(ev.seq) ? null : (
                <Text color={ev.isError ? 'error' : 'inactive'} wrap="truncate-end">
                  {'   '}
                  {ev.isError ? 'error' : 'result'} · {(ev.output ?? '').split('\n')[0]}
                </Text>
              )
            case 'mail-in':
              return (
                <Box key={key} borderStyle="round" borderColor="suggestion" paddingX={1} flexDirection="column">
                  <Text color="suggestion" bold>
                    You → {label} · {fmtClock(ev.t)}
                  </Text>
                  <Text wrap="wrap">{clipDraw(ev.text ?? '')}</Text>
                </Box>
              )
            case 'mail-out':
              return (
                <Box key={key} borderStyle="round" borderColor="success" paddingX={1} flexDirection="column">
                  <Text color="success" bold>
                    {label} → you · {fmtClock(ev.t)}
                  </Text>
                  <Text wrap="wrap">{clipDraw(ev.text ?? '')}</Text>
                </Box>
              )
            case 'status':
              return (
                <Text dimColor wrap="wrap">
                  · {clipDraw(ev.text ?? '', 2_000)}
                </Text>
              )
            default:
              return null
          }
        }

        return (
          <Box flexDirection="column" gap={1} width="100%">
            <Box key="header" flexDirection="column">
              <Box gap={1} alignItems="center" flexWrap="wrap">
                {btn('back-run', '‹ Run', () => openAgent($, null))}
                <Text bold>
                  #{agentView} {label}
                </Text>
                {w ? <Box flexShrink={0}>{badge(w.state)}</Box> : null}
              </Box>
              <Text dimColor wrap="truncate-end">
                {facts.join(' · ') || selected}
              </Text>
            </Box>
            {errorBanner}
            {th === null ? <Text dimColor>Loading the transcript…</Text> : null}
            {th?.isPartial ? <Text dimColor>Showing the newest {events.length} events; the viewer has the full transcript.</Text> : null}
            {prompt ? (
              <Box key="prompt" borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
                <Box justifyContent="space-between">
                  <Text dimColor bold>
                    Task
                  </Text>
                  {prompt.length > 400 ? btn('prompt-more', expanded.includes('prompt') ? 'less' : 'more', () => toggle('prompt'), 'plain') : null}
                </Box>
                <Text wrap="wrap">{prompt.length > 400 && !expanded.includes('prompt') ? `${prompt.slice(0, 400)}…` : clipDraw(prompt)}</Text>
              </Box>
            ) : null}
            {hidden ? (
              <Text key="hidden" dimColor wrap="wrap">
                {hidden} earlier {hidden === 1 ? 'event is' : 'events are'} not drawn here (a pane draws so much text); the viewer has the whole thread.
              </Text>
            ) : null}
            <Box key="events" flexDirection="column" gap={1}>
              {windowed.map(row)}
            </Box>
            {canControl && Input ? (
              <Box key="composer" borderStyle="round" borderColor="suggestion" paddingX={1} flexDirection="column">
                <Input key={`composer:${wid}:${sent}`} placeholder={`Message ${label}…`} submitLabel="Send" onSubmit={(text) => steer($, selected, agentView, label, text)} />
                <Text dimColor wrap="wrap">
                  {steerHint(w?.adapter ?? null)}
                </Text>
              </Box>
            ) : null}
            <Box key="footer" gap={1} alignItems="center" flexWrap="wrap">
              {btn('follow', follow ? 'Following ✓' : 'Follow', () => update($, followAtom, (f) => !f))}
              {btn('ask-agent', 'Ask Claude…', () =>
                askClaude($, selected, runs.find((r) => r.runId === selected)?.file ?? null, d?.state ?? 'unknown', { index: agentView, label }),
              )}
              {canControl && confirm === `cancel:${wid}` ? (
                <>
                  <Text color="error">Stop {label} now?</Text>
                  {btn('cancel-agent-yes', 'Yes, cancel', () => cancel($, selected, agentView), 'primary')}
                  {btn('cancel-agent-no', 'Keep running', () => update($, confirmAtom, () => null))}
                </>
              ) : canControl ? (
                btn('cancel-agent', 'Cancel agent…', () => askToCancel($, wid, label), 'danger')
              ) : null}
              {btn('refresh', 'Refresh', () => refreshAll($))}
              {th ? <Text dimColor>updated {fmtAge(now, th.fetchedAt)}</Text> : null}
            </Box>
          </Box>
        )
      }

      // ---- one run ----
      if (selected) {
        const [runTab, timeline] = await Promise.all([read($, runTabAtom), read($, timelineAtom)])
        const d: Detail | undefined = details[selected]
        const run = runs.find((r) => r.runId === selected)
        const state = d?.state ?? run?.state ?? 'unknown'
        const live = isLive(state)
        // Each worker's spend over all its attempts, from the run's events, where read. A
        // run with no status read whole shows the workers its events name.
        const lanes = timeline && timeline.runId === selected && Array.isArray(timeline.lanes) ? timeline.lanes : []
        const known = d?.isPartial ? reconcileWorkers(d.workers, lanes) : (d?.workers ?? [])
        // A worker shows as it is now: abandoned work (an ended run's, or an earlier attempt's
        // a resume has not taken up again) as interrupted, which also takes its controls away.
        const attemptAt = timeline && timeline.runId === selected ? timeline.attemptAt : null
        const workers = lifetimeWorkers(known, lanes).map((w) => ({ ...w, state: isAbandoned(w, d, lanes, attemptAt) ? 'interrupted' : shownState(w.state, live) }))
        const runCost = workers.reduce((sum, w) => sum + (w.cost ?? 0), 0)
        const agents = workers.filter((w) => w.kind === 'agent')
        const counts = progress(workers)
        const done = counts.find((c) => c.tone === 'success')?.count ?? 0
        const took = runDuration(run, d, now, timeline)
        const isWoken = wake.includes(selected)

        const tile = (key: string, label: string, value: string) => (
          <Box key={`t:${key}`} borderStyle="round" borderDimColor paddingX={1} flexDirection="column" flexGrow={1} minWidth={14}>
            <Text dimColor>{label}</Text>
            <Text bold>{value}</Text>
          </Box>
        )

        // A tab switch is a redraw: it fetches only what the tab lacks (the timeline,
        // once per run), never the whole list, so taps stay quick.
        const setTab = async (tab: 'agents' | 'timeline' | 'phases' | 'log' | 'structure') => {
          await update($, runTabAtom, () => tab)
          if (tab !== 'agents' && !tl) void refreshTimeline($)
        }
        // A timeline cached by an older version of this module (no `entries`) reads as none
      // until the next poll replaces it.
      const read_ = timeline && timeline.runId === selected && Array.isArray(timeline.entries) ? timeline : null
      // Lanes as they are now: an ended run's unfinished work, and work a resumed run has not
      // taken up again (its attempt began before the latest start, or the engine does not
      // run it), is interrupted and stops at its last sign of life.
      const isStale = (l: Lane) =>
        isActive(l.state) &&
        (!live ||
          (read_?.attemptAt != null && (l.startedAt ?? l.queuedAt ?? Infinity) < read_.attemptAt) ||
          (l.state === 'running' && l.index !== null && d?.liveAgents !== undefined && !d.liveAgents.includes(l.index)))
      const shownLanes = (read_?.lanes ?? []).map((l) => (isStale(l) ? { ...l, state: 'interrupted', endedAt: l.endedAt ?? l.lastSeenAt } : l))
      // The lanes a tab draws: the first within what a pane draws, room left for controls.
      const laneCut = firstWithin(shownLanes, (l) => l.label.length + 120, TAB_BUDGET)
      const tl = read_ ? { ...read_, lanes: laneCut.shown } : read_
      const cardCut = firstWithin(workers, (w) => w.label.length + (w.error ? Math.min(w.error.length, 300) : 0) + 160, TAB_BUDGET)
      // The question cards within their own budget, the ones open to an answer first.
      const qCut = firstWithin([...(d?.questions ?? [])].sort((a, b) => Number(b.isOpen) - Number(a.isOpen)), (q) => q.question.length + 240, QUESTIONS_BUDGET)
      const qHidden = qCut.hidden ? (d?.questions ?? []).filter((q) => !qCut.shown.includes(q)).map((q) => q.qid) : []
        // The label of a lane or phase row: an agent's opens its thread.
        const workerLabel = (key: string, kind: 'agent' | 'step', index: number | null, label: string) =>
          kind === 'agent' && index !== null ? btn(key, `#${index}  ${label}`, () => openAgent($, index), 'plain', true) : <Text wrap="truncate-end">⚙ {label}</Text>

        const timelineView = () => {
          if (!tl) return <Text dimColor>Loading the timeline…</Text>
          if (!tl.lanes.length) return <Text dimColor>No agents have started yet.</Text>
          const { start, end } = timelineWindow(tl, now, live)
          const cells = Math.max(10, Math.floor(e.props.bodyColumns * 0.62) - 10)
          return (
            <Box key="timeline" flexDirection="column">
              <Box key="axis">
                <Box width="30%" minWidth={14} />
                <Box flexGrow={1} justifyContent="space-between">
                  <Text dimColor>0s</Text>
                  <Text dimColor>{fmtDuration((end - start) / 2)}</Text>
                  <Text dimColor>{fmtDuration(end - start)}</Text>
                </Box>
                <Box minWidth={9} />
              </Box>
              {tl.lanes.map((lane) => {
                const span = laneSpan(lane, now, live)
                const took = span.from !== null && span.to !== null ? fmtDuration(span.to - span.from) : lane.state
                const bar = laneText(lane, start, end, cells, now, live)
                return (
                  <Box key={`lane:${lane.id}`} alignItems="center">
                    <Box width="30%" minWidth={14} flexShrink={0} gap={1} overflow="hidden" paddingRight={1}>
                      <Text color={stateColor(lane.state)}>●</Text>
                      {workerLabel(`lane:${lane.id}:open`, lane.kind, lane.index, lane.label)}
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      {Svg ? (
                        <Svg source={laneSvg(lane, start, end, now, live)} alt={`${lane.label}: ${lane.state}, ${took}`} height={12} />
                      ) : (
                        <Text>
                          {bar.lead}
                          <Text dimColor>{bar.wait}</Text>
                          <Text color={stateColor(lane.state)}>{bar.run}</Text>
                        </Text>
                      )}
                    </Box>
                    <Box minWidth={9} justifyContent="flex-end">
                      <Text dimColor>{took}</Text>
                    </Box>
                  </Box>
                )
              })}
              <Text dimColor wrap="wrap">
                {Svg ? 'Hatched: waiting for a slot. Solid: running.' : '░ waiting for a slot · █ running'}
                {live ? ' The chart grows while the run is live.' : ''}
              </Text>
            </Box>
          )
        }

        const phasesView = () => {
          // Each phase's span and spend come from every lane read; only the rows drawn are cut.
          const groups = phaseGroups(read_ ? { ...read_, lanes: shownLanes } : read_, workers, d?.phases ?? [], state)
          if (!groups.length) return <Text dimColor>{tl ? 'No agents or phases yet.' : 'Loading the phases…'}</Text>
          // Each phase (its header, then its rows) within what is left of the tab's budget,
          // in order, so the run's controls below always draw; what is left out is counted.
          // The headers come first, so every phase drawn is named; rows fill what is left.
          let room = TAB_BUDGET
          let drawnGroups = 0
          for (const g of groups) {
            const n = Math.min(g.title.length, 200) + 120
            if (n > room) break
            room -= n
            drawnGroups++
          }
          const rowsOf = (list: Worker[]) => {
            const shown: Worker[] = []
            for (const w of list) {
              const n = w.label.length + 80
              if (n > room) break
              room -= n
              shown.push(w)
            }
            return shown
          }
          return (
            <Box key="phases" flexDirection="column" gap={1}>
              {groups.slice(0, drawnGroups).map((g) => {
                const took = g.startedAt !== null ? fmtDuration((g.endedAt ?? (live ? now : g.startedAt)) - g.startedAt) : null
                const facts = [
                  g.workers.length ? `${g.workers.length} ${g.workers.length === 1 ? 'agent' : 'agents'}` : null,
                  took,
                  g.cost ? fmtCost(g.cost) : null,
                ].filter(Boolean)
                const badgeState = g.state === 'pending' ? (live ? 'not reached' : 'never reached') : g.state
                const rows = rowsOf(g.workers)
                return (
                  <Box
                    key={`phase:${g.index ?? 'none'}`}
                    borderStyle="round"
                    {...(g.state === 'running' ? { borderColor: 'suggestion' as const } : { borderDimColor: true })}
                    paddingX={1}
                    flexDirection="column"
                  >
                    <Box justifyContent="space-between" alignItems="center" gap={1}>
                      <Box gap={1} alignItems="center" flexShrink={1}>
                        <Text bold {...(g.isReached ? {} : { dimColor: true })} wrap="truncate-end">
                          {g.index !== null ? `${g.index + 1}. ` : ''}
                          {clipDraw(g.title, 200)}
                        </Text>
                        <Box flexShrink={0}>{badge(badgeState)}</Box>
                      </Box>
                      <Text dimColor>{facts.join(' · ')}</Text>
                    </Box>
                    {rows.map((w) => (
                      <Box key={`pw:${w.id}`} justifyContent="space-between" gap={1}>
                        <Box gap={1} flexShrink={1} flexGrow={1} minWidth={0} overflow="hidden">
                          <Text color={stateColor(w.state)}>●</Text>
                          {workerLabel(`phase:${w.id}:open`, w.kind, w.index, w.label)}
                        </Box>
                        <Text dimColor>{[w.state, w.durationMs !== null ? fmtDuration(w.durationMs) : null].filter(Boolean).join(' · ')}</Text>
                      </Box>
                    ))}
                    {rows.length < g.workers.length ? (
                      <Text dimColor>{g.workers.length - rows.length} more not drawn here (a pane draws so much text); the viewer lists every one.</Text>
                    ) : null}
                    {!g.workers.length ? <Text dimColor>{g.isReached ? 'No agents ran in this phase.' : 'Not reached.'}</Text> : null}
                  </Box>
                )
              })}
              {drawnGroups < groups.length ? (
                <Text dimColor>{groups.length - drawnGroups} more phases not drawn here (a pane draws so much text); the viewer lists every one.</Text>
              ) : null}
            </Box>
          )
        }

        const workerCard = (w: Worker) => {
          const wid = `${selected}:${w.index ?? w.id}`
          const canControl = w.kind === 'agent' && w.index !== null && isActive(w.state) && live
          const index = w.index ?? 0
          const facts = [
            w.durationMs !== null ? fmtDuration(w.durationMs) : null,
            isLive(w.state) && w.tool ? `using ${w.tool}` : null,
            w.outputTokens ? `${fmtTokens(w.outputTokens)} tokens out` : null,
            w.cost ? fmtCost(w.cost) : null,
          ].filter(Boolean)
          const isConfirming = canControl && confirm === `cancel:${wid}`
          // On a clickable face the stats and error sit inside it, so the whole card body
          // opens the agent's thread; elsewhere they are drawn under the title row.
          const isFaced = Client !== null && w.kind === 'agent' && w.index !== null
          const lines = [
            ...(facts.length ? [{ text: facts.join(' · '), isError: false }] : []),
            ...(w.error ? [{ text: clipDraw(w.error, 300), isError: true }] : []),
          ]
          const border = isConfirming
            ? { borderColor: 'error' as const }
            : isLive(w.state)
              ? { borderColor: 'suggestion' as const }
              : { borderDimColor: true }
          return (
            <Box key={`w:${w.id}`} borderStyle="round" {...border} hover={{ borderColor: 'suggestion' }} paddingX={1} flexDirection="column" width="48%" minWidth={36} flexGrow={1}>
              <Box justifyContent="space-between" alignItems="flex-start" gap={1}>
                {w.kind === 'agent' && w.index !== null ? (
                  face(`agentcard:${w.index}`, { title: `#${w.index}  ${w.label}  ›`, subtitle: whoOf(w), lines }, () => openAgent($, index), () => (
                    <Box flexDirection="column" flexShrink={1}>
                      <Button key={`agent:${w.index}`} plain label={`#${w.index}  ${w.label}  ›`} onPress={() => openAgent($, index)} />
                      <Text dimColor wrap="truncate-end">
                        {whoOf(w)}
                      </Text>
                    </Box>
                  ))
                ) : (
                  <Box flexDirection="column" flexShrink={1}>
                    <Text bold wrap="truncate-end">
                      ⚙ {w.label}
                    </Text>
                    <Text dimColor>step</Text>
                  </Box>
                )}
                <Box flexShrink={0}>{badge(w.state)}</Box>
              </Box>
              {!isFaced && facts.length ? (
                <Text dimColor wrap="truncate-end">
                  {facts.join(' · ')}
                </Text>
              ) : null}
              {!isFaced && w.error ? (
                <Text color="error" wrap="wrap">
                  {clipDraw(w.error, 300)}
                </Text>
              ) : null}
              {canControl && steering === wid && Input ? (
                <Box key={`steer:${wid}`} flexDirection="column" marginTop={1}>
                  <Input
                    key={`steer-input:${wid}:${sent}`}
                    placeholder={`Message to ${w.label}…`}
                    submitLabel="Send"
                    autoFocus
                    onSubmit={(text) => steer($, selected, index, w.label, text)}
                  />
                  <Box gap={1}>
                    {btn(`steer-close:${wid}`, 'Close', () => update($, steeringAtom, () => null))}
                  </Box>
                </Box>
              ) : null}
              {isConfirming ? (
                <Box key={`confirm:${wid}`} flexDirection="column" marginTop={1}>
                  <Text color="error" wrap="wrap">
                    Stop {w.label} now? The workflow gets no result from it.
                  </Text>
                  <Box gap={1} flexWrap="wrap">
                    {btn(`cancel-yes:${wid}`, 'Yes, cancel', () => cancel($, selected, index), 'primary')}
                    {btn(`cancel-no:${wid}`, 'Keep running', () => update($, confirmAtom, () => null))}
                  </Box>
                </Box>
              ) : null}
              {canControl && steering !== wid && !isConfirming ? (
                <Box key={`actions:${wid}`} gap={1} marginTop={1} flexWrap="wrap">
                  {Input ? btn(`steer:${wid}`, 'Steer', () => update($, steeringAtom, () => wid)) : null}
                  {btn(`cancel:${wid}`, 'Cancel…', () => askToCancel($, wid, w.label), 'danger')}
                </Box>
              ) : null}
            </Box>
          )
        }

        return (
          <Box flexDirection="column" gap={1} width="100%">
            <Box key="header" flexDirection="column">
              <Box justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
                <Box gap={1} alignItems="center" flexWrap="wrap">
                  {btn('back', '‹ Runs', () => select($, null))}
                  <Text bold>{run ? titleOf(run.file) : selected}</Text>
                  <Box flexShrink={0}>{badge(state)}</Box>
                </Box>
                <Box key="tabs" gap={1} flexShrink={0}>
                  {btn('tab:agents', 'Agents', () => setTab('agents'), runTab === 'agents' ? 'primary' : 'secondary')}
                  {btn('tab:timeline', 'Timeline', () => setTab('timeline'), runTab === 'timeline' ? 'primary' : 'secondary')}
                  {btn('tab:phases', 'Phases', () => setTab('phases'), runTab === 'phases' ? 'primary' : 'secondary')}
                  {btn('tab:log', 'Log', () => setTab('log'), runTab === 'log' ? 'primary' : 'secondary')}
                  {btn('tab:structure', 'Structure', () => setTab('structure'), runTab === 'structure' ? 'primary' : 'secondary')}
                </Box>
              </Box>
              <Text dimColor wrap="truncate-end">
                {selected}
                {attached.includes(selected) ? ' · launched here' : ''}
                {run?.createdAt ? ` · started ${fmtAge(now, run.createdAt)}` : ''}
              </Text>
            </Box>
            {errorBanner}
            {d ? (
              <Box key="tiles" gap={1} flexWrap="wrap">
                {tile('agents', 'Agents', d.isPartial && !workers.length ? '—' : `${done}/${workers.length} done`)}
                {tile('time', live ? 'Elapsed' : 'Took', took !== null ? fmtDuration(took) : '—')}
                {tile(
                  'tokens',
                  'Output',
                  // Lifetime, every attempt: from the run's events where read (the
                  // engine's live counter restarts with each resumed attempt).
                  workers.some((a) => a.outputTokens)
                    ? `${fmtTokens(workers.reduce((s, a) => s + (a.outputTokens ?? 0), 0))} tokens`
                    : d.spentOutputTokens
                      ? `${fmtTokens(d.spentOutputTokens)} tokens`
                      : '—',
                )}
                {tile('cost', 'Cost', runCost ? fmtCost(runCost) : '—')}
                {timelineFailedFor === selected ? (
                  <Text dimColor wrap="wrap">
                    This run's events could not be read just now; totals include what status reports for attempts not read yet.
                  </Text>
                ) : null}
                {tl?.currentPhase
                  ? tile('phase', `Phase ${tl.currentPhase.index + 1}`, tl.currentPhase.title)
                  : !tl && d.phases.length
                    ? tile('phase', 'Phase', d.phases[d.phases.length - 1] ?? '')
                    : null}
              </Box>
            ) : (
              <Text dimColor>Loading…</Text>
            )}
            {workers.length && Svg ? (
              <Box key="bar" width="100%">
                <Svg source={progressSvg(workers)} alt={`${done} of ${workers.length} done`} height={6} />
              </Box>
            ) : null}

            {d?.questions.length ? (
              <Box key="questions" flexDirection="column" gap={1}>
                {qCut.shown.map((q) => (
                  <Box key={`q:${q.qid}`} borderStyle="round" {...(q.isOpen ? { borderColor: 'warning' as const } : { borderDimColor: true })} paddingX={1} flexDirection="column">
                    <Text {...(q.isOpen ? { color: 'warning' as const } : { dimColor: true })} bold>
                      {q.isOpen
                        ? `The workflow is asking (${q.qid})`
                        : live
                          ? `Asked before the run stopped (${q.qid}): it can be answered once the run asks it again`
                          : `Never answered (${q.qid}): the run ended first`}
                    </Text>
                    <Text wrap="wrap" {...(q.isOpen ? {} : { dimColor: true })}>
                      {q.question}
                    </Text>
                    {!q.isOpen ? null : Input ? (
                      <Input
                        // The field is this run's and this question event's: a draft typed
                        // for one run never stays in a field another run's question reuses.
                        key={`answer:${q.qid}:${sent}:${selected}:${q.t ?? ''}`}
                        placeholder="Type an answer…"
                        submitLabel="Answer"
                        onSubmit={(text) => answer($, selected, q.qid, text)}
                      />
                    ) : (
                      <Text dimColor>
                        flowition answer {selected} {q.qid} "…"
                      </Text>
                    )}
                  </Box>
                ))}
                {qHidden.length ? (
                  <Text dimColor wrap="wrap">
                    {qHidden.length} more {qHidden.length === 1 ? 'question' : 'questions'} not drawn here ({clipDraw(qHidden.join(', '), 200)}); the viewer shows them all, or {`flowition answer ${selected} <qid> "…"`}.
                  </Text>
                ) : null}
              </Box>
            ) : null}

            {runTab !== 'agents' && tl && tl.consumed < tl.total ? (
              <Text dimColor>Reading this run's events… {Math.floor((tl.consumed / tl.total) * 100)}%</Text>
            ) : null}
            {runTab !== 'agents' && runTab !== 'log' && laneCut.hidden ? (
              <Text dimColor wrap="wrap">
                Showing the first {laneCut.shown.length} of {shownLanes.length} agents and steps; the viewer has them all.
              </Text>
            ) : null}
            {runTab === 'timeline' ? (
              timelineView()
            ) : runTab === 'phases' ? (
              phasesView()
            ) : runTab === 'log' ? (
              logView(c, tl)
            ) : runTab === 'structure' ? (
              structureView(c, tl, workers, (i) => openAgent($, i), now, live)
            ) : workers.length ? (
              <Box key="workers" flexDirection="column">
                <Text bold>{agents.length === workers.length ? 'Agents' : 'Agents and steps'}</Text>
                <Box flexWrap="wrap" gap={1}>
                  {cardCut.shown.map(workerCard)}
                </Box>
                {cardCut.hidden ? (
                  <Text dimColor wrap="wrap">
                    {cardCut.hidden} more not drawn here (a pane draws so much text); the viewer lists every one.
                  </Text>
                ) : null}
              </Box>
            ) : d?.isPartial ? (
              <Text dimColor wrap="wrap">
                This run's agents are not known here yet: its status has not been read whole (it may be too large for the pane). Open it in the viewer, or see `flowition status {selected}`.
              </Text>
            ) : d ? (
              <Text dimColor>No agents yet.</Text>
            ) : null}

            {d?.resultMarkdown ? (
              <Box key="result" flexDirection="column">
                <Text bold>Result</Text>
                <Box borderStyle="round" borderDimColor paddingX={1} flexDirection="column">
                  <Markdown key="result-md" text={d.resultMarkdown} />
                </Box>
              </Box>
            ) : null}
            {d?.error ? (
              <Box borderStyle="round" borderColor="error" paddingX={1}>
                <Text color="error" wrap="wrap">
                  {clipDraw(d.error, 4_000)}
                </Text>
              </Box>
            ) : null}

            <Box key="footer" gap={1} alignItems="center" flexWrap="wrap">
              {btn('viewer', 'Open in viewer', () => openViewer($, selected), 'primary')}
              {live
                ? btn('wake', isWoken ? 'Claude will be told ✓' : 'Tell Claude when done', () =>
                    update($, wakeAtom, (all) => (all.includes(selected) ? all.filter((id) => id !== selected) : [...all, selected])),
                  )
                : null}
              {live && confirm === `cancel:${selected}` ? (
                <>
                  <Text color="error">Cancel the whole run?</Text>
                  {btn('cancel-run-yes', 'Yes, cancel run', () => cancel($, selected, null), 'primary')}
                  {btn('cancel-run-no', 'Keep running', () => update($, confirmAtom, () => null))}
                </>
              ) : live ? (
                btn('cancel-run', 'Cancel run…', () => askToCancel($, selected, `the whole run`), 'danger')
              ) : null}
              {!live && RESUMABLE.has(state) ? (
                confirm === `resume:${selected}` ? (
                  <>
                    <Text>
                      {state === 'completed'
                        ? 'Replay? The run restarts in a detached process and its finished agents replay from the journal; anything not journaled runs again, with full permissions, where the run first ran.'
                        : 'Resume? Finished agents are reused; the rest run again, with full permissions, where the run first ran.'}
                    </Text>
                    {btn('resume-yes', state === 'completed' ? 'Yes, replay' : 'Yes, resume', () => resumeRun($, selected, state === 'completed'), 'primary')}
                    {btn('resume-no', 'Not now', () => update($, confirmAtom, () => null))}
                  </>
                ) : (
                  btn('resume', state === 'completed' ? 'Replay…' : 'Resume…', () => update($, confirmAtom, () => `resume:${selected}`))
                )
              ) : null}
              {!live ? (
                confirm === `delete:${selected}` ? (
                  <>
                    <Text color="error">Move this run to flowition's trash? It stays recoverable for 7 days.</Text>
                    {btn('delete-yes', 'Yes, move to trash', () => deleteRun($, selected), 'primary')}
                    {btn('delete-no', 'Keep it', () => update($, confirmAtom, () => null))}
                  </>
                ) : (
                  btn('delete', 'Delete…', () => update($, confirmAtom, () => `delete:${selected}`), 'danger')
                )
              ) : null}
              {btn('ask', 'Ask Claude…', () => askClaude($, selected, run?.file ?? null, state, null))}
              {btn('refresh', 'Refresh', () => refreshAll($))}
              {d ? <Text dimColor>last change {fmtAge(now, d.fetchedAt)}</Text> : null}
            </Box>
          </Box>
        )
      }

      // ---- the new-run form, while it is open ----
      const [launch, workflows, listFilter, listQuery, openGroups] = await Promise.all([
        read($, launchAtom),
        read($, workflowsAtom),
        read($, listFilterAtom),
        read($, listQueryAtom),
        read($, openGroupsAtom),
      ])
      if (launch) {
        return launchView(c, launch, workflows, launch.cwd || 'this session’s folder', {
          // Another workflow starts from empty args: none carried over, unseen, from the last.
        pick: (file) => update($, launchAtom, (l) => (l ? { ...l, file, args: l.file === file ? l.args : '', error: null } : l)),
        filter: (query) => update($, launchAtom, (l) => (l ? { ...l, query, limit: 20 } : l)),
        more: () => update($, launchAtom, (l) => (l ? { ...l, limit: l.limit + 20 } : l)),
          args: (text) => update($, launchAtom, (l) => (l ? { ...l, args: text } : l)),
          start: () => startRun($),
          close: () => update($, launchAtom, () => null),
        })
      }

      // ---- the run list: this session's runs, everything live, then the most recent ----
      const shown = filterRuns(runs, listFilter, listQuery, details)
      const byId = new Map(shown.map((r) => [r.runId, r]))
      const mine = attached.map((id) => byId.get(id)).filter((r): r is Run => r !== undefined).reverse()
      const liveRuns = shown.filter((r) => isLive(r.state) && !attached.includes(r.runId))
      const seen = new Set([...mine, ...liveRuns].map((r) => r.runId))
      const rest = shown.filter((r) => !seen.has(r.runId))
      const recent = rest.slice(0, recentLimit)
      const toggleGroup = (key: string) => update($, openGroupsAtom, (all) => (all.includes(key) ? all.filter((k) => k !== key) : [...all, key]))

      // Under a day heading a run says its time of day; elsewhere how long ago it began.
      const subtitle = (r: Run, isDated: boolean) => {
        const when = isDated ? fmtTime(r.createdAt) : fmtAge(now, r.createdAt)
        const waiting = isLive(r.state) ? (details[r.runId]?.questions.filter((q) => q.isOpen).length ?? 0) : 0
      return [r.runId, when, waiting ? `${waiting} question${waiting === 1 ? '' : 's'} waiting` : null].filter(Boolean).join(' · ')
      }
      // `isDated`: a card in Recent's day-grouped grid, two to a row where they fit.
      const runCard = (r: Run, isDated = false) => (
        <Box
          key={`r:${r.runId}`}
          {...(isDated ? { width: '48%', minWidth: 34, flexGrow: 1 } : {})}
          borderStyle="round"
          {...(isLive(r.state) ? { borderColor: 'suggestion' as const } : { borderDimColor: true })}
          hover={{ borderColor: 'suggestion' }}
          paddingX={1}
          justifyContent="space-between"
          alignItems="center"
          gap={1}
        >
          {face(`card:${r.runId}`, { title: titleOf(r.file), subtitle: subtitle(r, isDated), lines: [] }, () => select($, r.runId), () => (
            <Box flexDirection="column" flexShrink={1}>
              <Button key={`open:${r.runId}`} plain label={titleOf(r.file)} onPress={() => select($, r.runId)} />
              <Text dimColor wrap="truncate-end">
                {subtitle(r, isDated)}
              </Text>
            </Box>
          ))}
          <Box flexShrink={0}>{badge(r.state)}</Box>
        </Box>
      )
      // Back-to-back runs of one workflow fold into one card; open, it lists them.
      const groupCard = (g: { key: string; runs: Run[] }) => {
        const latest = g.runs[0] as Run
        const earliest = g.runs[g.runs.length - 1] as Run
        const isOpen = openGroups.includes(g.key)
        const title = `${titleOf(latest.file)} · ${g.runs.length} runs ${isOpen ? '▾' : '▸'}`
        const sub = `${fmtTime(earliest.createdAt)}–${fmtTime(latest.createdAt)} · ${stateTally(g.runs)}`
        return (
          <Box key={`g:${g.key}`} width="100%" flexDirection="column" gap={1}>
            <Box borderStyle="round" borderDimColor hover={{ borderColor: 'suggestion' }} paddingX={1} justifyContent="space-between" alignItems="center" gap={1}>
              {face(`group:${g.key}`, { title, subtitle: sub, lines: [] }, () => toggleGroup(g.key), () => (
                <Box flexDirection="column" flexShrink={1}>
                  {btn(`group-btn:${g.key}`, title, () => toggleGroup(g.key), 'plain')}
                  <Text dimColor wrap="truncate-end">
                    {sub}
                  </Text>
                </Box>
              ))}
              <Box flexShrink={0}>{badge(latest.state)}</Box>
            </Box>
            {isOpen ? (
              <Box key={`gm:${g.key}`} flexWrap="wrap" gap={1} marginLeft={2}>
                {g.runs.map((r) => runCard(r, true))}
              </Box>
            ) : null}
          </Box>
        )
      }
      const section = (title: string, list: Run[]) =>
        list.length ? (
          <Box key={`s:${title}`} flexDirection="column" gap={1}>
            <Text bold>{title}</Text>
            {list.map((r) => runCard(r))}
          </Box>
        ) : null

      return (
        <Box flexDirection="column" gap={1} width="100%">
          <Box justifyContent="space-between" alignItems="center" gap={1}>
            <Text bold>Runs</Text>
            <Box gap={1} alignItems="center" flexWrap="wrap">
              <Text dimColor>
                {runs.filter((r) => isLive(r.state)).length} live · {runs.length} {listNote ? 'shown' : 'total'}
              </Text>
              {btn('new', 'New run…', () => openLauncher($), 'primary')}
              {btn('refresh', 'Refresh', () => refreshAll($))}
            </Box>
          </Box>
          <Box key="filters" gap={1} alignItems="center" flexWrap="wrap">
            {(['all', 'live', 'attention', 'completed'] as const).map((f) =>
              btn(`filter:${f}`, FILTER_LABELS[f], () => update($, listFilterAtom, () => f), listFilter === f ? 'primary' : 'secondary'),
            )}
            {Input ? (
              <Box flexGrow={1} minWidth={20}>
                <Input
                  key="search"
                  placeholder="Search runs"
                  onInput={(text) => update($, listQueryAtom, () => text)}
                  onSubmit={(text) => update($, listQueryAtom, () => text)}
                />
              </Box>
            ) : null}
          </Box>
          {errorBanner}
          {listNote ? (
            <Text key="list-note" dimColor wrap="wrap">
              {listNote}
            </Text>
          ) : null}
          {shown.length === 0 && runs.length > 0 ? <Text dimColor>No runs match{listQuery ? ` “${listQuery}”` : ''}.</Text> : null}
          {runs.length === 0 && !error ? <Text dimColor>No runs under {home || '~/.flowition'} yet.</Text> : null}
          {section('Launched here', mine)}
          {section('Live', liveRuns)}
          {recent.length ? (
            <Box key="s:Recent" flexDirection="column" gap={1}>
              <Text bold>Recent</Text>
              {groupByDay(recent, now).map((day) => (
                <Box key={`day:${day.label}`} flexDirection="column">
                  <Text dimColor>{day.label}</Text>
                  <Box flexWrap="wrap" gap={1}>
                    {foldRepeats(day.runs).map((x) => (x.type === 'group' ? groupCard(x) : runCard(x.run, true)))}
                  </Box>
                </Box>
              ))}
            </Box>
          ) : null}
          {rest.length > recent.length ? (
            <Box gap={1} alignItems="center">
              {btn('more', 'Show more', () => update($, recentLimitAtom, (n) => n + 10))}
              <Text dimColor>{rest.length - recent.length} older</Text>
            </Box>
          ) : null}
        </Box>
      )
    } catch (err) {
      // A draw that throws would leave the pane blank: say why, and offer a way out.
      const els = $.ui.resolve(e)
      const { Box, Text, Button } = els
      const recover = () => select($, null)
      pressHandlers.set(`${e.surface}:recover`, { fn: recover, render, surface: e.surface })
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="error" wrap="wrap">
            The pane could not draw: {err instanceof Error ? err.message : String(err)}
          </Text>
          {e.surface === 'desktop' && 'Client' in els ? (
            <els.Client key="recover" module="./button.tsx" props={{ label: 'Back to runs', variant: 'secondary' }} />
          ) : (
            <Button key="recover" label="Back to runs" onPress={recover} />
          )}
        </Box>
      )
    } finally {
      for (const [key, h] of pressHandlers) if (h.surface === e.surface && h.render < render - 1) pressHandlers.delete(key)
    }
  })
}
