/**
 * §2.6 — the Result view (`#/run/:id/result`).
 *
 * "This entire screen exists because a run's product is otherwise the one thing a viewer
 * never shows." It renders `GET /api/runs/:id/result` (§5.4.5) and nothing else invents a value:
 *
 *   completed          → the result value. Strings are safe markdown with a RAW toggle;
 *                        everything else is §2.6's collapsible JSON tree with copy-subtree,
 *                        capped at depth 32 / 20,000 nodes with a raw download beyond either.
 *   over the 1 MiB cap → the server's bounded preview, labelled as a prefix, plus the
 *                        download (`resultTruncated` + `preview`, §5.4.5).
 *   failed/interrupted → the error, prominently, with a Resume button.
 *   cancelled, and any
 *   status this build
 *   does not know      → a NEUTRAL frame and a sentence of fact. Neither ending earned the
 *                        success green or the failure red, and §6.5 forbids folding an
 *                        unrecognized value into whichever branch happens to be the default
 *                        (see `FRAMING` below).
 *   pending            → the live state chip and "no result yet" — §5.4.5 answers 200, not
 *                        404, precisely because this is a normal state.
 *   corrupt            → `result.json` exists and does not parse. The engine writes it
 *                        tmp+rename (src/engine.js:604–608), so this is never a torn write
 *                        this viewer caught mid-flight; the screen says so and offers the
 *                        raw bytes.
 *
 * The one editorial decision the spec leaves open is what the screen says when the payload
 * carries a terminal `status` and no `result` key at all — a cancelled run, or an old run
 * whose engine wrote a different shape. It says exactly that, and does NOT print `null`:
 * §6.5's rule is that an absent field is an admitted absence, never a rendered value.
 */

import { useCallback, useEffect, useState } from 'react'

import { ApiError, api } from '../../api/client.js'
import type { ResultPayload, RunDetail, RunState } from '../../api/types.js'
import { usePoll } from '../../app/hooks.js'
import { href, navigate } from '../../app/router.js'
import { HardenedMarkdown } from '../../lib/markdown.js'
import { Icon } from '../../ui/Icon.js'
import { StatusChip } from '../../ui/Status.js'
import { LockChip } from '../control/Locked.js'
import { canOperate } from '../control/capabilities.js'
import { useControl } from '../control/ControlProvider.js'
import { JsonTree } from './JsonTree.js'
import { downloadRawResult } from './download.js'
import './result.css'

/** §7.3's resumable states. `completed` is a replay (Sol-12) and is deliberately included. */
const RESUMABLE = new Set<RunState>(['completed', 'failed', 'interrupted', 'stale'])

/**
 * The statuses `result.json` may carry that ARE run states.
 *
 * `deriveRunState` accepts exactly these three from the file and returns the status as the
 * run's state (src/run-state.js:10, 132–153). So a result payload whose `status` is one of
 * them is stating the run's terminal state definitively — it is the same field the server
 * reads — and the viewer may use it when the state is not otherwise known. Anything else
 * (`cancelled`, a future engine's word) is deliberately absent: the engine's own derivation
 * rejects it too, and inventing a state the server would refuse would render a Resume button
 * whose request is guaranteed to fail.
 */
const STATUS_AS_STATE = new Set<string>(['completed', 'failed', 'interrupted'])

/**
 * §6.5 + §3.2: which FRAME a status has earned, decided by an explicit table rather than by
 * a default.
 *
 * `result.json`'s `status` reaches this screen as an arbitrary string — §5.4.5 forwards the
 * file's field, and the file may have been written by an older engine, a newer one, or a
 * fleet tool. The shipped classification was binary (failed/interrupted/cancelled → red,
 * EVERYTHING ELSE → green), which meant any word this build does not know — a future
 * engine's `aborted`, a run that carried only an error — was painted as a success and told
 * the operator "the value below is result.json as the engine wrote it" about a file with no
 * value in it. That is the one degradation §6.5 forbids: an unrecognized value must be shown
 * and claimed nothing about, never folded into the friendliest branch.
 *
 *   ok       `completed`, and nothing else. Green asserts the workflow returned.
 *   failed   `failed` and `interrupted` — §3.2's failure semantics: the run stopped and
 *            something went wrong.
 *   neutral  `cancelled` (an operator's decision — nothing failed, and §3.2 gives it
 *            `--st-cancelled`, an ink mix, not the red the shipped frame painted it) and
 *            every status this build does not recognize.
 */
