import { atom, read, update } from 'claude-code'
import type { EngineInterface, ProcessRunResult, Register } from 'claude-code'

import type {
  FlowitionCockpitDetail as Detail,
  FlowitionCockpitRun as Run,
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
  laneSpan,
  laneSvg,
  laneText,
  parseRuns,
  parseStatus,
  parseTimeline,
  parseTranscript,
  phaseGroups,
  placeholder,
  progress,
  progressSvg,
  runDuration,
  sameDetail,
  sameJson,
  sliceLines,
  stateColor,
  statusLine,
  stateTally,
  steerHint,
  timelineWindow,
  titleOf,
  transitions,
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

/** States a run may be resumed from: `flowition run <file> --resume` re-enters them. */
const RESUMABLE = new Set(['failed', 'interrupted', 'stale'])
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
// Set when this session launched a run whose id the tool output did not carry
// (a backgrounded Bash call): the next new run created after it is attached.
let attachNextSince: number | null = null
// The handlers behind the desktop's button faces (button.tsx), by the face's key: each
// render sets them, and a face's click (`ui.message` with `{ press }`) runs its own.
const pressHandlers = new Map<string, () => unknown>()
// Bumped by each message sent: part of the fields' keys, so a sent field draws empty.
let sent = 0
// The session's working directory: where a run started from the pane runs.
let sessionCwd = ''

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
    if (mustList || mtime !== runsDirMtime || now - lastListAt >= listEvery) {
      const ran = await flo($, ['runs', '--json'])
      if (ran.exitCode !== 0) throw new Error(firstLine(ran.stderr) || `flowition runs exited ${ran.exitCode}`)
      list = parseRuns(ran.stdout)
      lastListAt = now
      runsDirMtime = mtime
      mustList = false
    }

    let attached: string[] = await read($, attachedAtom)
    if (attachNextSince !== null) {
      const since = attachNextSince
      const fresh = list.find((r) => r.createdAt >= since && !attached.includes(r.runId))
      if (fresh) {
        attachNextSince = null
        attached = [...attached, fresh.runId].slice(-20)
        await update($, attachedAtom, () => attached)
        await update($, selectedAtom, () => fresh.runId)
      } else if (now - since > 120_000) {
        attachNextSince = null
      }
    }

    // Poll the live runs, the ones this session watches, and the one on screen.
    const wake: string[] = await read($, wakeAtom)
    const watched = new Set([...attached, ...wake])
    const selected = await read($, selectedAtom)
    const details: Record<string, Detail> = { ...(await read($, detailsAtom)) }
    const ids = new Set(list.filter((r) => isLive(r.state)).map((r) => r.runId))
    for (const id of watched) if (!details[id] || isLive(details[id].state)) ids.add(id)
    if (selected && (force || !details[selected] || isLive(details[selected].state))) ids.add(selected)

    const toasts: string[] = []
    const woken: string[] = []
    for (const id of ids) {
      const ran = await flo($, ['status', id, '--json'])
      if (ran.exitCode !== 0) continue
      const next = parseStatus(ran.stdout, now)
      const prev = details[id]
      if (watched.has(id)) toasts.push(...transitions(prev, next))
      if (hasEnded(prev, next)) {
        mustList = true
        if (wake.includes(id)) woken.push(id)
      }
      // An unchanged poll keeps the old object, so nothing is redrawn for it.
      details[id] = prev && sameDetail(prev, next) ? prev : next
    }

    // The list's state lags a poll behind; the detail just read is the truth.
    list = list.map((r) => {
      const state = details[r.runId]?.state
      return state && state !== r.state ? { ...r, state } : r
    })
    // Keep detail only for what the pane or the toasts still need.
    const keep = new Set([...ids, ...watched, ...(selected ? [selected] : [])])
    for (const id of Object.keys(details)) if (!keep.has(id)) delete details[id]

    // Write only what changed: every write redraws the pane, and a redraw landing
    // mid-click can swallow the click on the desktop.
    if (!sameJson(list, await read($, runsAtom))) await update($, runsAtom, () => list)
    if (!sameJson(details, await read($, detailsAtom))) await update($, detailsAtom, () => details)
    if ((await read($, errorAtom)) !== null) await update($, errorAtom, () => null)
    for (const text of toasts) $.ui.toast(text, { timeoutMs: 8000 })
    const status = statusLine(list, details)
    if (status !== lastStatus) {
      lastStatus = status
      $.ui.status(status)
    }

    await refreshThread($, now)
    await refreshTimeline($)

    // The opt-in wake: a turn of Claude's own once the session is idle.
    if (woken.length) {
      await update($, wakeAtom, (all) => all.filter((id) => !woken.includes(id)))
      for (const id of woken) {
        const run = list.find((r) => r.runId === id)
        const d = details[id]
        void $.prompt.submit({
          text: `Flowition run ${id}${run ? ` (${run.file})` : ''} just finished: ${d?.state ?? 'ended'}. Read its result with \`flowition result ${id}\` and give me a short summary.`,
        })
      }
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

/**
 * Folds the selected run's events into its timeline while the Timeline or Phases tab is
 * showing: the run, agent, step and phase lines only (grep leaves the frequent progress
 * lines out), and only again once the file has grown.
 */
async function refreshTimeline($: EngineInterface): Promise<void> {
  const runId = await read($, selectedAtom)
  if (!runId || (await read($, runTabAtom)) === 'agents') return
  const file = `${home}/runs/${runId}/events.jsonl`
  let size: number
  try {
    size = (await $.fs.stat(file)).size
  } catch {
    return
  }
  const prev = await read($, timelineAtom)
  if (prev && prev.runId === runId && prev.size === size && Array.isArray(prev.entries)) return
  const ran = await $.process.run(
    ['/bin/sh', '-c', 'grep -E \'"type":"(run|agent|step|phase|log|mail|question|answer)"\' "$1" | grep -v \'"state":"progress"\'', 'sh', file],
    { timeoutMs: 10_000 },
  )
  if (ran.exitCode > 1) return
  await update($, timelineAtom, () => parseTimeline(ran.stdout, runId, size))
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
  events = [...events, ...fresh]
  if (events.length > MAX_EVENTS) {
    events = events.slice(-MAX_EVENTS)
    isPartial = true
  }
  await update($, threadAtom, () => ({ runId, index, consumed, isPartial, events, fetchedAt: now }))
  if (fresh.length && (await read($, followAtom))) void $.ui.scroll({ in: PANE, to: 'end' }).catch(() => undefined)
}

// ---- actions ---------------------------------------------------------------------

/** The Refresh button: the run list and everything on screen, now. */
function refreshAll($: EngineInterface): Promise<void> {
  mustList = true
  return refresh($, true)
}

async function attach($: EngineInterface, runId: string): Promise<void> {
  const now = await $.clock.now()
  await update($, attachedAtom, (list) => (list.includes(runId) ? list : [...list, runId].slice(-20)))
  await update($, detailsAtom, (all) => (all[runId] ? all : { ...all, [runId]: placeholder(runId, now) }))
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

/** Resumes a failed, interrupted or stale run, detached, as the viewer does. */
async function resumeRun($: EngineInterface, runId: string): Promise<void> {
  await update($, confirmAtom, () => null)
  // The run's first event names its workflow file; `run --resume --detach` installs the
  // resume handoff marker and restores the run's journaled adapter, cwd and args.
  let file: string | null = null
  try {
    const head = await $.process.run(['head', '-n', '1', `${await ensureHome($)}/runs/${runId}/events.jsonl`])
    const first: unknown = JSON.parse(head.stdout)
    const wf = first !== null && typeof first === 'object' ? (first as { workflowFile?: unknown }).workflowFile : undefined
    if (typeof wf === 'string') file = wf
  } catch {
    // reported below
  }
  if (!file) {
    $.ui.toast(`Can't resume ${runId}: its first event names no workflow file.`, { timeoutMs: 8000 })
    return
  }
  const res = await control($, ['run', file, '--resume', runId, '--detach', '--json'])
  const ok = res.error === null || res.reply.detached === true
  $.ui.toast(ok ? `Resuming ${runId}` : `Resume failed: ${res.error}`, { timeoutMs: ok ? 4000 : 10_000 })
  $.ui.log(`flowition-cockpit: resume ${runId} → ${ok ? 'started' : `failed: ${res.error}`}`)
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
  if (!sessionCwd) {
    try {
      sessionCwd = (await $.process.run(['pwd'])).stdout.trim()
    } catch {
      sessionCwd = ''
    }
  }
  await update($, launchAtom, () => ({ file: null, args: '', error: null }))
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
async function startRun($: EngineInterface): Promise<void> {
  const launch = await read($, launchAtom)
  if (!launch?.file) return
  const args = launch.args.trim()
  if (args) {
    try {
      JSON.parse(args)
    } catch {
      await update($, launchAtom, (l) => (l ? { ...l, error: 'Args must be JSON, e.g. {"topic": "..."}' } : l))
      return
    }
  }
  const ran = await flo($, ['run', launch.file, ...(args ? ['--args', args] : []), '--detach', '--json'], 30_000).catch((err: unknown) => ({
    exitCode: 1,
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
  }))
  const runId = ran.exitCode === 0 ? extractRunId(ran.stdout) : null
  if (!runId) {
    await update($, launchAtom, (l) => (l ? { ...l, error: firstLine(ran.stderr) || 'flowition did not start the run' } : l))
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
    // drop every cache the polls rebuild (details, timeline, thread, workflow files).
    await update($, detailsAtom, () => ({}))
    await update($, timelineAtom, () => null)
    await update($, workflowsAtom, () => [])
    await update($, threadAtom, () => null)
    await update($, steeringAtom, () => null)
    await update($, confirmAtom, () => null)
    await update($, recentLimitAtom, () => 8)
    await update($, launchAtom, () => null)
    sessionCwd = ''
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
    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    const runId = extractRunId(ran.text ?? '')
    if (runId) await attach($, runId)
    else attachNextSince = startedAt - 5000
    void $.ui.open({ id: PANE, title: TITLE })
    return ran
  }).catch(($, e, next) => next(e))

  // A face was clicked (button.tsx, card.tsx): run the handler its render registered.
  on('ui.message', async ($, e) => {
    const data = e.data !== null && typeof e.data === 'object' ? (e.data as { press?: unknown }) : {}
    if (data.press === true) await pressHandlers.get(e.element)?.()
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    try {
      const els = $.ui.resolve(e)
      const { Box, Text, Button, Markdown, Code } = els
      const Svg = 'Svg' in els ? els.Svg : null
      const Input = 'Input' in els ? els.Input : null
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
        if (pressHandlers.size > 500) pressHandlers.clear()
        pressHandlers.set(key, onPress)
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
          if (pressHandlers.size > 500) pressHandlers.clear()
          pressHandlers.set(key, onPress)
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
      const [runs, details, selected, attached, error, wake, steering, confirm, recentLimit, agentView, now] = await Promise.all([
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
            {error}
          </Text>
        </Box>
      ) : null

      // ---- one agent's thread: its transcript, live, with a composer under it ----
      if (selected && agentView !== null) {
        const [thread, expanded, follow] = await Promise.all([read($, threadAtom), read($, expandedAtom), read($, followAtom)])
        const d: Detail | undefined = details[selected]
        const w = d?.workers.find((x) => x.kind === 'agent' && x.index === agentView)
        const th = thread && thread.runId === selected && thread.index === agentView ? thread : null
        const live = isLive(d?.state ?? 'unknown')
        const canControl = live && w !== undefined && isActive(w.state)
        const label = w?.label ?? `agent ${agentView}`
        const wid = `${selected}:${agentView}`
        const events = th?.events ?? []
        const results = new Map(events.filter((x) => x.kind === 'tool-result' && x.toolUseId).map((x) => [x.toolUseId as string, x]))
        const paired = new Set(events.filter((x) => x.kind === 'tool' && x.toolId && results.has(x.toolId)).map((x) => x.toolId as string))
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
                  <Markdown key={`md:${ev.seq}`} text={ev.text ?? ''} />
                </Box>
              )
            case 'reasoning': {
              const text = ev.redacted || !ev.text ? 'Thought privately (the provider withheld the text).' : ev.text
              const isLong = text.length > 280
              return (
                <Box key={key} flexDirection="column">
                  <Text dimColor italic wrap="wrap">
                    {isLong && !isOpen ? `${text.slice(0, 280)}…` : text}
                  </Text>
                  {isLong ? btn(`more:${ev.seq}`, isOpen ? 'less' : 'more', () => toggle(key), 'plain') : null}
                </Box>
              )
            }
            case 'tool': {
              const result = ev.toolId ? results.get(ev.toolId) : undefined
              const outcome = result
                ? result.isError
                  ? `error · ${(result.output ?? '').split('\n')[0]?.slice(0, 120) ?? ''}`
                  : result.output
                    ? `${result.output.split('\n').length} lines`
                    : 'done'
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
                      {ev.input ? <Code source={ev.input} language="json" wrap="wrap" /> : null}
                      {result?.output ? <Code source={result.output} wrap="wrap" /> : null}
                    </Box>
                  ) : null}
                </Box>
              )
            }
            case 'tool-result':
              return ev.toolUseId && paired.has(ev.toolUseId) ? null : (
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
                  <Text wrap="wrap">{ev.text ?? ''}</Text>
                </Box>
              )
            case 'mail-out':
              return (
                <Box key={key} borderStyle="round" borderColor="success" paddingX={1} flexDirection="column">
                  <Text color="success" bold>
                    {label} → you · {fmtClock(ev.t)}
                  </Text>
                  <Text wrap="wrap">{ev.text ?? ''}</Text>
                </Box>
              )
            case 'status':
              return (
                <Text dimColor wrap="wrap">
                  · {ev.text ?? ''}
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
                <Text wrap="wrap">{prompt.length > 400 && !expanded.includes('prompt') ? `${prompt.slice(0, 400)}…` : prompt}</Text>
              </Box>
            ) : null}
            <Box key="events" flexDirection="column" gap={1}>
              {events.map(row)}
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
        const workers = d?.workers ?? []
        const agents = workers.filter((w) => w.kind === 'agent')
        const counts = progress(workers)
        const done = counts.find((c) => c.tone === 'success')?.count ?? 0
        const took = runDuration(run, d, now)
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
      const tl = timeline && timeline.runId === selected && Array.isArray(timeline.entries) ? timeline : null
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
          const groups = phaseGroups(tl, workers, d?.phases ?? [])
          if (!groups.length) return <Text dimColor>{tl ? 'No agents or phases yet.' : 'Loading the phases…'}</Text>
          return (
            <Box key="phases" flexDirection="column" gap={1}>
              {groups.map((g) => {
                const took = g.startedAt !== null ? fmtDuration((g.endedAt ?? (live ? now : g.startedAt)) - g.startedAt) : null
                const facts = [
                  g.workers.length ? `${g.workers.length} ${g.workers.length === 1 ? 'agent' : 'agents'}` : null,
                  took,
                  g.cost ? fmtCost(g.cost) : null,
                ].filter(Boolean)
                const badgeState = g.state === 'pending' ? (live ? 'not reached' : 'never reached') : g.state
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
                          {g.title}
                        </Text>
                        <Box flexShrink={0}>{badge(badgeState)}</Box>
                      </Box>
                      <Text dimColor>{facts.join(' · ')}</Text>
                    </Box>
                    {g.workers.map((w) => (
                      <Box key={`pw:${w.id}`} justifyContent="space-between" gap={1}>
                        <Box gap={1} flexShrink={1} flexGrow={1} minWidth={0} overflow="hidden">
                          <Text color={stateColor(w.state)}>●</Text>
                          {workerLabel(`phase:${w.id}:open`, w.kind, w.index, w.label)}
                        </Box>
                        <Text dimColor>{[w.state, w.durationMs !== null ? fmtDuration(w.durationMs) : null].filter(Boolean).join(' · ')}</Text>
                      </Box>
                    ))}
                    {!g.workers.length ? <Text dimColor>{g.isReached ? 'No agents ran in this phase.' : 'Not reached.'}</Text> : null}
                  </Box>
                )
              })}
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
            ...(w.error ? [{ text: w.error, isError: true }] : []),
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
                  {w.error}
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
                {tile('agents', 'Agents', `${done}/${workers.length} done`)}
                {tile('time', live ? 'Elapsed' : 'Took', took !== null ? fmtDuration(took) : '—')}
                {tile(
                  'tokens',
                  'Output',
                  d.spentOutputTokens
                    ? `${fmtTokens(d.spentOutputTokens)} tokens`
                    : agents.some((a) => a.outputTokens)
                      ? `${fmtTokens(agents.reduce((s, a) => s + (a.outputTokens ?? 0), 0))} tokens`
                      : '—',
                )}
                {tile('cost', 'Cost', d.cost ? fmtCost(d.cost) : '—')}
                {d.phases.length ? tile('phase', `Phase ${d.phases.length}`, d.phases[d.phases.length - 1] ?? '') : null}
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
                {d.questions.map((q) => (
                  <Box key={`q:${q.qid}`} borderStyle="round" borderColor="warning" paddingX={1} flexDirection="column">
                    <Text color="warning" bold>
                      The workflow is asking ({q.qid})
                    </Text>
                    <Text wrap="wrap">{q.question}</Text>
                    {Input ? (
                      <Input
                        key={`answer:${q.qid}:${sent}`}
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
              </Box>
            ) : null}

            {runTab === 'timeline' ? (
              timelineView()
            ) : runTab === 'phases' ? (
              phasesView()
            ) : runTab === 'log' ? (
              logView(c, tl)
            ) : runTab === 'structure' ? (
              structureView(c, tl, workers, (i) => openAgent($, i))
            ) : workers.length ? (
              <Box key="workers" flexDirection="column">
                <Text bold>{agents.length === workers.length ? 'Agents' : 'Agents and steps'}</Text>
                <Box flexWrap="wrap" gap={1}>
                  {workers.map(workerCard)}
                </Box>
              </Box>
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
                  {d.error}
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
                    <Text>Resume? Finished agents are reused; the rest run again, with full permissions, where the run first ran.</Text>
                    {btn('resume-yes', 'Yes, resume', () => resumeRun($, selected), 'primary')}
                    {btn('resume-no', 'Not now', () => update($, confirmAtom, () => null))}
                  </>
                ) : (
                  btn('resume', 'Resume…', () => update($, confirmAtom, () => `resume:${selected}`))
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
        return launchView(c, launch, workflows, sessionCwd || 'this session’s folder', {
          pick: (file) => update($, launchAtom, (l) => (l ? { ...l, file, error: null } : l)),
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
        const questions = details[r.runId]?.questions.length ?? 0
        const when = isDated ? fmtTime(r.createdAt) : fmtAge(now, r.createdAt)
        return [r.runId, when, questions ? `${questions} question${questions === 1 ? '' : 's'} waiting` : null].filter(Boolean).join(' · ')
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
                {runs.filter((r) => isLive(r.state)).length} live · {runs.length} total
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
      pressHandlers.set('recover', recover)
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
    }
  })
}
