/**
 * The log lane (DESIGN §2.4) and the header's last-log line (parity #59).
 *
 * A last-line readout (`logs.at(-1)`) is a status, not a log view. This is the
 * whole stream: `RunDetail.logs` is a bounded 200-record TAIL (§5.4.3, Sol-8), so the lane
 * renders that immediately and pages BACKWARDS through `GET …/events/page` (§5.4.6) for the
 * history — byte-domain windows of the same file the fold reads, which is why a page and
 * the live stream stitch without translation.
 *
 * Source lanes (workflow vs engine) and levels come from E12; a pre-E12 run's records fold
 * to `source: 'workflow'`/`level: 'info'` by the fold's own defaults (§6.4 step 6), so the
 * filters degrade to "everything is a workflow info line" rather than to an empty lane.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../../api/client.js'
import type { JsonlPage, LogView } from '../../api/types.js'
import { fmtClock } from '../../format/fmt.js'
import { Icon } from '../../ui/Icon.js'
import { href } from '../../app/router.js'

/** 256 KiB per backwards page — a few thousand log lines, one request. */
export const HISTORY_CHUNK_BYTES = 256 * 1024
/** `MAX_PAGE_BYTES` in src/viewer/pages.js — the server's own ceiling on one window. */
export const MAX_HISTORY_CHUNK_BYTES = 8 * 1024 * 1024

export interface OffsetLog { o: number; log: LogView }

/** An `OffsetLog` with the attempt scope (§6.4 step 1a) its bytes belong to. */
export interface ScopedLog extends OffsetLog { scope: number }

/**
 * A `run` record that OPENS an attempt scope (§6.4 step 1a: "a `started`/`resumed` run event
 * opens a new attempt scope"). Terminal `run` records close nothing, scope-wise — the next
 * opener is the boundary.
 */
export const opensScope = (rec: Record<string, unknown> | undefined): boolean =>
  rec?.type === 'run' && (rec.state === 'started' || rec.state === 'resumed')

/**
 * Assign every `log` record in a page the attempt scope it belongs to, **in the byte domain**
 * (review round 2, B3).
 *
 * The events file is ONE byte space holding every attempt, so a backwards page can straddle
 * a resume boundary. The boundary is not a timestamp — §6.4 is explicit that order is byte
 * order and never `t` — it is the offset of the `run` record that opened the scope. So the
 * walk is descending from a known scope at the window's END: each record takes the current
 * scope, and an opener DECREMENTS it for everything below itself (the opener belongs to the
 * scope it opens).
 *
 * `scopeAtStart` is what the walk ends on — the scope of the bytes below the lowest record in
 * the window — which is exactly the `scopeAtEnd` the next backwards page needs.
 */
export function assignScopes(
  page: JsonlPage | null | undefined,
  scopeAtEnd: number,
): { logs: ScopedLog[]; scopeAtStart: number } {
  const items = [...(page?.items ?? [])].sort((a, b) => a.o - b.o)
  const logs: ScopedLog[] = []
  let scope = scopeAtEnd
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    const rec = item.rec as Record<string, unknown> | undefined
    const log = logFromRecord(rec)
    if (log) logs.push({ o: item.o, log, scope })
    // The opener belongs to the scope it opens, so it is counted AFTER the record itself.
    // No clamp at zero: a walk that runs past the first attempt's opener returns -1, which
    // is how the caller learns it has reached the head of this run's history.
    if (opensScope(rec)) scope -= 1
  }
  return { logs: logs.reverse(), scopeAtStart: scope }
}

/** Identity for de-duplication. Records have no id, so the fields ARE the identity. */
export const logKey = (log: LogView): string =>
  `${log.at}|${log.source}|${log.level}|${log.agentIndex ?? ''}|${log.message}`

/**
 * A page's `log` records, oldest-first, minus anything already on screen.
 *
 * Two overlaps are possible and both are handled here rather than by hoping: a window that
 * reaches into the snapshot's tail (the first backwards page always does), and a window
 * re-read after a `sys/reset`. Offsets dedupe the first exactly; the field-identity key
 * covers the second, where the same record may sit at a different offset in a rotated file.
 */
export function mergeLogPages<T extends OffsetLog>(
  existing: readonly T[],
  incoming: readonly T[],
  liveTail: readonly LogView[],
): T[] {
  const seenOffsets = new Set(existing.map((e) => e.o))
  const seenKeys = new Set([...existing.map((e) => logKey(e.log)), ...liveTail.map(logKey)])
  const out = [...existing]
  for (const item of incoming) {
    if (seenOffsets.has(item.o)) continue
    const key = logKey(item.log)
    if (seenKeys.has(key)) continue
    seenOffsets.add(item.o)
    seenKeys.add(key)
    out.push(item)
  }
  return out.sort((a, b) => a.o - b.o)
}