type Framing = 'ok' | 'failed' | 'neutral'

const FRAMING: Readonly<Record<string, Framing>> = {
  completed: 'ok',
  failed: 'failed',
  interrupted: 'failed',
  cancelled: 'neutral',
}

const framingFor = (status: string): Framing => FRAMING[status] ?? 'neutral'

/**
 * How much of a status word this screen will PAINT. §3.3 caps the result column at 1040px
 * and the framing prose at 88ch; `payload.status` is `result.json`'s field forwarded
 * verbatim by §5.4.5, so it is bounded only by the file — a future engine's long word, or a
 * hostile one, reaches the header chip (`white-space: nowrap`, no shrink) and the framing
 * sentence at full length and pushes the run id and the Cockpit control out of the row.
 *
 * Thirty-two characters is longer than every status any engine has ever written
 * (`interrupted`, 11) with room for a compound future one, and short enough that the chip
 * still fits the header beside the title at 1280px.
 */
export const MAX_STATUS_DISPLAY = 32

/**
 * Everything that can turn a one-word status into a layout: C0/C1 controls and the Unicode
 * line/paragraph separators (which would break the chip across lines), the bidi embeddings,
 * overrides and isolates in `Cf` (which reorder the row around it), and the zero-width and
 * invisible-formatting characters (which pad it without appearing). Same closed set the
 * live-region identifier sanitizer uses, for the same reason: data may fill a slot, never
 * reshape the thing around it.
 */
const UNRENDERABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu

/**
 * The status, made safe to LAY OUT. Display only — classification (`framingFor`,
 * `TERMINAL_WITHOUT_VALUE`, `STATUS_AS_STATE`) always reads the raw field, so a clipped word
 * can never be mistaken for a shorter one this build knows, and the untouched bytes stay one
 * click away behind **Download raw** (§2.6). Only a bounded PREFIX is examined, so a 1 MiB
 * status costs a fixed amount of work per render rather than a scan of the file.
 */
export function displayStatus(raw: unknown): string {
  if (typeof raw !== 'string') return 'unknown'
  const flat = raw.slice(0, MAX_STATUS_DISPLAY * 8).replace(UNRENDERABLE, ' ').replace(/\s+/g, ' ').trim()
  if (!flat) return 'unknown'
  if (flat.length <= MAX_STATUS_DISPLAY) return flat
  // Never split a surrogate pair: half an astral character renders as a replacement glyph.
  let cut = MAX_STATUS_DISPLAY - 1
  const prev = flat.charCodeAt(cut - 1)
  if (cut > 0 && prev >= 0xd800 && prev <= 0xdbff) cut -= 1
  return `${flat.slice(0, cut)}…`
}

/**
 * The statuses that mean "this run ended without returning a value", which is what §2.6's
 * Resume button answers. `cancelled` is here and is still not a failure: the operator's next
 * move after stopping a run is the same one, and the button is honest about the state either
 * way (`ResumeAction` disables itself when no state can be claimed).
 */
const TERMINAL_WITHOUT_VALUE = new Set<string>(['failed', 'interrupted', 'cancelled'])

/**
 * `RESUMABLE` minus the replay. When the STATUS is a word this build does not know, the
 * server's own state is the only evidence the screen has about whether a resume would be
 * accepted — but `completed` is not evidence of an ending without a value, and §2.6 asks for
 * Resume on the screen of a run that stopped. Replaying a completed run stays where §7.3 puts
 * it, in the cockpit.
 */
const RESUMABLE_ENDINGS = new Set<RunState>(['failed', 'interrupted', 'stale'])

