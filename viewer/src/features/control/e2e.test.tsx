// @vitest-environment jsdom
//
// §12.1 item 5, END TO END: the shipped `App` against a REAL viewer server, on REAL run
// directories, over REAL HTTP, with a REAL `serveControl` listener standing in for the
// engine on the other side of the run's control socket.
//
// `walkthrough.test.tsx` drives the same criterion through the shipped composition with
// the API stubbed, which is where the keyboard and the §7.2 gating are pinned. What it
// cannot show — and what review round 3 rejected it for — is that the two clicks actually
// REACH an engine and that the screen then reconciles to the answer: an injected
// `answerFn` proves the composer called what it was handed, not that `api.answer` builds a
// request the viewer accepts, that the control bridge forwards it, or that the refreshed
// snapshot renders the question answered. So this file removes every seam:
//
//   • the server is `startViewer` from src/viewer/index.js, bound on an ephemeral port
//     with `--control` (all five capabilities);
//   • the runs are directories on disk that `deriveRunState` classifies on its own;
//   • the "engine" is `serveControl` from src/control.js on the run's own socket, which
//     answers `answer` the way src/engine.js:695–701 does — by RECORDING the answer in the
//     run's event stream, which is what makes the question answered for every later read;
//   • the app is `<App/>` — the router, the shell, `ControlProvider`, Home, the cockpit —
//     with nothing injected;
//   • the credentials arrive the way the operator's do: in the hash of the URL the CLI
//     prints (`viewerUrl`), consumed and stripped by the router.
//
// **The one adaptation, and why it is not a seam.** `fetch` is routed through `node:http`
// here. `Host` and `Origin` are forbidden header names — a browser sets both itself and
// scripts cannot, and undici (Node's fetch, which is what jsdom leaves in place) drops
// `Origin` on the floor rather than sending it. §7.1.5 makes an exact `Origin` MANDATORY on
// every mutation, so a fetch-driven test could not answer at all: it would 403 on a header
// the real browser always supplies. The shim supplies exactly what a browser would and
// changes nothing else — the URL, the method, the body and every header the app sets are
// the app's own, and the same reasoning is why test/viewer-control.test.js uses node:http
// too (that file's header note).

import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { getFocusableTreeWalker } from '@react-aria/focus'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { App } from '../../app/App.js'
import { api } from '../../api/client.js'
import { resetRouteForTests } from '../../app/router.js'

// This file runs in its OWN vitest invocation (`npm test` chains it after the parallel
// pass — the `test:perf` precedent): it is a complete engine+server+SPA session, and on
// a 4-vCPU CI runner sharing the machine with three other worker forks its effective
// budget was a fraction of a core — the CI forensics showed a steer POST taking >60 s to
// even REACH the engine. Alone, the same runner passes with minutes of headroom.
//
// Instrumented accounting of where this walkthrough's time actually goes: the dominant
// waits are the ENGINE's own lifecycle transitions (a cancel settling its agents, a
// resume's detached spawn and preflight scan) — 1–5 s each on the reference machine and
// legitimately several times that on CI's shared runners. Cadence was a minor term. So
// the windows scale for CI rather than the product being rushed: Testing Library's 1 s
// default is calibrated for component tests, and "Unable to find role=option at 1 s" on
// a busy runner is a runner-speed report, not a product defect. (A round of shrinking
// the store/rail poll cadences via vi.mock was tried first and REVERTED: it bought ~8%
// locally — the engine transitions dominate — and on CI-class hardware a 250 ms poll
// re-rendering the cockpit is churn that starves the very updates being waited for.)
const WAIT_WINDOW_MS = process.env.CI ? 60_000 : 20_000
// 250 ms polls on CI, not 50: each Testing Library poll re-queries the tree, and at
// 20 queries/second for a minute the allocation rate is itself GC pressure on a worker
// that is already the suite's largest (see vite.config.ts poolOptions note).
const WAIT_INTERVAL_MS = process.env.CI ? 250 : 50
configure({ asyncUtilTimeout: WAIT_WINDOW_MS })

// The viewer home is REALPATH'd and its prefix kept short for the same reason
// test/viewer-control.test.js does it: `sun_path` is 104 bytes on macOS and the run's
// control socket lives at `<home>/runs/<id>/control.sock`.
const HOME = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'flo-e2e-'))
// Set before the server modules are imported (they resolve the home through `viewerHome()`)
// and restored in `afterAll` — a worker runs several test files, and none of the others
// may inherit this one's throwaway home.
const PRIOR_HOME = process.env.FLOWITION_HOME
process.env.FLOWITION_HOME = HOME
const RUNS = path.join(HOME, 'runs')
const DIST = path.join(HOME, 'dist')

/**
 * Failure forensics, because a CI runner cannot be ssh'd into after the fact: when a
 * step of the walkthrough dies, the assertion says what the SCREEN failed to show, and
 * this says what the RUN actually was — the difference is the diagnosis. (Two blind
 * CI rounds against this file are why it exists; bounded output, failure-only.)
 */
afterEach((ctx) => {
  if (ctx.task.result?.state !== 'fail') return
  for (const runId of fs.existsSync(RUNS) ? fs.readdirSync(RUNS) : []) {
    const dir = path.join(RUNS, runId)
    const tail = (file: string, n: number) => {
      try { return fs.readFileSync(path.join(dir, file), 'utf8').trimEnd().split('\n').slice(-n) } catch { return ['<absent>'] }
    }
    const age = (file: string) => {
      try { return `${Math.round(Date.now() - fs.statSync(path.join(dir, file)).mtimeMs)}ms old` } catch { return 'absent' }
    }
    console.error([
      `FORENSICS ${runId}:`,
      `  entries: ${fs.readdirSync(dir).join(', ')}`,
      `  heartbeat: ${age('.heartbeat')} | control.sock: ${age('control.sock')} | result.json: ${age('result.json')}`,
      `  events tail: ${tail('events.jsonl', 4).join(' | ')}`,
      `  journal tail: ${tail('journal.jsonl', 2).join(' | ')}`,
    ].join('\n'))
  }
})

// The server halves, loaded by Node rather than through Vite's module graph — see
// `vite.config.ts`'s `test.server.deps.external`, which is what makes `import.meta.url`
// inside them a real `file:` URL (§7.3's resume resolves `bin/flowition.js` from it).
const { startViewer } = await import('../../../../src/viewer/index.js')
const { serveControl } = await import('../../../../src/control.js')
const { HANDLERS } = await import('../../../../src/viewer/routes.js')

const ASK_RUN = 'r-ask'
const DEL_RUN = 'r-del'
/** §12.1 item 5's run: ONE run, walked from blocked-and-running to a trash entry. */
const WALK_RUN = 'r-walk'
const QUESTION = 'Keep the compatibility shim?'
const WALK_QUESTION = 'Which adapter should the audit use?'

type Viewer = {
  port: number
  url: string
  token: string
  controlToken: string | null
  close: () => Promise<void>
}
let viewer: Viewer
let control: { close: () => void } | null = null
let walkControl: { close: () => void } | null = null
/** Everything the "engine" was actually asked, in order. */
const answered: { qid: string; value: unknown }[] = []

/**
 * The §12.1-item-5 run's engine, as MUTABLE state — this is the "evolving fake server" the
 * walkthrough needs. Every command the operator issues changes what the next read of the
 * run reports, exactly as the real engine's would: an answered question leaves the status
 * reply, a steer appends `steered` + `mail` records, a cancelled agent gets an `agent`
 * event, and a cancelled RUN writes `result.json` and takes the control socket down —
 * which is what makes the run terminal for `deriveRunState`, and therefore resumable and
 * deletable, without this test ever telling the viewer so.
 */