/** One raw record → a `LogView`, or `null` when it is not a log (§6.4 step 6's defaults). */
export function logFromRecord(rec: Record<string, unknown> | undefined | null): LogView | null {
  if (!rec || rec.type !== 'log') return null
  return {
    at: Number(rec.t) || 0,
    message: String(rec.message ?? ''),
    source: rec.source === 'engine' ? 'engine' : 'workflow',
    level: rec.level === 'warn' || rec.level === 'error' ? rec.level : 'info',
    agentIndex: Number.isInteger(rec.agent) ? rec.agent as number : null,
  }
}

/** `log` records out of a raw events page. Unknown record types are simply not logs. */
export function logsFromPage(page: JsonlPage | null | undefined): OffsetLog[] {
  const out: OffsetLog[] = []
  for (const item of page?.items ?? []) {
    const log = logFromRecord(item?.rec as Record<string, unknown> | undefined)
    if (log) out.push({ o: item.o, log })
  }
  return out
}

export interface OlderLogs {
  logs: ScopedLog[]
  /** Where the next backwards window must END. `0` once the file's head is reached. */
  cursor: number
  /** Bytes abandoned because they held no complete record the reader would accept. */
  skippedBytes: number
  /**
   * The attempt scope the bytes AT `cursor` belong to — the `scopeAtEnd` of the next page.
   * `-1` means the walk passed the first attempt's opening `run` record: there is no earlier
   * history in this file.
   */
  scopeAtCursor: number
}

/**
 * One step backwards through `events.jsonl` (§5.4.6), stitched so that **no record can fall
 * down the gap between two windows**.
 *
 * The gap is real and silent. `readJsonlPage` returns only newline-terminated records, so a
 * window `[from, cursor)` drops the partial record it opens in the middle of. If the next
 * window is `[from - chunk, from)` — each request ending exactly where the last began — that
 * same record is now the one whose terminating newline lies past the window's end, and it is
 * dropped again. Every JSONL record straddling a 256 KiB boundary disappears from the log
 * lane, with nothing anywhere saying so (review round 1, B5).
 *
 * The fix is to page by the boundary the SERVER reports rather than by the one we asked for.
 * `page.start` is where the window's first COMPLETE record begins, so the bytes below it are
 * exactly the tail of the record we skipped. Ending the next window at `page.start` therefore
 * contains that record whole, and `mergeLogPages` dedupes the overlap by offset.
 *
 * A record longer than the window is the one case that makes no progress (the whole window is
 * one record's middle: `start === end`). The window then grows ×4 — past the reader's own
 * 1 MiB `MAX_JSONL_LINE_BYTES` within two steps — so the loop always terminates, and if a
 * line is so long that even an 8 MiB window cannot bracket it, the bytes are skipped and
 * REPORTED rather than silently jumped.
 */
export async function readOlderLogs(
  fetchPage: (opts: { from: number; maxBytes: number }) => Promise<JsonlPage | null | undefined>,
  cursor: number,
  { chunkBytes = HISTORY_CHUNK_BYTES, maxAttempts = 6, scopeAtEnd = 0 }: {
    chunkBytes?: number; maxAttempts?: number
    /** The attempt scope the bytes at `cursor` belong to (§6.4 step 1a). */
    scopeAtEnd?: number
  } = {},
): Promise<OlderLogs> {
  const logs: ScopedLog[] = []
  let span = Math.max(1, chunkBytes)
  let from = Math.max(0, cursor - span)
  let start = cursor
  let scopeAtStart = scopeAtEnd
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    from = Math.max(0, cursor - span)
    const page = await fetchPage({ from, maxBytes: Math.max(1, cursor - from) })
    // Re-read on a widened span: the scope walk always starts from the SAME known scope at
    // `cursor`, so a record read twice is assigned the same scope both times and the offset
    // dedupe in `mergeLogPages` collapses it.
    const scoped = assignScopes(page, scopeAtEnd)
    logs.push(...scoped.logs)
    scopeAtStart = scoped.scopeAtStart
    if (from === 0) return { logs, cursor: 0, skippedBytes: 0, scopeAtCursor: scopeAtStart }
    start = page?.start ?? from
    // `start <= from`: the window opened on a record boundary, so nothing was clipped.
    if (start <= from) return { logs, cursor: from, skippedBytes: 0, scopeAtCursor: scopeAtStart }
    // `start < cursor`: a leading partial was clipped, and ending the next window at its
    // own end brings it back whole.
    if (start < cursor) return { logs, cursor: start, skippedBytes: 0, scopeAtCursor: scopeAtStart }
    span = Math.min(MAX_HISTORY_CHUNK_BYTES, span * 4)
  }
  // Nothing but the middle of one oversized line, even at 8 MiB. It is past the reader's
  // 1 MiB cap and would be skipped as corrupt anyway — but the operator is told.
  return {
    logs, cursor: from, skippedBytes: Math.max(0, start - from), scopeAtCursor: scopeAtStart,
  }
}