/**
 * §2.6 requires the failed/interrupted view to offer Resume. That requirement is about the
 * RESULT payload, which this route already has; the run-detail request beside it is a
 * separate fetch that can fail on its own (a 500, a deleted `journal.jsonl`, an aborted
 * poll). Treating that unrelated failure as "state unknown" is what made a definitively
 * failed run non-resumable — the screen had the answer in `payload.status` and ignored it.
 */
function effectiveState(payload: ResultPayload | null, detail: RunDetail | null): RunState | null {
  if (payload?.state) return payload.state
  if (detail?.state) return detail.state
  const status = payload?.status
  return status != null && STATUS_AS_STATE.has(status) ? (status as RunState) : null
}

export interface ResultRouteProps {
  runId: string
  capabilities?: readonly string[] | null
  capabilityError?: string | null
  dataApi?: Pick<typeof api, 'runResult' | 'runDetail'>
  /** Injected in tests; the browser path is `download.ts`. */
  downloadFn?: typeof downloadRawResult
}

export function ResultRoute(props: ResultRouteProps) {
  const { runId, capabilities = null, capabilityError = null, dataApi = api } = props
  const control = useControl()

  // A run with no result yet is the ONE state that changes while this screen is open, so it
  // is the one state that polls. `result.json` is written once, at the end, with tmp+rename
  // (src/engine.js:604–608) — once it exists it will not be rewritten, and re-asking for it
  // every two seconds would be a poll that can never learn anything. Starts armed, because
  // "is there a result?" is exactly what the first response answers.
  const [polling, setPolling] = useState(true)
  const result = usePoll<ResultPayload>(
    (signal) => dataApi.runResult(runId, signal),
    { intervalMs: polling ? 2_000 : 0, deps: [runId] },
  )
  const detail = usePoll<RunDetail>(
    (signal) => dataApi.runDetail(runId, signal),
    { intervalMs: polling ? 2_000 : 0, deps: [runId] },
  )
  const payload = result.data
  useEffect(() => {
    if (payload) setPolling(Boolean(payload.pending))
  }, [payload])

  const state = effectiveState(payload, detail.data)
  const status = payload?.status ?? null
  // Display only — see `displayStatus`. The chip is a swatch in a header row, not a place a
  // 4 KiB word from `result.json` gets to decide where the run id goes.
  const frameState = displayStatus(status ?? state ?? 'unknown')

  const [note, setNote] = useState<string | null>(null)
  const [downloading, setDownloading] = useState(false)
  const download = useCallback(() => {
    const fn = props.downloadFn ?? downloadRawResult
    setDownloading(true)
    setNote(null)
    void fn(runId)
      .then(({ filename }) => setNote(`downloading ${filename}`))
      .catch((err: unknown) => setNote(
        err instanceof ApiError ? err.message : 'the raw result could not be downloaded',
      ))
      .finally(() => setDownloading(false))
  }, [props.downloadFn, runId])

  return (
    <section className="result-screen" aria-labelledby="result-h">
      <header className="res-head">
        <button
          className="btn ghost" type="button"
          onClick={() => navigate(href.run(runId))}
        >
          <Icon name="chevron" size={12} className="back" />Cockpit
        </button>
        <h1 id="result-h" tabIndex={-1}>Result</h1>
        <StatusChip state={frameState} />
        <span className="rid mono">{detail.data?.name ?? runId}</span>
      </header>

      {result.loading && !payload ? <div className="skel res-skel" /> : null}

      {result.error ? (
        <div className="banner" role="alert">
          <Icon name="failed" size={14} />
          <span>{result.error.message}</span>
          <button className="btn sm" type="button" onClick={result.reload}>Retry</button>
        </div>
      ) : null}

      {payload ? (
        <Body
          payload={payload}
          runId={runId}
          detail={detail.data}
          detailFailed={Boolean(detail.error)}
          state={state}
          capabilities={capabilities}
          capabilityError={capabilityError}
          control={control}
          onDownload={download}
          downloading={downloading}
          onNote={setNote}
        />
      ) : null}

      {note ? <p className="res-note micro dim" role="status">{note}</p> : null}
    </section>
  )
}