const walk = {
  answered: null as unknown,
  sends: [] as { agent: unknown; message: unknown }[],
  cancelledAgents: [] as unknown[],
  cancelledRun: false,
}
/** The spawns the resume route asked for — the one seam (see `beforeAll`). */
const spawns: { args: string[] }[] = []
const resumeSpawned = (() => {
  let resolve!: (spawn: { args: string[] }) => void
  const promise = new Promise<{ args: string[] }>((done) => { resolve = done })
  return { promise, resolve }
})()

function withDeadline<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeout)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}
/**
 * The walk run's HEARTBEAT, written the way a real engine writes one (src/run-state.js's
 * `.heartbeat`, refreshed while the engine lives).
 *
 * It is not decoration. `deriveRunState` probes the control socket with a 300 ms budget
 * (CONTROL_TIMEOUT_MS) and this test's viewer server shares one thread with jsdom and
 * React, so a commit that takes longer than that makes a perfectly live run read `stale` —
 * an artefact of the harness, not of the product. A real engine's heartbeat is exactly the
 * event-loop-independent liveness signal §5.4.2 relies on for this, so the fake engine
 * writes one too, and stops the instant the run is cancelled.
 */
let walkBeat: ReturnType<typeof setInterval> | null = null
const stopWalkEngine = (dir: string) => {
  if (walkBeat) { clearInterval(walkBeat); walkBeat = null }
  try { fs.unlinkSync(path.join(dir, '.heartbeat')) } catch { /* already gone */ }
  walkControl?.close()
  walkControl = null
  try { fs.unlinkSync(path.join(dir, 'control.sock')) } catch { /* already gone */ }
}

// ---- run directories on disk --------------------------------------------------------

const appendLine = (file: string, record: unknown) => {
  fs.appendFileSync(file, JSON.stringify(record) + '\n')
}

/** A run directory `deriveRunState` and the summaries reader both recognise. */
function seedRun(runId: string, { events = [] as unknown[], result = null as unknown }) {
  const dir = path.join(RUNS, runId)
  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'journal.jsonl'),
    JSON.stringify({ type: 'meta', runId, workflowFile: `${runId}.workflow.js`, createdAt: 1 }) + '\n',
  )
  fs.writeFileSync(path.join(dir, 'events.jsonl'), '')
  for (const event of events) appendLine(path.join(dir, 'events.jsonl'), event)
  if (result) fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result))
  return dir
}

/**
 * The engine's half of the control protocol (src/engine.js:674–730), including the part
 * that matters most here: an accepted `answer` is JOURNALLED AND EMITTED. Without that
 * emission the answer would exist only in this test's memory and the viewer would keep
 * serving a blocked run forever — which is precisely the reconciliation the acceptance
 * criterion is about.
 */
const engineHandler = (dir: string) => async (req: { cmd: string; qid?: string; value?: unknown }) => {
  switch (req.cmd) {
    case 'status':
      return {
        ok: true,
        runId: ASK_RUN,
        state: 'running',
        agents: [],
        questions: answered.length ? [] : [{ qid: 'q0', question: QUESTION }],
        spentOutputTokens: 0,
      }
    case 'answer': {
      if (req.qid !== 'q0') return { error: `no pending question "${req.qid}"` }
      if (answered.length) return { error: `no pending question "${req.qid}"` }
      answered.push({ qid: req.qid, value: req.value })
      appendLine(path.join(dir, 'events.jsonl'), {
        t: Date.now(), type: 'answer', qid: req.qid, value: req.value,
      })
      return { ok: true }
    }
    default:
      return { error: `unknown command "${req.cmd}"` }
  }
}

/**
 * The walkthrough run's engine. Same protocol, one difference from `engineHandler`: it
 * WRITES, so the run on disk changes state under the app as the operator drives it.
 */
const walkHandler = (dir: string) => {
  const events = path.join(dir, 'events.jsonl')
  return async (req: { cmd: string; agent?: unknown; qid?: string; value?: unknown; message?: unknown }) => {
    switch (req.cmd) {
      case 'status':
        return {
          ok: true,
          runId: WALK_RUN,
          state: 'running',
          agents: [],
          questions: walk.answered != null ? [] : [{ qid: 'wq0', question: WALK_QUESTION }],
          spentOutputTokens: 0,
        }
      case 'answer': {
        if (req.qid !== 'wq0' || walk.answered != null) return { error: `no pending question "${req.qid}"` }
        walk.answered = req.value
        appendLine(events, { t: Date.now(), type: 'answer', qid: req.qid, value: req.value })
        return { ok: true }
      }
      case 'send': {
        walk.sends.push({ agent: req.agent, message: req.message })
        const mailId = `wm${walk.sends.length}`
        // Both records the engine emits for an accepted steer (src/engine.js:696–697), so
        // the steering-history register and the agent's own steer marks are real data.
        appendLine(events, {
          t: Date.now(), type: 'agent', index: req.agent, state: 'steered',
          origin: 'operator', delivery: 'live', mailId,
        })
        appendLine(events, {
          t: Date.now(), type: 'mail', dir: 'in', agent: req.agent, message: req.message,
          origin: 'operator', delivery: 'live', mailId, callsite: 'viewer',
        })
        return { ok: true, delivery: 'live' }
      }
      case 'cancel': {
        // The N5 distinction the bridge builds two different requests for: an `agent` KEY
        // present is a per-agent cancel, absent is the whole run.
        if (Object.prototype.hasOwnProperty.call(req, 'agent')) {
          walk.cancelledAgents.push(req.agent)
          appendLine(events, { t: Date.now(), type: 'agent', index: req.agent, state: 'cancelled' })
          return { ok: true, cancelled: req.agent }
        }
        walk.cancelledRun = true
        appendLine(events, { t: Date.now(), type: 'run', state: 'interrupted' })
        fs.writeFileSync(
          path.join(dir, 'result.json'),
          JSON.stringify({ runId: WALK_RUN, status: 'interrupted', error: { message: 'cancelled from the viewer' } }),
        )
        // …and the engine exits: heartbeat, socket and all. That is what turns the run
        // terminal for every later `deriveRunState` — this test never says so directly.
        setTimeout(() => stopWalkEngine(dir), 10)
        return { ok: true, cancelled: 'run' }
      }
      default:
        return { error: `unknown command "${req.cmd}"` }
    }
  }
}

// ---- the browser's half of an HTTP request ------------------------------------------

const makeResponse = (status: number, body: string): Response => {
  if (typeof Response === 'function') {
    const empty = status === 204 || status === 205 || status === 304
    return new Response(empty ? null : body, { status })
  }
  // A jsdom without a `Response` constructor still has to answer the three things
  // api/client.ts asks a response: its status, whether it is ok, and its JSON.
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => JSON.parse(body),
    text: async () => body,
  } as Response
}