export type SourceFilter = 'all' | 'workflow' | 'engine'

export function filterLogs(
  logs: readonly LogView[],
  { source, warnOnly }: { source: SourceFilter; warnOnly: boolean },
): LogView[] {
  return logs.filter((log) => {
    if (source !== 'all' && log.source !== source) return false
    if (warnOnly && log.level === 'info') return false
    return true
  })
}

/** Parity #59: the most recent workflow log line, one row, truncated. */
export function LastLogLine(
  { log, runId, onOpenLane, laneOpen }: {
    log: LogView | null
    runId: string
    onOpenLane: () => void
    laneOpen: boolean
  },
) {
  return (
    <div className="lastlog">
      {log ? (
        <>
          <span className="src">{log.source}</span>
          <span className="dim">{fmtClock(log.at)}</span>
          {log.agentIndex != null ? (
            <a href={href.agent(runId, log.agentIndex)} className="mono" style={{ fontSize: 11 }}>
              agent {log.agentIndex}
            </a>
          ) : null}
          <span className={`trunc${log.level === 'warn' ? ' warn' : log.level === 'error' ? ' err' : ''}`}>
            {log.message}
          </span>
        </>
      ) : (
        <span className="dim">no log lines yet</span>
      )}
      <button
        className="btn sm ghost" type="button" style={{ marginLeft: 'auto' }}
        aria-pressed={laneOpen} onClick={onOpenLane}
      >
        <Icon name="columns" size={12} />Log lane <kbd>L</kbd>
      </button>
    </div>
  )
}

export interface LogLaneProps {
  runId: string
  /** The current attempt scope's tail (§6.4 step 1a), newest last. */
  logs: readonly LogView[]
  logTotal: number
  /** Where the snapshot's stream cursor sits — the byte the history pages back from. */
  eventsOffset: number
  /**
   * The attempt scope being shown, and how many there are (§6.4 step 1a). The events file is
   * ONE byte space holding every attempt, so a backwards page can cross a resume boundary;
   * `assignScopes` labels every record it reads with the scope its bytes fall in and the lane
   * keeps only the selected one. Round 1 refused to page at all on an earlier attempt, which
   * left everything before that attempt's 200-record tail unreachable (review round 2, B3).
   */
  scope?: number
  scopeCount?: number
  onClose: () => void
  eventsPageFn?: typeof api.eventsPage
}