function Body(
  { payload, runId, detail, detailFailed, state, capabilities, capabilityError, control,
    onDownload, downloading, onNote }: {
    payload: ResultPayload
    runId: string
    detail: RunDetail | null
    detailFailed: boolean
    state: RunState | null
    capabilities: readonly string[] | null
    capabilityError: string | null
    control: ReturnType<typeof useControl>
    onDownload: () => void
    downloading: boolean
    onNote: (note: string) => void
  },
) {
  if (payload.pending) {
    return (
      <div className="res-frame pending">
        <p className="res-say">
          <b>No result yet.</b> The engine writes <code>result.json</code> once — at the end,
          with tmp+rename, so it is never observed half-written. This run is{' '}
          <StatusChip state={displayStatus(state ?? 'unknown')} /> and has not reached that
          point.
        </p>
        {state === 'stale' ? (
          <p className="res-say dim">
            A stale run stopped without writing one, and nothing on disk will ever produce it:
            the engine that owned this run is gone. Resume it from the cockpit to get a result.
          </p>
        ) : null}
      </div>
    )
  }

  if (payload.corrupt) {
    return (
      <>
        <div className="res-frame failed">
          <p className="res-say">
            <b>result.json exists and does not parse.</b> The engine writes it with
            tmp+rename (src/engine.js:604–608), so this viewer did not catch a partial write —
            the file on disk is not the JSON the run intended. Nothing is rendered from it,
            because a repaired guess would not be the run&apos;s result.
          </p>
        </div>
        <RawDownload onDownload={onDownload} downloading={downloading} label="Download the bytes" />
      </>
    )
  }

  // `status` is the RAW field and is what every classification below reads; `shown` is the
  // bounded, layout-safe rendering of it and is the only one that reaches the DOM.
  const status = payload.status ?? state ?? 'unknown'
  const shown = displayStatus(status)
  const framing = framingFor(status)
  // §2.6's Resume is offered for the endings that stopped without a value. An unrecognized
  // status gets it only when the SERVER's own state says the run is resumable — this screen
  // will not read a word it does not know as evidence that a resume would be accepted.
  const offersResume = TERMINAL_WITHOUT_VALUE.has(status)
    || (framing === 'neutral' && state != null && RESUMABLE_ENDINGS.has(state))
  const hasError = Object.prototype.hasOwnProperty.call(payload, 'error') && payload.error != null
  const hasValue = Object.prototype.hasOwnProperty.call(payload, 'result')
    || Boolean(payload.resultTruncated)

  return (
    <>
      <div className={`res-frame ${framing}`}>
        <p className="res-say"><FrameSay status={status} shown={shown} framing={framing} /></p>
        {typeof payload.resultBytes === 'number' ? (
          <p className="res-say dim micro">{payload.resultBytes.toLocaleString()} bytes on disk</p>
        ) : null}
      </div>

      {hasError ? <ErrorBlock error={payload.error} /> : null}

      {offersResume ? (
        <ResumeAction
          runId={runId} detail={detail} detailFailed={detailFailed} state={state}
          capabilities={capabilities} capabilityError={capabilityError} control={control}
        />
      ) : null}

      {payload.resultTruncated ? (
        <TruncatedValue
          preview={payload.preview ?? ''}
          bytes={payload.resultBytes ?? null}
          onDownload={onDownload}
          downloading={downloading}
        />
      ) : hasValue ? (
        <Value value={payload.result} onNote={onNote} onDownload={onDownload} downloading={downloading} />
      ) : !hasError ? (
        <div className="res-frame">
          <p className="res-say dim">
            <b>No value was recorded.</b> The run reached <b>{shown}</b> and{' '}
            <code>result.json</code> carries neither a <code>result</code> nor an{' '}
            <code>error</code> key. §6.5: an absent field is an absence, so this screen shows
            one rather than printing <code>null</code> as if the workflow had returned it.
          </p>
        </div>
      ) : null}
    </>
  )
}