function installFetch() {
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init: RequestInit = {}) => {
    const target = typeof input === 'string' ? input : String((input as Request).url ?? input)
    const url = new URL(target, `http://127.0.0.1:${viewer.port}`)
    const headers: Record<string, string> = {
      ...(init.headers as Record<string, string> | undefined ?? {}),
      // The two a browser sets and a script may not.
      host: `127.0.0.1:${viewer.port}`,
      origin: `http://127.0.0.1:${viewer.port}`,
    }
    const body = init.body == null ? null : String(init.body)
    if (body != null) headers['content-length'] = String(Buffer.byteLength(body))

    return new Promise<Response>((resolve, reject) => {
      const abort = () => {
        const error = new Error('aborted')
        error.name = 'AbortError'   // api/client.ts rethrows this instead of "unreachable"
        reject(error)
      }
      if (init.signal?.aborted) { abort(); return }
      const req = http.request(
        {
          host: '127.0.0.1',
          port: viewer.port,
          method: init.method ?? 'GET',
          path: url.pathname + url.search,
          headers,
        },
        (res) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (chunk) => { data += chunk })
          res.on('end', () => resolve(makeResponse(res.statusCode ?? 0, data)))
        },
      )
      req.on('error', (err) => reject(err))
      init.signal?.addEventListener('abort', () => { req.destroy(); abort() })
      if (body != null) req.write(body)
      req.end()
    })
  }) as typeof fetch
  return () => { globalThis.fetch = original }
}

let restoreFetch: () => void

/**
 * The other half of the browser this environment does not have: `EventSource`.
 *
 * jsdom implements none, and without one the run store's fold is seeded once and never
 * fed again — run-level state still arrives on the 10 s poll, but nothing AGENT-level
 * does, because §5.6's stream is the only thing that carries it. The walkthrough below
 * asserts exactly that class of transition (a cancelled agent's composer refusing the
 * next steer), so the choice is between asserting it against a stub and supplying the
 * standard client the product is written against.
 *
 * This is the standard client, minimally: one GET, `text/event-stream`, frames split on a
 * blank line, `event:`/`data:`/`id:` fields, and `open`/`error`/named-event dispatch. It
 * adds nothing and hides nothing — the URL (including §7.1.2's `?token=`, the one place a
 * token may ride a query string, because an EventSource cannot set headers), the cursor
 * and the reconnect policy are all the app's own. It does not auto-reconnect; the client
 * in `api/sse.ts` owns retry itself and treats `error` as the trigger.
 */
class NodeEventSource {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 2
  readyState = 0
  private listeners = new Map<string, Set<(event: unknown) => void>>()
  private req: http.ClientRequest
  private res: http.IncomingMessage | null = null

  constructor(raw: string) {
    liveSources.add(this)
    const url = new URL(raw, `http://127.0.0.1:${viewer.port}`)
    this.req = http.request(
      {
        host: '127.0.0.1',
        port: viewer.port,
        method: 'GET',
        path: url.pathname + url.search,
        headers: {
          host: `127.0.0.1:${viewer.port}`,
          origin: `http://127.0.0.1:${viewer.port}`,
          accept: 'text/event-stream',
        },
      },
      (res) => {
        this.res = res
        res.setEncoding('utf8')
        if (res.statusCode !== 200) {
          res.resume()
          this.fail()
          return
        }
        this.readyState = NodeEventSource.OPEN
        this.emit('open', {})
        let buffer = ''
        res.on('data', (chunk: string) => {
          buffer += chunk
          for (;;) {
            const end = buffer.indexOf('\n\n')
            if (end < 0) break
            const frame = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            this.dispatch(frame)
          }
        })
        res.on('end', () => this.fail())
        res.on('error', () => this.fail())
      },
    )
    this.req.on('error', () => this.fail())
    this.req.end()
  }

  private fail() {
    if (this.readyState === NodeEventSource.CLOSED) return
    this.readyState = NodeEventSource.CLOSED
    this.emit('error', {})
  }

  private dispatch(frame: string) {
    let type = 'message'
    let data: string | null = null
    let id: string | undefined
    for (const line of frame.split('\n')) {
      if (!line || line.startsWith(':')) continue          // keepalive / comment
      const colon = line.indexOf(':')
      const field = colon < 0 ? line : line.slice(0, colon)
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
      if (field === 'event') type = value
      else if (field === 'data') data = data == null ? value : `${data}\n${value}`
      else if (field === 'id') id = value
    }
    if (data == null && type === 'message') return
    this.emit(type, { data: data ?? '', lastEventId: id ?? '' })
  }

  private emit(type: string, event: unknown) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event)
  }

  addEventListener(type: string, listener: (event: never) => void) {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener as (event: unknown) => void)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: (event: never) => void) {
    this.listeners.get(type)?.delete(listener as (event: unknown) => void)
  }

  close() {
    liveSources.delete(this)
    this.readyState = NodeEventSource.CLOSED
    this.listeners.clear()
    try { this.res?.destroy() } catch { /* already gone */ }
    try { this.req.destroy() } catch { /* already gone */ }
  }
}
const liveSources = new Set<NodeEventSource>()

beforeAll(async () => {
  fs.mkdirSync(DIST, { recursive: true })
  fs.writeFileSync(path.join(DIST, 'index.html'), '<!doctype html><title>flowition</title>')
  fs.mkdirSync(RUNS, { recursive: true })

  const askDir = seedRun(ASK_RUN, {
    events: [
      { t: 1, type: 'run', state: 'started' },
      { t: 2, type: 'question', qid: 'q0', question: QUESTION, runId: ASK_RUN },
    ],
  })
  seedRun(DEL_RUN, {
    events: [{ t: 1, type: 'run', state: 'started' }, { t: 3, type: 'run', state: 'completed' }],
    result: { runId: DEL_RUN, status: 'completed', result: { ok: true } },
  })

  // §12.1 item 5's run: two agents running, one open question, a real transcript per agent.
  const walkDir = seedRun(WALK_RUN, {
    events: [
      { t: 1, type: 'run', state: 'started' },
      { t: 2, type: 'agent', index: 0, state: 'queued', key: 'a0', label: 'auditor', adapter: 'mock', model: 'mock-1' },
      { t: 3, type: 'agent', index: 0, state: 'running' },
      { t: 4, type: 'agent', index: 1, state: 'queued', key: 'a1', label: 'reviewer', adapter: 'mock', model: 'mock-1' },
      { t: 5, type: 'agent', index: 1, state: 'running' },
      { t: 6, type: 'question', qid: 'wq0', question: WALK_QUESTION, runId: WALK_RUN },
    ],
  })
  for (const index of [0, 1]) {
    appendLine(path.join(walkDir, 'agents', `${index}.jsonl`), {
      t: 3, type: 'text', text: `agent ${index} is working`,
    })
  }

  const server = serveControl(path.join(askDir, 'control.sock'), engineHandler(askDir))
  await server.ready
  control = server

  const walkServer = serveControl(path.join(walkDir, 'control.sock'), walkHandler(walkDir))
  await walkServer.ready
  walkControl = walkServer
  const beat = () => fs.writeFileSync(path.join(walkDir, '.heartbeat'), String(Date.now()))
  beat()
  walkBeat = setInterval(beat, 1000)
  walkBeat.unref?.()

  viewer = await startViewer({
    port: 0,
    distRoot: DIST,
    control: true,
    // THE ONE SEAM, and the same one test/viewer-control.test.js takes: §7.3's resume
    // spawns `flowition resume` DETACHED, and a test that let it really spawn would be
    // asserting against a second process's race with this one rather than against the
    // route. Everything else in the handler — the state gate, the journal-meta gate, the
    // `.resuming` handoff marker, the audit lines, the 202 — is the shipped code.
    handlers: {
      resume: (ctx: object, ...rest: unknown[]) => (HANDLERS as never as {
        resume: (ctx: object, ...rest: unknown[]) => unknown
      }).resume(
        { ...ctx, spawnFn: (_bin: string, args: string[]) => {
          const spawned = { args }
          spawns.push(spawned)
          resumeSpawned.resolve(spawned)
          return { unref: () => {}, on: () => {}, pid: 4242 }
        } },
        ...rest,
      ),
    },
  } as never) as Viewer
  restoreFetch = installFetch()
  ;(globalThis as { EventSource?: unknown }).EventSource = NodeEventSource
}, process.env.CI ? 90_000 : 30_000)