export function LogLane(props: LogLaneProps) {
  const { runId, logs, logTotal } = props
  const eventsPage = props.eventsPageFn ?? api.eventsPage
  const scopeCount = Math.max(1, props.scopeCount ?? 1)
  const currentScope = scopeCount - 1
  const scope = props.scope ?? currentScope
  const historical = scope !== currentScope
  const [source, setSource] = useState<SourceFilter>('all')
  const [warnOnly, setWarnOnly] = useState(false)
  const [history, setHistory] = useState<ScopedLog[]>([])
  const [cursor, setCursor] = useState<number>(props.eventsOffset)
  // The scope the bytes at `cursor` belong to. The lane starts at the file's stream cursor,
  // which is inside the CURRENT attempt by construction.
  const [scopeAtCursor, setScopeAtCursor] = useState<number>(currentScope)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [skipped, setSkipped] = useState(0)
  const rows = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)

  // A different run is a different history, and so is a different ATTEMPT: the walk back
  // through the file is stateful (cursor + the scope those bytes are in), and it restarts
  // when either changes. Keyed on a ref rather than reset by an effect on every prop change,
  // so a live run's growing tail does not throw away paged history.
  const forRun = useRef(`${runId}|${scope}`)
  if (forRun.current !== `${runId}|${scope}`) {
    forRun.current = `${runId}|${scope}`
    if (history.length) setHistory([])
    if (cursor !== props.eventsOffset) setCursor(props.eventsOffset)
    if (scopeAtCursor !== currentScope) setScopeAtCursor(currentScope)
    if (skipped) setSkipped(0)
  }

  // Nothing of the selected attempt is left below the cursor: the walk has crossed its
  // opening `run` record, so every remaining byte belongs to an EARLIER attempt.
  const exhausted = cursor <= 0 || scopeAtCursor < scope

  const loadOlder = useCallback(async () => {
    if (busy || cursor <= 0) return
    setBusy(true)
    setError(null)
    try {
      const older = await readOlderLogs(
        (opts) => eventsPage(runId, opts),
        cursor,
        { scopeAtEnd: scopeAtCursor },
      )
      // Only this attempt's records join the lane. The ones from other attempts were read —
      // they are in the same bytes — and are deliberately dropped rather than interleaved.
      const mine = older.logs.filter((l) => l.scope === scope)
      setHistory((current) => mergeLogPages(current, mine, logs))
      setCursor(older.cursor)
      setScopeAtCursor(older.scopeAtCursor)
      if (older.skippedBytes) setSkipped((n) => n + older.skippedBytes)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [busy, cursor, eventsPage, runId, logs, scope, scopeAtCursor])

  // Open at the newest line, which is what an operator hitting `L` came to read — and move
  // focus to the lane's own header (§3.6: "focus is moved into panels when they open and
  // restored on close"). Without it the keyboard user opening the drawer is left standing on
  // the handle, with the panel they asked for behind them in the tab order.
  useEffect(() => {
    if (rows.current) rows.current.scrollTop = rows.current.scrollHeight
    heading.current?.focus()
  }, [])

  const merged: LogView[] = [...history.map((h) => h.log), ...logs]
  const shown = filterLogs(merged, { source, warnOnly })
  const earlier = Math.max(0, logTotal - merged.length)

  return (
    <section className="loglane" aria-label="Log lane">
      <div className="sect">
        <h2 className="lbl lane-heading" tabIndex={-1} ref={heading}>log lane</h2>
        <span className="count">{logTotal.toLocaleString('en-US')}</span>
        <div className="sect-right">
          <div className="seg" role="group" aria-label="Log source">
            {(['all', 'workflow', 'engine'] as SourceFilter[]).map((value) => (
              <button
                key={value} type="button"
                className={source === value ? 'sel' : undefined}
                aria-pressed={source === value}
                onClick={() => setSource(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <button
            className="btn sm ghost" type="button"
            aria-pressed={warnOnly} onClick={() => setWarnOnly((v) => !v)}
          >
            <Icon name="filter" size={12} />warn+
          </button>
          <button className="icb" type="button" aria-label="Close log lane" onClick={props.onClose}>
            <Icon name="close" size={14} />
          </button>
        </div>
      </div>
      <div className="log-rows" ref={rows}>
        {historical ? (
          <div className="log-more">
            <span className="dim micro mono">
              attempt {scope + 1} of {scopeCount} — paging back through the events file and
              keeping only this attempt&apos;s records
            </span>
          </div>
        ) : null}
        {!exhausted ? (
          <div className="log-more">
            <button className="btn sm" type="button" disabled={busy} onClick={() => { void loadOlder() }}>
              <Icon name="chevron" size={12} className="flip" />
              {busy ? 'Reading…' : 'Earlier lines'}
            </button>
            <span className="dim micro mono">
              {earlier > 0
                ? `${earlier.toLocaleString('en-US')} earlier line${earlier === 1 ? '' : 's'} — pages backwards through the events file`
                : 'pages backwards through the events file'}
            </span>
          </div>
        ) : (
          <div className="log-more">
            <span className="dim micro mono">
              {historical
                ? 'the start of this attempt — every one of its log records is above'
                : 'the start of this run’s log'}
            </span>
          </div>
        )}
        {error ? <div className="log-more"><span className="micro err">{error}</span></div> : null}
        {skipped ? (
          <div className="log-more">
            <span className="dim micro mono">
              {skipped.toLocaleString('en-US')} bytes skipped — they hold no complete record
              under the reader&apos;s 1 MiB line cap
            </span>
          </div>
        ) : null}
        {shown.length === 0 ? (
          <div className="log-more">
            <span className="dim micro mono">
              {merged.length === 0
                ? 'no log lines yet — log() has not been called'
                : 'no lines match this filter'}
            </span>
          </div>
        ) : null}
        {shown.map((log, i) => (
          <div
            key={`${logKey(log)}-${i}`}
            className={`log-row${log.level === 'warn' ? ' warn' : log.level === 'error' ? ' err' : ''}`}
          >
            <span className="t">{fmtClock(log.at)}</span>
            <span className={`s ${log.source}`}>{log.source}</span>
            <span className="m">
              {log.agentIndex != null ? (
                <>
                  <a className="aref" href={href.agent(runId, log.agentIndex)}>agent {log.agentIndex}</a>{' '}
                </>
              ) : null}
              {log.message}
            </span>
          </div>
        ))}
      </div>
    </section>
  )
}