/**
 * One sentence per framing, and none of them shared. The frame supplies the colour; this
 * supplies the claim, and the two must agree — the shipped screen painted `cancelled` red
 * while telling the operator "nothing failed", which is a screen arguing with itself.
 *
 * **The claim may not exceed the evidence, and `status` is the only evidence there is.**
 * A previous revision named a CAUSE for each failed framing — "the workflow threw" for
 * `failed`, "its engine took a signal" for `interrupted` — and `result.json` records neither.
 * Both are wrong for real runs this engine writes today:
 *
 *   • `interrupted` is written from `aborted`, and `abortRun` is called by the control
 *     socket's whole-run `cancel` (src/engine.js:709) as well as by SIGINT/SIGTERM
 *     (src/engine.js:1331 turns either into the same word). An operator who cancelled a run
 *     from the cockpit was being told a signal arrived.
 *   • `failed` is written before the workflow is ever entered — a contended or unavailable
 *     control socket (src/engine.js:737–740) and a module that will not load
 *     (src/engine.js:872) both `finalize({status: 'failed'})` with nothing having thrown
 *     inside the workflow at all. An MCP/startup failure was being reported as a throw.
 *
 * So the failed framing says only what the status word supports — the run stopped without
 * returning a value — and the recorded `error`, rendered verbatim by `ErrorBlock` directly
 * below, is where the cause comes from. It is the file's sentence, not this screen's.
 * `cancelled` — which this build's engine never writes, but an older or newer one may — is
 * an operator's decision by definition of the word; and an unrecognized word is a fact about
 * the FILE, so that branch reports the file and stops.
 */
function FrameSay(
  { status, shown, framing }: {
    /** The raw `result.json` field — decides which branch, never rendered. */
    status: string
    /** `displayStatus(status)` — the bounded, layout-safe text, and the only one painted. */
    shown: string
    framing: Framing
  },
) {
  if (framing === 'ok') {
    return (
      <>
        This run <b>{shown}</b>. The value below is <code>result.json</code> as the engine
        wrote it — read from the file, never reconstructed from the journal.
      </>
    )
  }
  if (framing === 'failed') {
    return (
      <>
        This run <b>{shown}</b>. It stopped before returning a value; what the engine
        recorded instead is below, verbatim. This screen does not infer a cause{' '}
        <code>result.json</code> does not state. Work already journalled by its agents is
        kept.
      </>
    )
  }
  if (status === 'cancelled') {
    return (
      <>
        This run was <b>cancelled</b>. It was stopped before the workflow could return a
        value — nothing failed, so nothing here is framed as a failure. What the engine
        recorded is below; work already journalled by its agents is kept.
      </>
    )
  }
  return (
    <>
      <code>result.json</code> records this run&apos;s status as <b>{shown}</b>, and this
      viewer does not recognize that word — the file was written by an engine older or newer
      than this build. Whatever it carries is shown below, exactly as written; this screen
      claims neither success nor failure, because the file gives it no basis for either.
      {shown !== status ? ' The status is shown shortened; Download raw has the file.' : ''}
    </>
  )
}

/** §2.6: strings render as safe markdown with a raw toggle; everything else is the tree. */
function Value(
  { value, onNote, onDownload, downloading }: {
    value: unknown
    onNote: (note: string) => void
    onDownload: () => void
    downloading: boolean
  },
) {
  const [raw, setRaw] = useState(false)
  const isString = typeof value === 'string'

  return (
    <div className="res-value">
      <div className="res-value-bar">
        <h2 className="lbl">value</h2>
        {isString ? (
          <div className="seg" role="group" aria-label="Value rendering">
            <button
              type="button" className={raw ? '' : 'sel'} aria-pressed={!raw}
              onClick={() => setRaw(false)}
            >
              Rendered
            </button>
            <button
              type="button" className={raw ? 'sel' : ''} aria-pressed={raw}
              onClick={() => setRaw(true)}
            >
              Raw
            </button>
          </div>
        ) : null}
        <button
          className="btn sm" type="button" onClick={onDownload} disabled={downloading}
        >
          <Icon name="external" size={12} />{downloading ? 'Downloading…' : 'Download raw'}
        </button>
      </div>

      {isString
        ? (raw
          ? <pre className="res-raw">{value as string}</pre>
          : <HardenedMarkdown className="md" source={value as string} />)
        : <JsonTree value={value} onCopyFailed={onNote} />}
    </div>
  )
}

