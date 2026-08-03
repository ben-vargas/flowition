/**
 * The Timeline tab (DESIGN §2.4) — the Gantt, the concurrency-saturation strip, and the
 * ruler, all on ONE axis.
 *
 * "One axis" is structural rather than a convention that could be broken later: the ruler,
 * the strip and every lane are grids with the SAME template — `var(--lane-label)
 * var(--track)` — declared once on `.tl-plot`, and every mark inside them is a percentage
 * of the run's span (see `gantt.ts`). Zoom moves `--track`; the three components cannot
 * disagree about a scale because there is only one, and nothing measures a container.
 *
 * Answers Q5 ("how parallel was this actually?") and Q2 ("stuck or just quiet?").
 */

import { useCallback } from 'react'
import type { CSSProperties } from 'react'
import type { RunDetail } from '../../api/types.js'
import { fmtDuration } from '../../format/fmt.js'
import { Icon } from '../../ui/Icon.js'
import { AdapterBadge, StatusGlyph } from '../../ui/Status.js'
import { lookUpState } from '../../ui/icons.js'
import { DurationText } from './Duration.js'
import { type GanttLane, type GanttModel, type Zoom, ganttModel, trackWidth } from './gantt.js'
import { isQueuedState, useRunHonesty } from './honesty.js'
import { saturationModel } from './saturation.js'

export interface TimelineProps {
  detail: RunDetail
  now: number
  zoom: Zoom
  onZoom: (zoom: Zoom) => void
  selectedAgent: number | null
  onOpenAgent: (index: number) => void
  onCursor?: (index: number) => void
}