afterAll(async () => {
  restoreFetch?.()
  for (const source of [...liveSources]) source.close()
  delete (globalThis as { EventSource?: unknown }).EventSource
  control?.close()
  stopWalkEngine(path.join(RUNS, WALK_RUN))
  await viewer?.close()
  fs.rmSync(HOME, { recursive: true, force: true })
  if (PRIOR_HOME === undefined) delete process.env.FLOWITION_HOME
  else process.env.FLOWITION_HOME = PRIOR_HOME
})

/** The URL the CLI prints, for a route — tokens in the fragment, exactly as §2.2 has it. */
const bootUrl = (route = '/') => {
  const url = new URL(viewer.url)
  const hash = `#${route}?t=${encodeURIComponent(viewer.token)}`
    + (viewer.controlToken ? `&c=${encodeURIComponent(viewer.controlToken)}` : '')
  url.hash = hash
  return url.hash
}

const mountApp = (route = '/') => {
  window.location.hash = bootUrl(route)
  resetRouteForTests()
  return render(<App />)
}

const SLOW = { timeout: WAIT_WINDOW_MS, interval: WAIT_INTERVAL_MS }

/**
 * Keyboard activation OF WHATEVER HAS FOCUS. It takes no target, on purpose.
 *
 * Round 10 rejected the previous shape — `press(element)` dispatched the keydown and the click
 * straight AT a supplied node, so the two lifecycle modals were "pressed" on their destructive
 * confirmation while focus was still sitting on the dialog's safe default. That passes whether
 * or not a keyboard operator can reach the button at all, which is the one thing §12.1 item 9
 * and §3.6's "every action reachable without a pointer" are about. With no target argument
 * there is nowhere to cheat: the control has to be tabbed to first, and an unreachable one
 * throws out of `tabTo` rather than going green.
 *
 * A browser turns Enter/Space on a focused button into a click; jsdom does not, so both halves
 * are fired at `document.activeElement`.
 *
 * **What this suite proves, and what it does not.** See `tab()` below: inside a modal, Tab is
 * REAL — the event is dispatched and the shipped containment handler moves focus. Outside one,
 * jsdom's user agent has no sequential focus navigation at all, so the next stop is resolved by
 * the same library's tabbable tree walker. The residue that genuinely needs a browser — the user
 * agent's own navigation, layout-based visibility, `inert`, and the axe scan — is W13's
 * Playwright + axe suite (DESIGN §16.5, §3.6's "Verified in W13", and §12's W13 row).
 */
const press = (key = 'Enter') => {
  const element = document.activeElement
  if (!element || element === document.body) {
    throw new Error('press() with nothing focused — tab to the control first')
  }
  fireEvent.keyDown(element, { key })
  if (key === 'Enter' || key === ' ') fireEvent.click(element)
}
const focused = () => document.activeElement as HTMLElement

/** The innermost open modal surface — the palette can chain into a confirmation. */
const openDialog = (): HTMLElement | null => {
  const dialogs = [...document.querySelectorAll<HTMLElement>('[data-dialog]')]
  return dialogs[dialogs.length - 1] ?? null
}

/**
 * §3.6's "no positive tabindex", checked on EVERY Tab rather than once.
 *
 * It is not a stylistic rule here, it is this file's licence to reason about tab order at all.
 * HTML's sequential focus navigation order is TREE ORDER for every element whose tabindex is
 * 0/auto, and a single positive value hoists that element into a separate earlier group — at
 * which point document order and browser tab order part company and the walker below stops
 * being a faithful model. So the precondition is enforced, not assumed, and a regression that
 * introduced `tabindex="1"` anywhere in the shipped tree would fail this walkthrough.
 */
const noPositiveTabindex = () => {
  const offender = [...document.querySelectorAll('[tabindex]')]
    .find((el) => Number(el.getAttribute('tabindex')) > 0)
  if (offender) {
    throw new Error(
      `§3.6 forbids a positive tabindex; found tabindex="${offender.getAttribute('tabindex')}" on `
      + `<${offender.tagName.toLowerCase()}> "${offender.textContent?.slice(0, 40)}" — with one `
      + 'present, document order is no longer the browser\'s tab order and this walk is invalid',
    )
  }
}

/**
 * The browser's other half of the keyboard, for the same reason `press` exists — and, like
 * `press`, it takes no target, so an unreachable control fails instead of going green.
 *
 * It exists so the §12.1 walkthrough can CONTINUE FROM the position the app handed it rather
 * than calling `.focus()` on the control it wants next. `steer.focus()` asserts nothing about
 * where the operator was; tabbing from the heading a ⌘K jump landed on, and arriving at the
 * composer, asserts both that the hand-off happened and that the composer is reachable from
 * it without a pointer (§2.7, §3.6).
 *
 * **Two mechanisms, and the difference between them matters.**
 *
 * 1. INSIDE A MODAL, THIS IS A REAL TAB. `@react-aria/focus`'s containment installs a
 *    `keydown` listener on the DOCUMENT (react-aria FocusScope.mjs, `useFocusContainment`),
 *    and jsdom dispatches and bubbles keyboard events perfectly well — so the event fired
 *    here reaches the shipped handler, which runs its own `getFocusableTreeWalker`, wraps at
 *    the scope's sentinels, calls `preventDefault()` and moves focus. That is the same code
 *    path, byte for byte, that a browser runs when the operator presses Tab inside one of
 *    §7.2's confirmations: focus moving from "Keep running" to "Cancel run" below is the
 *    product's own containment doing it, not this file modelling it. If it ever stopped
 *    handling the key, nothing would move and the throw below names the dialog.
 *
 * 2. OUTSIDE ONE, jsdom has no sequential focus navigation of its own to run — that part of
 *    the user agent simply is not implemented — so the next stop is resolved by the SAME
 *    library's tabbable tree walker over the document, which is HTML's tab order given
 *    `noPositiveTabindex()` above. This is a model, and it is the honest boundary of this
 *    file: it proves the shipped DOM's tab ORDER reaches the control, not that a real user
 *    agent's navigation does. §16.5 assigns that proof — plus layout-based visibility,
 *    `inert`, and the axe scan — to W13's Playwright suite, and §3.6 says the same
 *    ("Verified in W13").
 */
/**
 * Which of the two mechanisms moved focus on the last `tab()` — so a site that means to assert
 * REAL containment can say so, instead of trusting that the fallback did not quietly take over.
 */
let lastTab: 'shipped-containment' | 'modelled-tree-order' | null = null