function TruncatedValue(
  { preview, bytes, onDownload, downloading }: {
    preview: string
    bytes: number | null
    onDownload: () => void
    downloading: boolean
  },
) {
  return (
    <div className="res-value">
      <div className="res-value-bar">
        <h2 className="lbl">value — first 64 KiB</h2>
        <button className="btn sm" type="button" onClick={onDownload} disabled={downloading}>
          <Icon name="external" size={12} />{downloading ? 'Downloading…' : 'Download raw'}
        </button>
      </div>
      <p className="res-say dim micro">
        §5.4.5 inlines a result only up to 1 MiB; this one is{' '}
        {bytes != null ? `${bytes.toLocaleString()} bytes` : 'larger'}, so what follows is a
        PREFIX of the serialized value and not the value. It is shown as text — parsing a
        truncated prefix would produce a different value that looked like this one.
      </p>
      <pre className="res-raw">{preview}</pre>
    </div>
  )
}

function ErrorBlock({ error }: { error: unknown }) {
  const text = typeof error === 'string' ? error : null
  return (
    <div className="res-error" role="alert">
      <div className="res-value-bar">
        <Icon name="failed" size={14} />
        <h2 className="lbl">error</h2>
      </div>
      {text != null
        ? <p className="res-error-msg">{text}</p>
        : <JsonTree value={error} />}
    </div>
  )
}

function RawDownload(
  { onDownload, downloading, label }: {
    onDownload: () => void; downloading: boolean; label: string
  },
) {
  return (
    <div className="res-value">
      <button className="btn" type="button" onClick={onDownload} disabled={downloading}>
        <Icon name="external" size={12} />{downloading ? 'Downloading…' : label}
      </button>
    </div>
  )
}

/**
 * §2.6's "with a Resume button". It opens §7.3's modal rather than resuming, because a
 * resume is a lifecycle mutation and §7.2 gives every one of them a confirmation; this
 * screen is not a place where the rule gets an exception for being convenient.
 *
 * The `graphSource` argument is the honest one: if the run's snapshot could not be read, the
 * modal must not tell the operator "this run predates the recorded graph" — it has no basis
 * for either sentence (see `ResumeRef.graphSource`).
 */
function ResumeAction(
  { runId, detail, detailFailed, state, capabilities, capabilityError, control }: {
    runId: string
    detail: RunDetail | null
    detailFailed: boolean
    state: RunState | null
    capabilities: readonly string[] | null
    capabilityError: string | null
    control: ReturnType<typeof useControl>
  },
) {
  const resumable = state != null && RESUMABLE.has(state)
  const permitted = canOperate(capabilities, 'resume')
  const enabled = Boolean(control) && resumable && permitted
  const lockId = `lock-resume-result-${runId}`
  return (
    <div className="res-actions chipline wrap">
      <button
        className="btn primary" type="button"
        aria-disabled={!enabled}
        {...(permitted ? {} : { 'aria-describedby': lockId })}
        title={
          !resumable
            ? `a ${state ?? 'unknown'} run cannot be resumed`
            : !permitted
              ? 'resuming needs `flowition viewer --control=resume`'
              : !control
                ? 'resuming asks for confirmation first — that dialog is not wired in this build'
                : undefined
        }
        onClick={() => {
          if (!enabled) return
          control!.confirmResume({
            runId,
            name: detail?.name ?? null,
            state: state ?? null,
            graphDynamic: detail?.graphDynamic ?? null,
            graphSource: detail && !detailFailed ? 'snapshot' : 'unavailable',
          })
        }}
      >
        <Icon name="resume" size={12} />Resume run
      </button>
      <LockChip
        capabilities={capabilities} capability="resume" capabilityError={capabilityError}
        id={lockId} compact
      />
    </div>
  )
}