export function Timeline(props: TimelineProps) {
  const { detail, now, zoom } = props
  // ONE liveness verdict for the screen (`honesty.ts`): the chart's now-line, its open bars
  // and its quiet tags are the same claim the header and the Agents table make.
  const honesty = useRunHonesty(detail, now)
  const model = ganttModel(detail, { now, honesty })
  const track = trackWidth(zoom, model.spanMs)
  const sat = saturationModel(detail.saturation, {
    start: model.start,
    end: model.end,
    concurrency: detail.concurrency,
  })
  const showSat = model.hasQueueData && !sat.empty && sat.concurrency > 0

  return (
    <div className="tl scroller">
      <div className="tl-head">
        <span className="lbl">timeline</span>
        <span className="tl-note">
          {model.hasQueueData
            ? 'queue wait hatched · execution solid'
            : 'execution only — this run recorded no queue events'}
          {model.hasProgressData ? ' · the notch is the last provider output (E6)' : ''}
        </span>
        <div className="zoom">
          <span className="lbl">zoom</span>
          <div className="seg" role="group" aria-label="Timeline zoom">
            <button
              type="button" className={zoom === 'fit' ? 'sel' : undefined}
              aria-pressed={zoom === 'fit'} onClick={() => props.onZoom('fit')}
            >fit</button>
            <button
              type="button" className={zoom === 1000 ? 'sel' : undefined}
              aria-pressed={zoom === 1000} onClick={() => props.onZoom(1000)}
            >1s</button>
            <button
              type="button" className={zoom === 10_000 ? 'sel' : undefined}
              aria-pressed={zoom === 10_000} onClick={() => props.onZoom(10_000)}
            >10s/px</button>
          </div>
        </div>
      </div>

      {!model.hasQueueData ? (
        <div className="rawgrp" style={{ marginBottom: 12 }}>
          <Icon name="unknown" size={12} />
          <span>
            <b>Recorded by an older engine.</b> Queue wait, progress ticks and the
            concurrency-saturation strip are unavailable for this run; bars start at the
            first <span className="mono">running</span> event. This is derived from the run
            event&apos;s engine version, never from whether a field happened to appear.
          </span>
        </div>
      ) : null}

      <div className="tl-scrollx">
        <div
          className={`tl-plot${track != null ? ' fixed' : ''}`}
          style={track != null ? ({ '--track-px': `${track}px` } as CSSProperties) : undefined}
        >
          {showSat ? <SaturationStrip model={sat} /> : null}
          <Ruler model={model} />
          <div className="lanes">
            <div className="gridlines" aria-hidden="true">
              <div />
              <div className="gl-track">
                {model.ticks.map((tick) => (
                  <div key={tick.at} className="gl" style={{ left: `${tick.pct}%` }} />
                ))}
                {model.nowPct != null ? (
                  <div className="now-line" style={{ left: `${model.nowPct}%` }}>
                    <span>now</span>
                  </div>
                ) : null}
              </div>
            </div>
            <ul role="list" aria-label="Agent timeline">
              {model.lanes.map((lane) => (
                <li key={lane.index}>
                  <Lane
                    lane={lane}
                    selected={lane.index === props.selectedAgent}
                    onOpen={props.onOpenAgent}
                    {...(props.onCursor ? { onCursor: props.onCursor } : {})}
                  />
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}

function Ruler({ model }: { model: GanttModel }) {
  return (
    <div className="ruler" aria-hidden="true">
      <div />
      <div className="rule-track">
        {model.ticks.map((tick) => (
          <div key={tick.at} className="tk" style={{ left: `${tick.pct}%` }}>
            <span>{tick.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Lane(
  { lane, selected, onOpen, onCursor }: {
    lane: GanttLane
    selected: boolean
    onOpen: (index: number) => void
    onCursor?: (index: number) => void
  },
) {
  // The bar keeps the agent's own state colour and is DIMMED when orphaned (§6.4 step 8):
  // the run's fate, dimmed — never a live spinner, and never recoloured into a lie.
  const cls = lookUpState(lane.state)[0]
  const open = useCallback(() => onOpen(lane.index), [onOpen, lane.index])
  // A queue entry nothing on disk closes: there is a mark and no interval (round 12, B1).
  const queueOrphan = lane.waitKind === 'unrecorded' && lane.waitLeft != null
  // Where the trailing meta sits: past the whole bar, so the duration and the tags never
  // overlap the geometry they describe. The two MARKS — the replay tick and the orphaned
  // queue stub — are 9px wide whatever the span is, so the meta clears them in pixels.
  const metaLeft = lane.cached || queueOrphan
    ? `calc(${(lane.cached ? lane.tick : lane.waitLeft) ?? 0}% + 9px)`
    : `${Math.max(
      lane.waitLeft ?? lane.execLeft ?? 0,
      0,
    ) + (lane.waitWidth ?? 0) + (lane.execWidth ?? 0)}%`

  return (
    <button
      type="button"
      className={`lane${selected ? ' sel' : ''}`}
      onClick={open}
      onFocus={() => onCursor?.(lane.index)}
    >
      <span className="lane-label">
        <span className="idx">{lane.index}</span>
        <StatusGlyph state={lane.state} orphaned={lane.orphaned} />
        <AdapterBadge name={lane.adapter} />
        <span className="nm trunc">{lane.label}</span>
      </span>
      <span className="lane-track">
        {lane.cached ? (
          // No timestamp for the replay → no mark. The window's own start is another agent's
          // event, and the badge in the meta says so instead (round 12).
          lane.tick != null ? (
            <span
              className="bar nowait tick"
              style={{ left: `${lane.tick}%` }}
              title="cache hit — this agent never took a concurrency slot"
            >
              <span className="exec c" style={{ flex: 1 }} />
            </span>
          ) : null
        ) : queueOrphan ? (
          // The endpoint-free orphan marker: the `queued` event, and nothing to its right.
          // `.qorphan` fades out rather than closing, because closing it anywhere would be a
          // time this agent's wait ended — and no such time was ever recorded.
          <span
            className={`bar nowait qorphan${lane.waitLeft! >= 99.9 ? ' at-end' : ''}`}
            style={{ left: `${lane.waitLeft}%` }}
            title={QUEUE_UNRECORDED}
          >
            <span className="wait" style={{ flex: 1 }} />
          </span>
        ) : lane.waitLeft != null || lane.execLeft != null ? (
          <span
            className={`bar${showWait(lane) ? '' : ' nowait'}${lane.execWidth == null ? ' open' : ''}`
              + `${atEnd(lane) ? ' at-end' : ''}`}
            style={{
              left: `${lane.waitLeft ?? lane.execLeft ?? 0}%`,
              width: `${(lane.waitWidth ?? 0) + (lane.execWidth ?? 0)}%`,
            }}
          >
            {showWait(lane) ? (
              <span
                className="wait"
                style={{ width: `${pctOfBar(lane.waitWidth ?? 0, lane)}%` }}
                title={`queue wait ${fmtDuration(lane.waitMs) ?? 'unknown'}`}
              />
            ) : null}
            {lane.execWidth != null ? (
              <span
                className={`exec ${cls}${lane.orphaned ? ' orphan' : ''}`}
                style={{ width: `${pctOfBar(lane.execWidth, lane)}%` }}
              >
                {lane.notch != null && lane.execWidth > 0 ? (
                  <i
                    className="notch"
                    style={{ left: `${notchWithin(lane)}%` }}
                    title="last provider output"
                  />
                ) : null}
              </span>
            ) : null}
          </span>
        ) : null}
        <span className="bar-meta" style={{ left: metaLeft }}>
          {lane.cached ? <span className="badge replay">replay</span> : null}
          {lane.cached && lane.tick == null ? (
            <span
              className="badge"
              title={
                'this run recorded no timestamp for the replay, so there is nowhere on the'
                + ' axis to place it — the mark is omitted rather than drawn at the start of'
                + ' the window, which belongs to a different agent'
              }
            >
              replay time unrecorded
            </span>
          ) : null}
          {/* The same component, the same reading and the same wording the Agents table
              and the Structure chips use (`Duration.tsx`) — a lane that formatted its own
              figure is how one orphan came to read "end unrecorded" here and "1m1s" two
              tabs away (round 8, B1). */}
          <DurationText reading={lane.duration} />
          {isQueuedState(lane.state) && lane.waitMs != null ? (
            <span className="chip q">
              <Icon name="queued" size={12} />queued {fmtDuration(lane.waitMs)}
            </span>
          ) : null}
          {lane.quiet ? (
            <span
              className="quiet-tag"
              title={
                `${lane.quiet.from === 'start'
                  ? 'this run recorded no provider-output timestamp for this agent, so the silence is measured from its start'
                  : 'measured from the last provider output (E6)'}`
                + `; threshold ${lane.quiet.approximate
                  ? `defaulted to ${Math.round(lane.quiet.thresholdMs / 60_000)}m — the engine emitted none`
                  : `${Math.round(lane.quiet.thresholdMs / 60_000)}m, as emitted`}`
              }
            >
              <Icon name="stale" size={12} />
              quiet for {fmtDuration(lane.quiet.sinceMs)}
              {lane.quiet.approximate ? ' (stall threshold unknown)' : ''}
              {lane.quiet.from === 'start' ? ' (since start — no progress recorded)' : ''}
            </span>
          ) : null}
          {/* The queue wait's own version of the same refusal (round 12, B1): the interval is
              absent because nothing recorded its end, and the badge says that instead of the
              chart quietly closing it at the run's last event. */}
          {queueOrphan ? (
            <span className="badge" title={QUEUE_UNRECORDED}>
              {lane.orphaned ? 'orphaned — queue end unrecorded' : 'queue end unrecorded'}
            </span>
          ) : null}
          {/* No duration is printed above for a truncated lane — the badge is what stands in
              its place, and it says why rather than showing a fabricated `0ms` (round 7). */}
          {lane.truncated ? (
            <span
              className="badge"
              title={
                'no terminal event was ever written for this agent, so the bar stops at the'
                + ' last fact the engine recorded — not at now — and its duration is unknown'
              }
            >
              {lane.orphaned ? 'orphaned — end unrecorded' : 'end unrecorded'}
            </span>
          ) : null}
          {lane.errorCode ? <span className="badge err">{lane.errorCode}</span> : null}
        </span>
      </span>
    </button>
  )
}

/**
 * The one sentence for the orphaned queue entry, on the mark and on the badge (round 12, B1).
 *
 * It has to say two things, because the operator's question is "how long did this thing sit
 * there?": nothing recorded an end, AND the chart is therefore refusing to draw one. Without
 * the second half a reader assumes the mark IS the wait and reads it as ~0.
 */
const QUEUE_UNRECORDED =
  'this agent never started and no terminal event was written for it, so nothing on disk'
  + ' records when — or whether — its queue wait ended; the mark is the queued event alone'
  + ' and the chart draws no interval past it'

/**
 * Draw the hatched wait segment?
 *
 * Yes when there is a measurable wait — and also when there is a queue event but NO
 * execution segment, which is the still-queued agent: its bar would otherwise be an empty
 * 3px box with nothing inside it to carry the hatch, and an agent that is demonstrably
 * waiting would render as a blank lane.
 */
const showWait = (lane: GanttLane): boolean =>
  lane.waitLeft != null && ((lane.waitWidth ?? 0) > 0 || lane.execWidth == null)

/**
 * A zero-width mark sitting on the window's right EDGE — the agent that was queued in the
 * last instant the engine recorded anything. At `left: 100%` its 3px floor renders past
 * the track and the lane reads as blank; `.bar.at-end` pulls it back inside by its own
 * width, so the mark lands ON the edge instead of just after it.
 */
const atEnd = (lane: GanttLane): boolean =>
  (lane.waitLeft ?? lane.execLeft ?? 0) >= 99.9
  && ((lane.waitWidth ?? 0) + (lane.execWidth ?? 0)) < 0.1

/** A segment's width as a percentage of its own BAR (the bar is the flex container). */
const pctOfBar = (segment: number, lane: GanttLane): number => {
  const total = (lane.waitWidth ?? 0) + (lane.execWidth ?? 0)
  return total > 0 ? (segment / total) * 100 : 100
}

/** The notch's position inside the execution segment. */
function notchWithin(lane: GanttLane): number {
  if (lane.notch == null || lane.execLeft == null || !lane.execWidth) return 0
  const within = ((lane.notch - lane.execLeft) / lane.execWidth) * 100
  return within < 0 ? 0 : within > 100 ? 100 : within
}

function SaturationStrip({ model }: { model: ReturnType<typeof saturationModel> }) {
  const pinnedShare = model.totalMs > 0 ? model.pinnedMs / model.totalMs : 0
  return (
    <section className="sat" aria-label="Concurrency saturation">
      <div className="tl-head" style={{ marginBottom: 6 }}>
        <span className="lbl">concurrency saturation</span>
        <span className="tl-note">
          active vs <span className="mono">--concurrency {model.concurrency}</span>
          {model.pinnedMs > 0 ? (
            <>
              {' · '}
              <b>
                at the ceiling for {fmtDuration(model.pinnedMs)} of {fmtDuration(model.totalMs)}
                {model.maxQueued > 0
                  ? `, up to ${model.maxQueued} agent${model.maxQueued === 1 ? '' : 's'} queued`
                  : ''}
              </b>
            </>
          ) : ' · never at the ceiling'}
        </span>
      </div>
      <div className="sat-wrap">
        <div className="sat-axes">
          <span className="lbl">active / {model.concurrency}</span>
          <span className="lbl">queue depth</span>
        </div>
        <div className="sat-body">
          <div className="sat-plot">
            {model.bands.map((band, i) => (
              <div
                key={`band-${i}`} className="pin-band"
                style={{ left: `${band.left}%`, width: `${band.width}%` }}
              >
                {band.width > 12 ? <span>at the ceiling {fmtDuration(band.ms)}</span> : null}
              </div>
            ))}
            {model.steps.map((step, i) => (
              <div
                key={`step-${i}`}
                className={`step${step.pinned ? ' pinned' : ''}`}
                style={{ left: `${step.left}%`, width: `${step.width}%`, height: `${step.height * 100}%` }}
                title={`${step.active} active of ${model.concurrency}, ${step.queued} queued`}
              />
            ))}
            <div className="ceil" style={{ bottom: `${(model.concurrency / model.ceiling) * 100}%` }}>
              <span>ceiling {model.concurrency}</span>
            </div>
          </div>
          <div className="sat-rail">
            {model.queue.map((q, i) => (
              <div
                key={`q-${i}`} className="qd"
                style={{ left: `${q.left}%`, width: `${q.width}%`, height: `${q.depth * 10}px` }}
                title={`${q.queued} queued`}
              />
            ))}
            {model.queue.filter((q) => q.width > 8).map((q, i) => (
              <span key={`qn-${i}`} className="qn" style={{ left: `${q.left}%` }}>{q.queued} queued</span>
            ))}
          </div>
        </div>
      </div>
      <div className="sat-legend">
        <div className="keys">
          <span><i className="k-pinned" />active, at the ceiling</span>
          <span><i className="k-active" />active, below it</span>
          <span><i className="k-queued" />agents queued behind it</span>
          {model.suggestion != null && pinnedShare > 0.25 ? (
            <span className="advice">
              raising <span className="mono">--concurrency</span> to {model.suggestion} would
              have emptied the queue
            </span>
          ) : null}
        </div>
      </div>
    </section>
  )
}