const tab = (): HTMLElement | null => {
  noPositiveTabindex()
  const from = (document.activeElement as HTMLElement | null) ?? document.body
  // (1) the real key, at the real focus position.
  fireEvent.keyDown(from, { key: 'Tab' })
  if (document.activeElement !== from) {
    lastTab = 'shipped-containment'
    return document.activeElement as HTMLElement
  }

  // Nothing moved. If a modal is up, that is a CONTRACT FAILURE, not a jsdom gap: `aria-modal`
  // is a promise about Tab that only `<FocusScope contain>` keeps, so the walk stops here
  // rather than quietly falling through to the page behind the modal — a route no browser
  // offers and the exact cheat round 10 rejected.
  const dialog = openDialog()
  if (dialog) {
    throw new Error(
      `Tab inside the open "${dialog.dataset.dialog}" dialog moved focus nowhere — `
      + '@react-aria/focus containment (§3.6, Dialog.tsx) did not handle the key',
    )
  }

  // (2) the modelled half, over the whole document.
  const walker = getFocusableTreeWalker(document.body, { tabbable: true })
  walker.currentNode = from.isConnected ? from : document.body
  let next = walker.nextNode() as HTMLElement | null
  if (!next) {                                   // end of the document: wrap, as a browser does
    walker.currentNode = document.body
    next = walker.nextNode() as HTMLElement | null
  }
  lastTab = 'modelled-tree-order'
  next?.focus()
  return next
}

/**
 * The tab RING at this instant: inside a modal it is the modal's, because that is all Tab can
 * reach. Computed with the shipped library's own tabbable walker — the same one the
 * containment handler uses — so `expect(tabStops()).toEqual([keep, danger])` names the ring
 * the product would actually offer rather than a `querySelectorAll` this test invented.
 */
const tabStops = (): HTMLElement[] => {
  noPositiveTabindex()
  const walker = getFocusableTreeWalker(openDialog() ?? document.body, { tabbable: true })
  const stops: HTMLElement[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) stops.push(node as HTMLElement)
  return stops
}

/** Tab until `wanted` has focus. Fails with the position it gave up on, not a timeout. */
const tabTo = (wanted: HTMLElement, what: string): HTMLElement => {
  for (let i = 0; i < 200; i++) {
    const next = tab()
    if (next === wanted) return next
    if (next == null) break
  }
  throw new Error(
    `Tab never reached ${what}; focus ended on ${focused()?.tagName} `
    + `"${focused()?.textContent?.slice(0, 40)}"`,
  )
}

describe('§12.1 item 5 — a live viewer, end to end', () => {
  it('answers an ask() in TWO CLICKS from Home, and the question comes back answered', async () => {
    mountApp('/')

    // The card is real data: Home scanned the active runs, found one with an open
    // question, and fetched the question text. The composer enables only once the session
    // route has granted `answer` (§7.2) — so waiting for it is waiting for the whole
    // capability bootstrap, not for a mock.
    // Scoped to THIS run's card: the §12.1 walkthrough below seeds a second blocked run,
    // and an unscoped query would answer whichever card the strip happened to sort first.
    const askCard = (await screen.findByText(QUESTION, {}, SLOW)).closest('.acard') as HTMLElement
    const box = within(askCard).getByLabelText('Answer the question') as HTMLInputElement
    await waitFor(() => expect(box.disabled).toBe(false), SLOW)

    let clicks = 0
    const click = (element: Element) => { clicks += 1; fireEvent.click(element) }

    click(box)                                              // click 1: into the composer
    fireEvent.change(box, { target: { value: 'keep the shim' } })
    click(within(askCard).getByRole('button', { name: /Send/ }))  // click 2: Send

    // It crossed the wire: `api.answer` → POST /api/runs/r-ask/answer (bearer token,
    // control token, same-origin) → the route table → the control bridge → the socket.
    await waitFor(() => expect(answered).toEqual([{ qid: 'q0', value: 'keep the shim' }]), SLOW)
    expect(clicks).toBe(2)

    // …and the SCREEN reconciles. The engine recorded the answer in the run's event
    // stream, so the next poll of the listing reports no open question and the ask card —
    // the composer, the question text and all — leaves the queue on its own.
    await waitFor(() => expect(screen.queryByText(QUESTION)).toBeNull(), SLOW)

    // Not merely optimistic: the read the app itself makes now says the question is
    // answered, through the same client, the same token and the same server.
    const detail = await api.runDetail(ASK_RUN)
    const question = detail.questions?.find((q) => q.qid === 'q0')
    expect(question?.answered).toBe(true)
    expect(detail.openQuestions ?? 0).toBe(0)
  }, process.env.CI ? 120_000 : 40_000)

  it('delete: focus lands on Home’s heading, never on the deleted run’s opener (§3.6)', async () => {
    mountApp(`/run/${DEL_RUN}`)

    // The opener is the cockpit header's own Delete — the button §7.2 puts there, and the
    // one the successful mutation is about to unmount along with the rest of the run's
    // page.
    const opener = await screen.findByRole('button', { name: /^Delete$/ }, SLOW)
    await waitFor(() => expect(opener.getAttribute('aria-disabled')).toBe('false'), SLOW)
    fireEvent.click(opener)

    const dialog = await screen.findByRole('dialog', {}, SLOW)
    const typed = within(dialog).getByLabelText(/to confirm/) as HTMLInputElement
    fireEvent.change(typed, { target: { value: DEL_RUN } })
    fireEvent.click(within(dialog).getByRole('button', { name: /Delete run/ }))

    // The run is really gone — retention moved it to the trash, on disk.
    await waitFor(() => expect(fs.existsSync(path.join(RUNS, DEL_RUN))).toBe(false), SLOW)

    // Home took over, and so did focus: the operator's keyboard position is Home's own
    // heading, NOT `<body>` and not a detached node from the page that was deleted.
    const landing = await waitFor(
      () => {
        const el = document.querySelector('[data-landing="home"]')
        expect(el).not.toBeNull()
        expect(document.activeElement).toBe(el)
        return el
      },
      SLOW,
    )
    expect(landing?.textContent).toBe('Runs')
    expect(document.activeElement).not.toBe(document.body)
    expect(opener.isConnected).toBe(false)
  }, process.env.CI ? 120_000 : 40_000)
})

/**
 * §12.1 item 5, AS ONE SESSION — the walkthrough the review panel performs by hand.
 *
 * Round 3 covered every step of this criterion and covered none of the SEAMS between them:
 * answer, steer, agent-cancel, run-cancel, resume and delete each had their own render,
 * their own fresh mocks and their own fixture frozen in the state that step needed. That
 * arrangement can be entirely green while the product is broken end to end — the run never
 * changes state, so nothing ever proves that cancelling the run is what makes Resume
 * appear, that resuming is what makes Delete refuse, or that the operator's keyboard
 * position survives six route changes and four modals (round-3 finding B2).
 *
 * So: ONE `render(<App/>)`, ONE run, ONE engine whose replies and whose files change as it
 * is driven, and no seam except the resume spawn (see `beforeAll`). The run travels
 *
 *   running + blocked  →(answer)→  running  →(steer)→  steered  →(cancel agent 0)→
 *   half-cancelled  →(cancel run)→  interrupted  →(resume)→  starting  →(the launch
 *   bounces)→  interrupted  →(delete)→  a trash entry on disk
 *
 * and every transition is asserted from BOTH sides: what the engine was actually asked, and
 * what the UI then offered the operator.
 */
describe('§12.1 item 5 — one session, one run, from blocked to trashed', () => {
  /**
   * SELF-CONTAINMENT (review round 6, B3).
   *
   * This walk starts from a cold Home and presses `a`, whose §2.7 contract is "focus the
   * FIRST open question's answer box". Home therefore has to have exactly one — and round 5's
   * version got that by accident, from the two-click test above having answered `r-ask`
   * moments earlier. Run alone (`-t 'one session'`), `a` correctly focused `ans-r-ask` and
   * this test failed on its first assertion: an order-dependent green is not the §12.1
   * walkthrough it claims to be.
   *
   * So the walk states its own precondition instead of inheriting it: `r-ask`'s question is
   * settled before the first render, through the engine's own answer path (the record in the
   * run's event stream, which is what makes a question answered for every later read) and the
   * same in-memory state its `status` replies come from. Idempotent — when the test above HAS
   * run, `answered` is already non-empty and this does nothing.
   */
  beforeAll(() => {
    if (answered.length) return
    answered.push({ qid: 'q0', value: 'settled before the walkthrough' })
    appendLine(path.join(RUNS, ASK_RUN, 'events.jsonl'), {
      t: Date.now(), type: 'answer', qid: 'q0', value: 'settled before the walkthrough',
    })
  })

  const openPalette = () => {
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    return screen.getByRole('combobox') as HTMLInputElement
  }

  /**
   * ⌘K, type, wait for the intended row to be first, ↵. Pointer never touches this.
   *
   * `kind` is not decoration: every row this walkthrough activates is about `r-walk`, so the
   * run's own row and the three lifecycle ACTIONS on it ("Resume run r-walk", …) all match a
   * text query for the id. Matching on text alone made this test activate whichever of them
   * happened to rank first that run — it caught Resume instead of the jump once the cancel had
   * made the run resumable, and then waited 20 s for a cockpit behind an open modal. The row's
   * own class carries §2.7's three kinds, so the assertion says which one it means.
   */
  const paletteRun = async (query: string, expected: RegExp, kind: 'run' | 'agent' | 'action') => {
    const search = openPalette()
    fireEvent.change(search, { target: { value: query } })
    // The row has to be BOTH the match and enabled before ↵: the palette takes its snapshot
    // when it opens, so a row can be a moment behind the run it is about.
    await waitFor(() => {
      const row = screen.getAllByRole('option')[0]
      expect(row?.textContent ?? '').toMatch(expected)
      expect(row?.classList.contains(kind), `first row is ${row?.className}, not a ${kind}`).toBe(true)
      expect(row?.getAttribute('aria-disabled')).toBeNull()
    }, SLOW)
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' })
    // DOM queries, not role queries: an open modal `aria-hidden`s the page, so a role query
    // cannot tell "the palette closed" from "something else is covering it".
    await waitFor(() => expect(document.querySelector('[data-dialog="palette"]')).toBeNull())

  }

  /**
   * Where a ⌘K jump must leave the operator (§2.7 + §3.6): on the destination's own heading.
   *
   * Round 3 had no assertion here at all, and the defect that hid behind the omission is
   * specific: the palette closes and navigates in ONE handler, so §3.6's restore aims at the
   * opener on the route being left, focus lands on a node that unmounts a tick later, and the
   * operator ends the jump on `<body>` — every subsequent keystroke going nowhere. Every jump
   * in this walkthrough now proves the hand-off, and continues by Tab FROM it.
   */
  const landedOn = async (kind: 'run' | 'agent', index?: number) => {
    const node = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('[data-destination]')].find(
        (el) => el.dataset.destination === kind && el.dataset.run === WALK_RUN
          && (kind === 'run' || el.dataset.agent === String(index)),
      )
      expect(found, `no ${kind} destination heading for ${WALK_RUN}`).toBeTruthy()
      const here = document.activeElement as HTMLElement | null
      expect(
        here,
        `focus is on <${here?.tagName.toLowerCase()} class="${here?.className}">`
        + ` "${here?.textContent?.slice(0, 40)}" rather than the ${kind} heading`,
      ).toBe(found)
      return found!
    }, SLOW)
    expect(document.activeElement).not.toBe(document.body)
    return node
  }

  const statusText = async () =>
    (await screen.findAllByRole('status', {}, SLOW)).map((node) => node.textContent ?? '')

  it('answers, steers, cancels an agent, cancels the run, resumes it, and trashes it', async () => {
    mountApp('/')

    // ---- 1. answer an ask() — KEYBOARD ONLY, from Home (§12.1 item 5 × item 9) ---------
    //
    // The ≤2-click Home path is the test above; this walk is §12.1 item 9's keyboard-only
    // one, and round 4's version started it by clicking the input and the Send button — the
    // two things a keyboard operator never touches. §2.7's `a` ("focuses the first open
    // question's answer box") is the shortcut that has to carry them into the composer from
    // a cold Home, and ⌘↵ is what sends. The pointer is not used again in this test.
    const card = (await screen.findByText(WALK_QUESTION, {}, SLOW)).closest('.acard') as HTMLElement
    const box = within(card).getByLabelText('Answer the question') as HTMLInputElement
    await waitFor(() => expect(box.disabled).toBe(false), SLOW)

    // Focus is on nothing in particular — the operator has just loaded Home.
    ;(document.activeElement as HTMLElement | null)?.blur()
    fireEvent.keyDown(window, { key: 'a' })
    // §2.7's promise, kept: FIRST open question. The other seeded ask run is settled by this
    // suite's own `beforeAll` (see above), so the first — and only — open question on this
    // screen is this one, whether or not the tests above ran.
    expect(
      focused(),
      `\`a\` focused <${focused()?.tagName.toLowerCase()} class="${focused()?.className}">`
      + ' rather than the walk run’s answer composer',
    ).toBe(box)
    fireEvent.change(box, { target: { value: 'the mock adapter' } })
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })

    // It crossed the wire the same way the clicked one does: api.answer → the route table →
    // the control bridge → this run's socket. (§7.2's in-flight grey state is not asserted
    // here — against a real server the window is a race; `home.test.tsx` pins it against a
    // request that never resolves.)
    await waitFor(() => expect(walk.answered).toBe('the mock adapter'), SLOW)
    // The engine journalled it, so the card leaves the queue on the next read — not because
    // this test told the screen anything.
    await waitFor(() => expect(screen.queryByText(WALK_QUESTION)).toBeNull(), SLOW)

    // ---- 2. into the run, by keyboard ------------------------------------------------
    await paletteRun(WALK_RUN, new RegExp(WALK_RUN), 'run')
    await screen.findByRole('tablist', {}, SLOW)
    expect(window.location.hash).toContain(`/run/${WALK_RUN}`)
    // …and the keyboard came with it: the cockpit's own heading has focus (§3.6), so the
    // operator is announced onto the run they asked for and Tab continues from its top.
    const runHeading = await landedOn('run')
    expect(runHeading.tagName).toBe('H1')
    expect((runHeading.textContent ?? '').trim().length).toBeGreaterThan(0)

    // §7.2's capability × lifecycle gating, on a LIVE run: cancel is offered, delete is not
    // (and says why rather than hiding).
    await waitFor(
      () => expect(screen.getByRole('button', { name: 'Cancel run' }).getAttribute('aria-disabled')).toBe('false'),
      SLOW,
    )
    const deleteButton = screen.getByRole('button', { name: /^Delete$/ })
    expect(deleteButton.getAttribute('aria-disabled')).toBe('true')
    expect(deleteButton.getAttribute('title')).toMatch(/only a terminal run can be deleted/)

    // ---- 3. steer a running agent, and see the engine's own verdict -------------------
    await paletteRun('agent 0 auditor', /agent 0/, 'agent')
    // The jump landed on the transcript pane's own heading — and the composer is reached
    // from there by Tab, not by this test focusing it (see `tab` above).
    const agentHeading = await landedOn('agent', 0)
    expect(agentHeading.textContent).toContain('auditor')
    const steer = await screen.findByLabelText(/^Steer /, {}, SLOW) as HTMLInputElement
    await waitFor(() => expect(steer.disabled).toBe(false), SLOW)
    expect(focused()).toBe(agentHeading)
    tabTo(steer, 'the steer composer')
    fireEvent.change(steer, { target: { value: 'check the SSE endpoint for token leakage' } })
    fireEvent.keyDown(steer, { key: 'Enter', metaKey: true })

    await waitFor(() => expect(walk.sends).toEqual(
      [{ agent: 0, message: 'check the SSE endpoint for token leakage' }],
    ), SLOW)
    // §7.2: the verdict is the ENGINE's word, forwarded verbatim by the bridge — `live`
    // here, with the sentence that explains what it means.
    await waitFor(async () => {
      expect((await statusText()).some((text) => /live/.test(text))).toBe(true)
    }, SLOW)

    // ---- 4. cancel ONE agent, through §7.2's inline arm, keyboard only ----------------
    //
    // Still no `.focus()`: Tab continues from the composer that was just sent from, past the
    // now-disabled Send (the text was consumed), onto the Cancel beside it.
    const cancelAgent = screen.getByRole('button', { name: 'Cancel agent' })
    expect(focused()).toBe(steer)
    tabTo(cancelAgent, 'the per-agent Cancel')
    press()
    expect(walk.cancelledAgents).toEqual([])                          // armed, not fired
    // §7.2's confirmation names the CANONICAL INDEX — "Cancel agent 0?", not the label.
    const armed = screen.getByRole('button', { name: 'Cancel agent 0?' })
    expect(armed.textContent).toBe('Cancel agent 0?')
    // …and the ARM DID NOT MOVE THE KEYBOARD. §7.2's inline arm is a label swap on one button,
    // not a new control that appears somewhere else, so "press again within 3s" is a promise
    // about the key the operator's finger is already on. If the arm re-mounted the button the
    // operator would be dropped onto `<body>` mid-confirmation and the second press would go
    // nowhere — which is exactly the class of defect a `press(button)` call cannot see.
    expect(
      focused(),
      `arming moved focus to <${focused()?.tagName.toLowerCase()}`
      + ` class="${focused()?.className}"> instead of leaving it on the armed button`,
    ).toBe(armed)
    expect(screen.getByText(/Esc or wait to disarm/)).toBeTruthy()
    // The promise that hint makes, kept on the shipped surface: Escape disarms, and the
    // engine hears nothing. Escape goes to the focused element, like every other key here.
    press('Escape')
    const disarmed = screen.getByRole('button', { name: 'Cancel agent' })
    expect(focused()).toBe(disarmed)                                  // and back, still standing on it
    expect(walk.cancelledAgents).toEqual([])
    // …then the real one: armed again and confirmed, both presses on the FOCUSED element, with
    // the armed state asserted between them so the second Enter is provably aimed at the
    // destructive confirmation rather than at whatever this test could have looked up.
    press()
    const rearmed = screen.getByRole('button', { name: 'Cancel agent 0?' })
    expect(focused()).toBe(rearmed)
    press()
    await waitFor(() => expect(walk.cancelledAgents).toEqual([0]), SLOW)
    // §7.2's verdict, and it is a WAIT rather than a poll-until-lucky (round 4, item 12).
    // The fake engine writes the agent's `cancelled` event before it answers the request,
    // exactly as the real one does, so the settle can reach this client over the live feed
    // before the reply that produces the verdict. This assertion used to be able to lose
    // that race outright: the confirmation was rendered only while the agent was still
    // cancellable, so once the settle won there was nothing left for `waitFor` to find and
    // the 20s budget only made the failure slower. `CancelAgentButton` now keeps the
    // verdict in its refused branch (see `cancelConfirmation.test.tsx`), which is both the
    // operator-facing fix and what makes this line deterministic.
    await waitFor(async () => {
      expect((await statusText()).some((text) => /cancel sent/i.test(text))).toBe(true)
    }, SLOW)

    // The state transition, from the operator's chair — re-entered from the cockpit so
    // that what is asserted is the SERVER's snapshot of a run this session changed, not
    // the arrival time of a stream frame: the agent this composer belongs to has settled,
    // so the composer that worked two steps ago is now correctly refused, and says why.
    await paletteRun(WALK_RUN, new RegExp(WALK_RUN), 'run')
    await screen.findByRole('tablist', {}, SLOW)
    await landedOn('run')
    await paletteRun('agent 0 auditor', /agent 0/, 'agent')
    await landedOn('agent', 0)
    const settled = await screen.findByLabelText(/^Steer /, {}, SLOW) as HTMLInputElement
    await waitFor(() => expect(settled.disabled).toBe(true), SLOW)
    expect(screen.getByText(/this agent has settled/)).toBeTruthy()

    // ---- 5. cancel the RUN, through §7.2's modal ---------------------------------------
    await paletteRun('cancel run', /Cancel run/, 'action')
    const cancelDialog = await screen.findByRole('dialog', {}, SLOW)
    // §7.2: "default focus on Keep".
    const keepRunning = within(cancelDialog).getByRole('button', { name: 'Keep running' })
    expect(focused()).toBe(keepRunning)
    // …and the destructive one is REACHED from it, by Tab, inside the modal's own ring. Round
    // 10's finding was that this line used to fire at the button while focus sat on Keep, which
    // would be green even if Cancel run were unreachable without a pointer.
    const confirmCancel = within(cancelDialog).getByRole('button', { name: /^Cancel run/ })
    // The ring itself, named — so a `tabTo` that "arrived" only because the walker wandered
    // through the page behind the modal would fail here first.
    expect(tabStops()).toEqual([keepRunning, confirmCancel])
    tabTo(confirmCancel, 'the cancel modal’s “Cancel run”')
    expect(focused()).toBe(confirmCancel)
    // …and it was the PRODUCT that moved focus there: the Tab event reached
    // `@react-aria/focus`'s containment handler and it did the walk. Not a claim this file
    // can make about the page-level tabs above, and the difference is stated at `tab()`.
    expect(lastTab).toBe('shipped-containment')
    press()
    await waitFor(() => expect(walk.cancelledRun).toBe(true), SLOW)
    await waitFor(async () => {
      expect((await statusText()).some((text) => /Cancel sent to/.test(text))).toBe(true)
    }, SLOW)

    // ---- 6. resume it — and the run is only resumable BECAUSE it was cancelled ---------
    //
    // The engine wrote `result.json` and took its socket down, so the SERVER now derives a
    // terminal run. Waiting for that here rather than for the cockpit's 10 s poll to notice
    // keeps the wall clock honest: the next line re-enters the run, and a fresh mount reads
    // the state in one request.
    await waitFor(async () => {
      expect((await api.runDetail(WALK_RUN)).state).toBe('interrupted')
    }, SLOW)
    await paletteRun(WALK_RUN, new RegExp(WALK_RUN), 'run')
    await screen.findByRole('tablist', {}, SLOW)
    await landedOn('run')
    const resume = await waitFor(() => {
      const button = screen.getByRole('button', { name: /Resume/ })
      expect(button.getAttribute('aria-disabled')).not.toBe('true')
      return button
    }, SLOW)
    // Tab from the heading the jump handed over to, into the header's own actions.
    tabTo(resume, 'the header’s Resume')
    expect(focused()).toBe(resume)
    press()
    const resumeDialog = await screen.findByRole('dialog', {}, SLOW)
    // §7.3/§1.3's integrity scope, stated before the operator commits.
    expect(resumeDialog.textContent).toContain('installed packages')
    // Same walk as the cancel modal, and the same reason: the safe action is where the dialog
    // put the keyboard, and "Resume run" has to be reachable from it by Tab alone. The facts
    // list between them carries no tab stop, so this is one Tab in the shipped DOM — but the
    // walk asserts arrival rather than counting keystrokes.
    const leaveStopped = within(resumeDialog).getByRole('button', { name: 'Leave it stopped' })
    expect(focused()).toBe(leaveStopped)
    const confirmResume = within(resumeDialog).getByRole('button', { name: /Resume run/ })
    expect(tabStops()).toEqual([leaveStopped, confirmResume])
    tabTo(confirmResume, 'the resume modal’s “Resume run”')
    expect(focused()).toBe(confirmResume)
    expect(lastTab).toBe('shipped-containment')
    press()

    // The real route ran: the handoff marker is on disk and the detached CLI was asked for.
    // Wait on the spawn seam's event itself. Polling the shared array made this exact handoff
    // load-sensitive under the full suite: a delayed HTTP turn could consume the polling
    // deadline even though no product deadline had expired. The timer below is only a bounded
    // failure guard; it adds no sleep or polling latency to the successful path.
    const spawned = await withDeadline(
      resumeSpawned.promise,
      60_000,
      'resume route did not hand off to the detached CLI within 60 seconds',
    )
    expect(spawns).toHaveLength(1)
    expect(spawned.args.slice(1)).toEqual(['resume', WALK_RUN, '--json'])
    expect(spawned.args[0]).toMatch(/bin[/\\]flowition\.js$/)
    const marker = path.join(RUNS, WALK_RUN, '.resuming')
    expect(fs.existsSync(marker)).toBe(true)
    // §7.3/Sol-12: the 202 promises a LAUNCH, not an outcome, and the toast says so.
    await waitFor(async () => {
      expect((await statusText()).some((text) => /launch accepted, nothing more/.test(text))).toBe(true)
    }, SLOW)

    // …and while that launch is outstanding the run is `starting`, so §7.3 refuses to
    // delete it. This is the seam the separate-render tests could not have: the refusal is
    // caused by the resume the operator just performed.
    await waitFor(
      () => expect(screen.getByRole('button', { name: /^Delete$/ }).getAttribute('aria-disabled')).toBe('true'),
      SLOW,
    )

    // ---- 7. the launch bounces, and the run is deletable again ------------------------
    //
    // The spawn seam returns a stub, so no CLI ever starts — which is exactly what a
    // preflight-refused resume looks like from disk: the `.resuming` handoff simply ages
    // out of its 30 s budget (src/run-state.js:9) and the run reverts to the terminal state
    // it already had. Backdating the marker is this test standing in for that clock; it
    // goes through run-state.js's own aged-marker sweep rather than around it, which is why
    // BOTH the content stamp and the mtime are aged (either one young keeps it `starting`).
    const aged = Date.now() - 120_000
    fs.writeFileSync(marker, String(aged))
    fs.utimesSync(marker, new Date(aged), new Date(aged))
    // Let the server sweep it, and settle, before the UI is asked anything. The sweep is a
    // claim-rename-and-unlink (src/run-state.js), and two derivations racing over one aged
    // marker can transiently answer `starting` — a bounded, by-design fail-safe that this
    // test must not turn into a coin flip.
    await waitFor(async () => {
      expect((await api.runDetail(WALK_RUN)).state).toBe('interrupted')
    }, SLOW)
    await waitFor(() => expect(fs.existsSync(marker)).toBe(false), SLOW)

    // ---- 8. delete it by typing its id, and find it in the trash ----------------------
    //
    // From the PALETTE, which is §2.7's keyboard route to the same §7.3 dialog and takes a
    // fresh snapshot when it opens — so what gates the row is the run's state now, not the
    // cockpit's next poll. (The header's own Delete as the opener, and the focus hand-off
    // from it, is the test above.)
    await paletteRun('delete run', /Delete run/, 'action')

    const deleteDialog = await screen.findByRole('dialog', {}, SLOW)
    const typed = within(deleteDialog).getByLabelText(/to confirm/) as HTMLInputElement
    expect(focused()).toBe(typed)
    const confirm = within(deleteDialog).getByRole('button', { name: /Delete run/ }) as HTMLButtonElement
    const keepIt = within(deleteDialog).getByRole('button', { name: 'Keep it' })
    expect(confirm.disabled).toBe(true)
    // A disabled control is not a tab stop, so until the id matches the destructive button is
    // not merely refused — it is not in the operator's ring at all.
    expect(tabStops()).toEqual([typed, keepIt])
    fireEvent.change(typed, { target: { value: 'r-walk-almost' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(typed, { target: { value: WALK_RUN } })
    expect(confirm.disabled).toBe(false)
    // …and now it joins it, at the end, behind the safe action — the same §7.2 ordering the
    // two lifecycle modals above have, walked the same way: from where the dialog put the
    // keyboard, by Tab, to the destructive button, and Enter on whatever ended up focused.
    expect(tabStops()).toEqual([typed, keepIt, confirm])
    // Hop by hop, not tabTo(): the ring assertion above and a search-until-found walk
    // could share one instrumentation bug. Each Tab's landing is asserted, so a
    // containment regression that jumped input → destructive button cannot pass
    // (review flo_5b88769c: the safe action must be reached BEFORE the destructive one).
    expect(tab()).toBe(keepIt)
    expect(focused()).toBe(keepIt)
    expect(tab()).toBe(confirm)
    expect(focused()).toBe(confirm)
    expect(lastTab).toBe('shipped-containment')
    press()

    // THE trash entry, on the real filesystem (§7.3.4) — a rename into
    // `$FLOWITION_HOME/trash/<runId>.<epoch>`, with the run's artifacts intact inside it.
    // "The source directory vanished" is not the same claim and was all round 3 made.
    await waitFor(() => expect(fs.existsSync(path.join(RUNS, WALK_RUN))).toBe(false), SLOW)
    const trashed = fs.readdirSync(path.join(HOME, 'trash'))
      .filter((name) => name.startsWith(`${WALK_RUN}.`))
    expect(trashed.length).toBe(1)
    const entry = path.join(HOME, 'trash', trashed[0]!)
    expect(fs.existsSync(path.join(entry, 'journal.jsonl'))).toBe(true)
    // The whole walk is inside it: the answer, the steer and both cancels.
    const events = fs.readFileSync(path.join(entry, 'events.jsonl'), 'utf8')
    expect(events).toContain('"the mock adapter"')
    expect(events).toContain('check the SSE endpoint for token leakage')
    expect(events).toContain('"state":"interrupted"')

    // §7.3's copy, in the toast that OUTLIVES the dialog — it names the entry the operator
    // would have to go looking for, and how long they have.
    await waitFor(async () => {
      const texts = await statusText()
      expect(texts.some((text) => text.includes(trashed[0]!))).toBe(true)
      expect(texts.some((text) => /purged after 7 days/.test(text))).toBe(true)
    }, SLOW)

    // …and §3.6's one hand-off path: the opener was unmounted with the run, so focus lands
    // on Home's own heading rather than on `<body>`.
    await waitFor(() => {
      const landing = document.querySelector('[data-landing="home"]')
      expect(landing).not.toBeNull()
      expect(document.activeElement).toBe(landing)
    }, SLOW)
    expect(window.location.hash).not.toContain(WALK_RUN)
  }, process.env.CI ? 360_000 : 120_000)
})
