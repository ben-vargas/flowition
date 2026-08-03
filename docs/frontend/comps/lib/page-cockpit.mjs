import { page, frame, mk, topbar, ic, chip, glyph, adapter, cluster } from './shell.mjs';
import {
  RUN, RUNS, AGENTS, SATURATION, CONCURRENCY, SPAN_MS, BUDGET, LINEAGE, PHASES,
  QUESTIONS, MAIL, LOGS, LAST_LOG,
} from './fixtures.mjs';

/* ---------------------------------------------------------------- geometry */
// Lane geometry is per-VIEWPORT, not a constant: §3.7 requires this screen at 1440 and at
// 800, and the Gantt is the one component whose pixel math cannot survive a CSS-only
// reflow — bar offsets are computed in px against the track width. Both frames render from
// the same fixture times through `withGeometry`, so the 800px comp is the same trace drawn
// narrower, never a second hand-tuned set of numbers that could drift from the first.
const GEOM_1440 = { track: 640, label: 168 };  // 840 main col - 32 padding - 168 label
// 800 - 88 (two 44px drawer strips) - 28 (.tl padding) = 684 usable. 170 + 350 = 520 leaves
// 164px for the trailing bar-meta — the duration, the "queued 3m08s" chip and the quiet tag
// all sit past the bar, and a track wide enough to clip them buys nothing. The label stays
// wide enough for a real agent name: a Gantt whose lanes all read "revie…" is not a Gantt.
const GEOM_800 = { track: 350, label: 170 };
let TRACK = GEOM_1440.track;
let LABEL = GEOM_1440.label;
const X = (ms) => (ms / SPAN_MS) * TRACK;
const pct = (ms) => `${((ms / SPAN_MS) * 100).toFixed(3)}%`;

/** Render `fn` against a different lane geometry. Restores on the way out. */
function withGeometry(geom, fn) {
  const [track, label] = [TRACK, LABEL];
  TRACK = geom.track;
  LABEL = geom.label;
  try { return fn(); } finally { TRACK = track; LABEL = label; }
}
const CLS = { done: 'd', running: 'r', failed: 'f', cached: 'c', cancelled: 'x', queued: 'q' };

/* =================================================================== header */
export const runHeader = (opts = {}) => `<div class="rhead">
  <div class="rhead-top">
    ${glyph('running', { spin: true })}
    <h1>${RUN.name}</h1>
    <button class="rid" title="Copy run id">${RUN.id}${ic('copy', '12')}</button>
    ${chip('running', 'running', { spin: true })}
    <span class="live-detail">${RUN.liveDetail}</span>
    <div class="rhead-actions">
      <button class="btn">${ic('cancel', '12')}Cancel run</button>
      <button class="btn" aria-disabled="true" title="enabled only for a terminal or stale run (§7.3)">${ic('resume', '12')}Resume</button>
      <button class="btn danger" aria-disabled="true" title="enabled only for a terminal run (§7.3)">${ic('trash', '12')}Delete</button>
      <button class="btn">${ic('external', '12')}Result</button>
    </div>
  </div>

  <div class="rhead-metrics">
    <div class="metric" style="min-width:106px">
      <span class="lbl">elapsed</span>
      <span class="v"><b>${RUN.elapsed}</b></span>
    </div>
    <div class="metric" style="min-width:132px">
      <span class="lbl">agents</span>
      <span class="v"><b>${RUN.agents.done}</b><span class="u">/${RUN.agents.total}</span>
        <span class="u" style="font-size:11px"> ·${RUN.agents.cached}c ·${RUN.agents.failed}f</span></span>
    </div>
    <div class="metric" style="min-width:150px">
      <span class="lbl">tokens in / out</span>
      <span class="v">${RUN.tin}<span class="u"> / </span><b>${RUN.tout}</b></span>
    </div>
    <div class="metric" style="min-width:88px">
      <span class="lbl">cost</span>
      <span class="v"><b>${RUN.cost}</b></span>
    </div>
    <div class="metric gauge-cell">
      <span class="lbl">budget — output tokens vs budget.total</span>
      <div class="gauge">
        <div class="gauge-bar" role="img"
             aria-label="375.1k of 340k output tokens, 110.3 percent of the soft ceiling">
          <div class="fill" style="width:${BUDGET.ceilingAt}%"></div>
          <div class="over" style="left:${BUDGET.ceilingAt}%;right:0"></div>
          <div class="ceiling" style="left:${BUDGET.ceilingAt}%"></div>
        </div>
        <div class="gauge-legend">
          <b>${BUDGET.spentLabel}</b><span>/ ${BUDGET.totalLabel} out</span>
          <span class="over-l">· ${BUDGET.pct}% · +35.1k over</span>
          <span class="soft" style="margin-left:auto"
                title="the engine checks the budget before admitting an agent; a running agent is never killed for exceeding it">soft ceiling</span>
        </div>
      </div>
    </div>
  </div>

  <div style="display:flex;align-items:center;gap:12px">
    <span class="lbl">lineage</span>
    <div class="lineage" style="flex:1">
${LINEAGE.map((s) => `      <span class="seg-l ${s.state}" style="flex:${s.frac}" title="${s.label}"></span>`).join('\n')}
    </div>
    <span class="cap">2 attempts · resumed 14:08:05 · <button class="btn sm ghost">scoped to attempt 2 ${ic('chevdown', '12')}</button></span>
  </div>
</div>
<div class="lastlog">
  <span class="src">${LAST_LOG.s}</span>
  <span class="dim">${LAST_LOG.t}</span>
  <a href="#/run/${RUN.id}/agent/${LAST_LOG.a}" class="mono" style="font-size:11px">agent ${LAST_LOG.a}</a>
  <span class="trunc">${LAST_LOG.m}</span>
  <button class="btn sm ghost" style="margin-left:auto">${ic('columns', '12')}Log lane <kbd>L</kbd></button>
</div>${opts.extra ?? ''}`;

/* ==================================================================== tabs */
const tabs = (active) => `<div class="tabs" role="tablist">
  <button role="tab" aria-selected="${active === 'timeline'}">${ic('gantt', '14')}Timeline</button>
  <button role="tab" aria-selected="${active === 'structure'}">${ic('tree', '14')}Structure</button>
  <button role="tab" aria-selected="${active === 'agents'}">${ic('table', '14')}Agents</button>
  <div class="kb">
    <span class="dim micro mono">[ ] to switch</span>
  </div>
</div>`;

/* ================================================================ timeline */
function saturationStrip() {
  const UNIT = 12;                 // ceiling (2 active) sits at 24px of a 38px plot
  const steps = [];
  const rails = [];
  const bands = [];                // merged pinned intervals, so adjacent samples read as one band

  for (let i = 0; i < SATURATION.length - 1; i++) {
    const [t, a, q] = SATURATION[i];
    const t2 = SATURATION[i + 1][0];
    const left = X(t), w = X(t2) - X(t);
    const pinned = a >= CONCURRENCY;
    steps.push(`      <div class="step${pinned ? ' pinned' : ''}" style="left:${left.toFixed(1)}px;width:${w.toFixed(1)}px;height:${a * UNIT}px"
        title="${a} active of 2, ${q} queued"></div>`);
    if (q) {
      // depth grows downward from the rail's top edge; 3 is full height
      rails.push(`      <div class="qd" style="left:${left.toFixed(1)}px;width:${w.toFixed(1)}px;height:${(Math.min(q, 3) / 3 * 10).toFixed(1)}px"
        title="${q} queued"></div>`);
      if (w > 60) rails.push(`      <span class="qn" style="left:${left.toFixed(1)}px">${q} queued</span>`);
    }
    const last = bands.at(-1);
    if (pinned && last && Math.abs(last.end - left) < 0.5) last.end = left + w;
    else if (pinned) bands.push({ start: left, end: left + w });
  }

  const bandEls = bands.map((b) => {
    const w = b.end - b.start;
    const mins = ((b.end - b.start) / TRACK * SPAN_MS / 60000);
    return `      <div class="pin-band" style="left:${b.start.toFixed(1)}px;width:${w.toFixed(1)}px">${
      w > 90 ? `<span>at the ceiling ${mins.toFixed(0)}m</span>` : ''}</div>`;
  });

  return `<div class="sat">
  <div class="tl-head" style="margin-bottom:6px">
    <span class="lbl">concurrency saturation</span>
    <span class="tl-note">active vs <span class="mono">--concurrency 2</span> · <b>at the ceiling for 13m of 14m with 2 agents queued throughout</b></span>
  </div>
  <div class="sat-wrap" style="grid-template-columns:${LABEL}px 1fr">
    <div class="sat-axes">
      <span class="lbl">active / 2</span>
      <span class="lbl">queue depth</span>
    </div>
    <div class="sat-body">
      <div class="sat-plot">
${bandEls.join('\n')}
${steps.join('\n')}
        <div class="ceil" style="bottom:${CONCURRENCY * UNIT}px"><span>ceiling 2</span></div>
      </div>
      <div class="sat-rail">
${rails.join('\n')}
      </div>
    </div>
  </div>
  <div class="sat-legend">
    <span><i style="background:color-mix(in oklab,var(--accent) 78%,var(--surface));border-top:1px solid var(--accent)"></i>active, at the ceiling</span>
    <span><i style="background:color-mix(in oklab,var(--accent) 42%,var(--surface))"></i>active, below it</span>
    <span><i style="background:repeating-linear-gradient(135deg,var(--text-3) 0 1px,transparent 1px 4px)"></i>agents queued behind it</span>
    <span style="margin-left:auto">raising <span class="mono">--concurrency</span> to 4 would have emptied the queue</span>
  </div>
</div>`;
}

function ruler() {
  const ticks = [];
  for (let ms = 0; ms <= SPAN_MS; ms += 120000) {
    const m = Math.floor(ms / 60000);
    ticks.push(`    <div class="tk" style="left:${X(ms)}px"><span>${m}m</span></div>`);
  }
  return `<div class="ruler" style="margin-left:${LABEL}px">\n${ticks.join('\n')}\n  </div>`;
}

function lane(a) {
  const isOpen = a.state === 'queued';
  const hasWait = a.wait != null;
  const wStart = hasWait ? a.wait : a.start;
  const endMs = a.end ?? SPAN_MS;
  const left = X(wStart);
  const waitW = hasWait ? X(a.start ?? SPAN_MS) - X(a.wait) : 0;
  const execW = isOpen ? 0 : Math.max(X(endMs) - X(a.start), 5);
  const total = waitW + execW;
  const barCls = [`bar`, hasWait ? '' : 'nowait', isOpen ? 'open' : ''].filter(Boolean).join(' ');

  const notches = (a.notches ?? [])
    .map((n) => `<i class="notch" style="left:${X(n) - X(a.start)}px"></i>`).join('');

  const metaBits = [];
  if (a.state === 'cached') metaBits.push('<span class="badge replay">replay</span>');
  if (a.dur && a.dur !== '—') metaBits.push(a.dur);
  if (a.state === 'queued') metaBits.push(`<span class="chip q">${ic('queued', '12')}queued ${a.waitLabel}</span>`);
  if (a.quiet) metaBits.push(`<span class="quiet-tag">${ic('stale', '12')}quiet for ${a.quiet}</span>`);
  if (a.errorCode) metaBits.push(`<span class="badge err">${a.errorCode}</span>`);

  return `    <div class="lane" tabindex="-1" style="grid-template-columns:${LABEL}px 1fr">
      <div class="lane-label">
        <span class="idx">${a.i}</span>
        ${glyph(a.state, { spin: a.state === 'running' })}
        ${adapter(a.adapter)}
        <span class="nm trunc">${a.label}</span>
      </div>
      <div class="lane-track">
        ${a.state === 'cached'
    ? `<div class="bar nowait" style="left:0;width:9px"><div class="exec c" style="flex:1"></div></div>`
    : `<div class="${barCls}" style="left:${left}px;width:${total}px">
          ${hasWait ? `<div class="wait" style="width:${waitW}px" title="queue wait ${a.waitLabel} — ${a.admitBecause}"></div>` : ''}
          ${isOpen ? '' : `<div class="exec ${CLS[a.state]}" style="width:${execW}px">${notches}</div>`}
        </div>`}
        <div class="bar-meta" style="left:${left + total + 8}px">${metaBits.join(' ')}</div>
      </div>
    </div>`;
}

function timelineTab() {
  return `<div class="tl scroller">
  <div class="tl-head">
    <span class="lbl">timeline</span>
    <span class="tl-note">queue wait <span style="border-bottom:1px dashed var(--text-3)">hatched</span> · execution solid · notches are provider-output ticks (E6)</span>
    <div class="zoom">
      <span class="lbl">zoom</span>
      <div class="seg">
        <button class="sel">fit</button><button>1s</button><button>10s/px</button>
      </div>
      <button class="btn ghost" aria-label="Zoom in">${ic('plus', '12')}</button>
      <button class="btn ghost" aria-label="Zoom out">${ic('minus', '12')}</button>
    </div>
  </div>
  ${saturationStrip()}
  ${ruler()}
  <div class="lanes">
    <div class="grid" aria-hidden="true">
${[120000, 240000, 360000, 480000, 600000, 720000, 840000].map((ms) => `      <div class="gl" style="left:${LABEL + X(ms)}px"></div>`).join('\n')}
    </div>
${AGENTS.map(lane).join('\n')}
    <div class="now-line" style="left:${LABEL + TRACK - 1}px"><span>now</span></div>
  </div>
</div>`;
}

/* =============================================================== structure */
const achip = (a, extra = '') => {
  const cls = a.state === 'queued' ? 'q' : a.state === 'failed' ? 'f' : a.state === 'running' ? 'r' : '';
  return `<div class="achip ${cls}" tabindex="-1">
      ${glyph(a.state, { spin: a.state === 'running' })}${adapter(a.adapter)}
      <span class="nm trunc">${a.label}</span>
      ${a.state === 'cached' ? '<span class="badge replay">replay</span>' : ''}
      <span class="m">${extra || [a.dur && a.dur !== '—' ? a.dur : '', a.cost ?? ''].filter(Boolean).join(' · ')}</span>
    </div>`;
};
const A = (i) => AGENTS[i];
const emptyCell = (why) => `<div class="achip" style="border-style:dotted;background:transparent">
      ${ic('unknown', '', 'dim')}<span class="nm dim" style="font-weight:400">${why}</span></div>`;

function structureTab() {
  const items = [
    ['item 0', 'auth', achip(A(3)), achip(A(8), 'queued 8m40s')],
    ['item 1', 'routes', achip(A(4)), emptyCell('skipped — stage 0 threw')],
    ['item 2', 'tests', achip(A(5)), emptyCell('not created — stage 0 still running')],
    ['item 3', 'client', achip(A(6)), achip(A(9), 'queued 6m14s')],
    ['item 4', 'docs', achip(A(7)), emptyCell('not created — stage 0 still running')],
  ];
  return `<div class="dag scroller">
  <div class="tl-head" style="margin-bottom:0">
    <span class="lbl">structure — from the fanout events' <span class="mono">path</span> (E2)</span>
    <span class="tl-note">2 containers · 10 agents · 3 declared phases</span>
  </div>

  <div class="node">
    <div class="nhead">${ic('tree', '14', 'dim')}
      <span class="kind">parallel(3)</span>
      <span class="badge">phase 0 · Survey</span>
      <div class="roll">${chip('done', '3/3 done')}<span>2m14s</span><span>$1.251</span></div>
    </div>
    <div class="nbody"><div class="fan">
${[0, 1, 2].map((i) => `      <div class="fan-row"><span class="ilbl">item ${i}</span>${achip(A(i))}</div>`).join('\n')}
    </div></div>
  </div>

  <div class="node">
    <div class="nhead">${ic('columns', '14', 'dim')}
      <span class="kind">pipeline(5 × 2)</span>
      <span class="badge">phase 1 · Review</span>
      <div class="roll">${chip('running', 'mixed', { spin: true })}<span>7 of 10 slots materialised</span><span>$7.794</span></div>
    </div>
    <div class="nbody"><div class="pipe">
      <div class="pipe-head">
        <span></span>
        <span class="lbl">stage 0 · review</span>
        <span class="lbl">stage 1 · verify</span>
      </div>
${items.map(([lbl, nm, s0, s1]) => `      <div class="pipe-row">
        <span class="ilbl">${lbl}<br><span class="dim">${nm}</span></span>
        ${s0}
        ${s1}
      </div>`).join('\n')}
    </div></div>
  </div>

  <div class="node" style="opacity:.62;border-style:dashed">
    <div class="nhead">${ic('queued', '14', 'dim')}
      <span class="kind dim">phase 2 · Report</span>
      <div class="roll"><span class="chip q">${ic('queued', '12')}pending</span><span>declared in meta.phases, not yet reached</span></div>
    </div>
  </div>

  <div class="rawgrp" style="margin-top:4px">${ic('unknown', '12')}
    Old runs (no fanout events) fall back to a flat agent list with
    "structure unavailable for runs recorded before v0.2" — never a blank panel (§6.5).</div>
</div>`;
}

/* ================================================================== agents */
const AT_HEAD = `    <div class="at-row head" role="row">
      <span class="lbl" style="text-align:right">#</span>
      <span class="lbl">label</span>
      <span class="lbl">adapter · model · effort</span>
      <span class="lbl">phase</span>
      <span class="lbl">state</span>
      <span class="lbl" style="text-align:right">wait</span>
      <span class="lbl" style="text-align:right">dur</span>
      <span class="lbl" style="text-align:right">in</span>
      <span class="lbl" style="text-align:right">out</span>
      <span class="lbl" style="text-align:right"><button class="sorted">cost ${ic('chevdown', '12')}</button></span>
      <span class="lbl">last tool / error</span>
      <span class="lbl" style="text-align:right">att</span>
      <span class="lbl" style="text-align:right">steer</span>
    </div>`;

const atRow = (a, sel = false) => `    <div class="at-row${sel ? ' sel' : ''}" role="row" tabindex="-1">
      <span class="idx">${a.i}</span>
      <span class="lab">${glyph(a.state, { spin: a.state === 'running' })}<span class="nm trunc">${a.label}</span>${a.state === 'cached' ? '<span class="badge replay">replay</span>' : ''}</span>
      <span class="mdl">${adapter(a.adapter)}<span class="trunc">${a.model ?? '<span class="absent">&nbsp;</span>'}${a.effort ? ` · ${a.effort}` : ''}</span></span>
      <span class="ph">${a.phase}</span>
      <span>${chip(a.state, null, { spin: a.state === 'running' })}</span>
      <span class="n">${a.waitLabel === '—' ? '<span class="absent">&nbsp;</span>' : a.waitLabel}</span>
      <span class="n">${a.dur && a.dur !== '—' ? a.dur : '<span class="absent">&nbsp;</span>'}</span>
      <span class="n">${a.tin ?? '<span class="absent">&nbsp;</span>'}</span>
      <span class="n">${a.tout ?? '<span class="absent">&nbsp;</span>'}${a.state === 'running' ? '<span class="dim" title="live from usage-cum">·</span>' : ''}</span>
      <span class="n">${a.cost ?? '<span class="absent">&nbsp;</span>'}</span>
      <span class="trunc">${a.error
    ? `<span class="badge err">${a.errorCode}</span> <span class="errmsg" title="${a.error}">${a.error}</span>`
    : a.lastTool ? `<span class="tool">${a.lastTool}</span>` : '<span class="absent">&nbsp;</span>'}</span>
      <span class="n">${a.attempts || '<span class="absent">&nbsp;</span>'}</span>
      <span class="n">${a.steers || '<span class="absent">&nbsp;</span>'}</span>
    </div>`;

function agentsTab() {
  return `<div class="at scroller">
  <div class="tl-head" style="padding:12px 16px 8px;margin:0">
    <span class="lbl">agents</span>
    <div class="seg" style="margin-left:auto">
      <button class="sel">${ic('table', '12')}Flat</button>
      <button>${ic('tree', '12')}Phases</button>
    </div>
  </div>
${AT_HEAD}
${AGENTS.map((a) => atRow(a, a.i === 5)).join('\n')}
</div>`;
}

function phaseTree() {
  const rollup = (ags) => {
    if (ags.some((i) => A(i).state === 'failed')) return chip('failed', 'failed');
    if (ags.some((i) => A(i).state === 'running')) return chip('running', 'running', { spin: true });
    return chip('done', 'done');
  };
  return `<div class="at scroller">
  <div class="tl-head" style="padding:12px 16px 8px;margin:0">
    <span class="lbl">agents — phases</span>
    <span class="tl-note">declaration order from <span class="mono">meta.phases</span> (E3), then observed phase events</span>
    <div class="seg" style="margin-left:auto"><button>${ic('table', '12')}Flat</button><button class="sel">${ic('tree', '12')}Phases</button></div>
  </div>

  <button class="phead" aria-expanded="true">
    ${ic('chevron', '', 'chev')}${rollup([0, 1, 2])}
    <span class="pn">Survey</span>
    <span class="cnt">2 done · 1 cached · 3/3</span>
    <span class="ptoggled">${ic('keyboard', '12')}kept open by you</span>
  </button>
  <div class="pbody">
${[0, 1, 2].map((i) => atRow(A(i))).join('\n')}
  </div>

  <button class="phead" aria-expanded="true">
    ${ic('chevron', '', 'chev')}${rollup([3, 4, 5, 6, 7, 8, 9])}
    <span class="pn">Review</span>
    <span class="cnt">2 done · 1 failed · 2 running · 2 queued · 2/7</span>
    <span class="dim micro mono">contains the selected agent</span>
  </button>
  <div class="pbody">
${[3, 4, 5, 6, 7, 8, 9].map((i) => atRow(A(i), i === 5)).join('\n')}
  </div>

  <button class="phead pending" aria-expanded="false">
    ${ic('chevron', '', 'chev')}<span class="g q">${ic('queued')}<span class="vh">pending</span></span>
    <span class="pn">Report</span>
    <span class="cnt">pending — declared, not reached</span>
    <span></span>
  </button>
  <div class="rawgrp" style="margin:8px 16px">${ic('unknown', '12')}
    An agent with no phase would render in a trailing "no phase" section — never dropped
    (parity #51). A phase whose agents are all done/cached auto-collapses; the explicit
    toggle above overrides that for the life of the page (parity #50 / #119).</div>
</div>`;
}

/* =============================================================== log lane */
const logLane = () => `<div class="loglane">
  <div class="sect">
    <span class="lbl">log lane</span><span class="count">1,842</span>
    <span class="dim micro mono">the full log stream — not just logs.at(-1)</span>
    <div class="sect-right">
      <div class="seg"><button class="sel">all</button><button>workflow</button><button>engine</button></div>
      <button class="btn sm ghost">${ic('filter', '12')}warn+</button>
      <button class="icb" aria-label="Close log lane">${ic('close', '14')}</button>
    </div>
  </div>
  <div class="log-rows fade-b on-surface" style="height:150px;overflow:hidden">
    <div class="log-row"><span class="t dim">↑ 1,835 earlier lines — pages backwards through the events route</span></div>
${LOGS.map((l) => `    <div class="log-row ${l.lvl === 'warn' ? 'warn' : l.lvl === 'error' ? 'err' : ''}">
      <span class="t">${l.t}</span>
      <span class="s ${l.s}">${l.s}</span>
      <span class="m">${l.a != null ? `<a class="aref" href="#/run/${RUN.id}/agent/${l.a}">agent ${l.a}</a> ` : ''}${l.m}</span>
    </div>`).join('\n')}
  </div>
</div>`;

/* ============================================================== inbox rail */
export const inboxRail = () => `<div class="col">
  <div class="sect">
    <span class="lbl">inbox</span><span class="count">1 open</span>
    <div class="sect-right"><button class="icb" aria-label="Collapse inbox rail">${ic('chevron', '14')}</button></div>
  </div>
  <div class="scroller fade-b">

    <div class="inbox-group">
      <div class="sect" style="background:var(--surface)">
        <span class="lbl">questions</span><span class="count">1 / 2</span>
      </div>
${QUESTIONS.filter((q) => !q.answered).map((q) => `      <div class="qitem">
        <div class="qh">${glyph('blocked')}<span class="strong meta">${q.from}</span><span class="ago">${q.ago}</span></div>
        <div class="qb">${q.text}</div>
        <form class="answer" onsubmit="return false">
          <label class="vh" for="a-${q.qid}">Answer</label>
          <input class="inp" id="a-${q.qid}" placeholder="your answer">
          <button class="btn primary" type="submit">${ic('send', '12')}Send</button>
          <span class="hint">⌘↵ · qid ${q.qid} · <b>a</b> focuses this box</span>
        </form>
      </div>`).join('\n')}
${QUESTIONS.filter((q) => q.answered).map((q) => `      <div class="qitem answered">
        <div class="qh">${glyph('done')}<span class="strong meta dim">${q.from}</span><span class="ago">${q.ago}</span></div>
        <div class="qb">${q.text}</div>
        <div class="ans"><span class="lbl">answer</span><span>${q.answer}</span></div>
      </div>`).join('\n')}
    </div>

    <div class="inbox-group">
      <div class="sect" style="background:var(--surface)">
        <span class="lbl">agent reports</span><span class="count">2</span>
        <span class="dim micro mono">mail dir:out</span>
      </div>
${MAIL.filter((m) => m.dir === 'out').map((m) => `      <div class="mitem">
        <div class="mh">${adapter(AGENTS[m.agent].adapter)}<a class="who" href="#/run/${RUN.id}/agent/${m.agent}">${m.who}</a><span class="ago">${m.ago}</span></div>
        <div class="mb">${m.body}</div>
      </div>`).join('\n')}
    </div>

    <div class="inbox-group">
      <div class="sect" style="background:var(--surface)">
        <span class="lbl">steering history</span><span class="count">3</span>
        <span class="dim micro mono">mail dir:in</span>
      </div>
${MAIL.filter((m) => m.dir === 'in').map((m) => `      <div class="mitem">
        <div class="mh">${ic('steered', '14')}<span class="who">${m.who}</span>
          <span class="badge">→ agent ${m.agent}</span><span class="ago">${m.ago}</span></div>
        <div class="mb">${m.body}</div>
        <div class="mf"><span class="verdict ${m.delivery}">${m.delivery}</span>
          ${m.callsite ? `<span title="the only workflow source position on disk">${m.callsite}</span>` : '<span class="dim">no callsite journalled</span>'}</div>
      </div>`).join('\n')}
    </div>

  </div>
</div>`;

/* =============================================================== run rail */
export const runRail = () => `<div class="col rail-run">
  <div class="sect">
    <span class="lbl">runs</span><span class="count">41</span>
    <div class="sect-right">
      <button class="icb" aria-label="Filter runs">${ic('filter', '14')}</button>
      <button class="icb" aria-label="Collapse run rail">${ic('chevron', '14')}</button>
    </div>
  </div>
  <div class="scroller fade-b">
${RUNS.map((r) => `    <div class="rrow"${r.sel ? ' aria-current="true"' : ''} tabindex="-1">
      ${glyph(r.state, { spin: r.state === 'running' })}
      <span style="min-width:0">
        <div class="nm trunc">${r.name ?? `<span class="mono dim">${r.id}</span>`}</div>
        <div class="sub">${r.agents.done}/${r.agents.total}${r.agents.cached ? ` +${r.agents.cached}c` : ''} · ${r.out} out${r.cost ? ` · ${r.cost}` : ''}</div>
      </span>
      <span class="when">${r.when.replace('started ', '')}</span>
    </div>`).join('\n')}
  </div>
</div>`;

export const railStrip = () => `<div class="col strip">
  <button class="icb" aria-label="Expand run rail">${ic('chevron', '14')}</button>
  <span class="vlbl">41 runs</span>
</div>`;

export const inboxStrip = () => `<div class="col strip">
  <button class="icb" aria-label="Expand inbox rail">${ic('mail', '14')}</button>
  <span class="dotn">1</span>
  <span class="vlbl">inbox</span>
</div>`;

/* =========================================================== 800px cockpit */
// §3.7's second required viewport for the cockpit. §3.3 governs it: "below 900px the
// cockpit rails collapse into drawers and the transcript replaces the cockpit". Both rails
// are therefore closed to strips; the main column is the whole width; and the header — five
// metric cells and a gauge in one row at 1440 — wraps to two rows with the gauge given the
// full width, because it is the cell that carries a shape rather than a number.

/** Compressed run header: the same facts, re-ordered for a 756px column. */
const runHeader800 = () => `<div class="rhead narrow">
  <div class="rhead-top">
    ${glyph('running', { spin: true })}
    <h1>${RUN.name}</h1>
    ${chip('running', 'running', { spin: true })}
    <div class="rhead-actions">
      <button class="btn sm">${ic('cancel', '12')}Cancel</button>
      <button class="icb" aria-label="More run actions">${ic('chevdown', '14')}</button>
    </div>
  </div>
  <div class="rhead-sub">
    <button class="rid" title="Copy run id">${RUN.id}${ic('copy', '12')}</button>
    <span class="live-detail">${RUN.liveDetail}</span>
  </div>
  <div class="rhead-metrics">
    <div class="metric" style="min-width:78px"><span class="lbl">elapsed</span><span class="v"><b>${RUN.elapsed}</b></span></div>
    <div class="metric" style="min-width:104px"><span class="lbl">agents</span>
      <span class="v"><b>${RUN.agents.done}</b><span class="u">/${RUN.agents.total}</span>
        <span class="u" style="font-size:11px"> ·${RUN.agents.cached}c ·${RUN.agents.failed}f</span></span></div>
    <div class="metric" style="min-width:126px"><span class="lbl">in / out</span>
      <span class="v">${RUN.tin}<span class="u"> / </span><b>${RUN.tout}</b></span></div>
    <div class="metric" style="min-width:70px"><span class="lbl">cost</span><span class="v"><b>${RUN.cost}</b></span></div>
  </div>
  <div class="metric gauge-cell wide">
    <span class="lbl">budget — output tokens vs budget.total</span>
    <div class="gauge">
      <div class="gauge-bar" role="img"
           aria-label="375.1k of 340k output tokens, 110.3 percent of the soft ceiling">
        <div class="fill" style="width:${BUDGET.ceilingAt}%"></div>
        <div class="over" style="left:${BUDGET.ceilingAt}%;right:0"></div>
        <div class="ceiling" style="left:${BUDGET.ceilingAt}%"></div>
      </div>
      <div class="gauge-legend">
        <b>${BUDGET.spentLabel}</b><span>/ ${BUDGET.totalLabel} out</span>
        <span class="over-l">· ${BUDGET.pct}% · +35.1k over</span>
        <span class="soft" style="margin-left:auto">soft ceiling</span>
      </div>
    </div>
  </div>
  <div class="rhead-lineage">
    <span class="lbl">lineage</span>
    <div class="lineage" style="flex:1">
${LINEAGE.map((s) => `      <span class="seg-l ${s.state}" style="flex:${s.frac}" title="${s.label}"></span>`).join('\n')}
    </div>
    <span class="cap">attempt 2 of 2</span>
  </div>
</div>
<div class="lastlog">
  <span class="src">${LAST_LOG.s}</span>
  <a href="#/run/${RUN.id}/agent/${LAST_LOG.a}" class="mono" style="font-size:11px">agent ${LAST_LOG.a}</a>
  <span class="trunc">${LAST_LOG.m}</span>
  <button class="btn sm ghost" style="margin-left:auto">${ic('columns', '12')}Log <kbd>L</kbd></button>
</div>`;

/** Both rails as the 44px drawer handles §3.3 requires below 900px. */
const drawerStrip = (which) => `<div class="col strip drawer">
  ${which === 'runs'
    ? `<button class="icb" aria-label="Open run rail">${ic('chevron', '14')}</button><span class="vlbl">41 runs</span>`
    : `<button class="icb" aria-label="Open inbox rail">${ic('mail', '14')}</button><span class="dotn">1</span><span class="vlbl">inbox</span>`}
</div>`;

const cockpitLive800 = () => withGeometry(GEOM_800, () => `<div class="app" style="height:856px">
  ${topbar('run')}
  <div class="cockpit narrow" style="height:812px">
    ${drawerStrip('runs')}
    <div class="col">
      ${runHeader800()}
      ${tabs('timeline')}
      ${timelineTab()}
    </div>
    ${drawerStrip('inbox')}
  </div>
</div>`);

/**
 * The failed/stale composition at 800. The difference from the live frame is not a reflow:
 * a dead run has no live gauge to give the full width to, and it has exactly one thing the
 * operator came for — whether it can be resumed — so that card is promoted above the tabs
 * rather than left where the live frame's ticker sits.
 */
const cockpitStale800 = () => withGeometry(GEOM_800, () => `<div class="app" style="height:648px">
  ${topbar('run')}
  <div class="cockpit narrow" style="height:604px">
    <div class="col strip drawer">
      <button class="icb" aria-label="Open run rail">${ic('chevron', '14')}</button>
      <span class="vlbl">41 runs</span>
    </div>
    <div class="col">
      <div class="rhead narrow">
        <div class="rhead-top">
          ${glyph('stale')}
          <h1>audit-viewer-security</h1>
          ${chip('stale')}
          <div class="rhead-actions">
            <button class="btn sm">${ic('resume', '12')}Resume</button>
            <button class="icb" aria-label="More run actions">${ic('chevdown', '14')}</button>
          </div>
        </div>
        <div class="rhead-sub">
          <button class="rid" title="Copy run id">r_7b21c0d4${ic('copy', '12')}</button>
          <span class="live-detail" style="--st-running:var(--st-stale)">run.lock held by pid 48812 — not running</span>
        </div>
        <div class="rhead-metrics">
          <div class="metric" style="min-width:150px"><span class="lbl">died</span>
            <span class="v"><span class="absent"
              title="endedAt is written from a terminal run event and from nothing else (§6.2). A stale run is stale precisely because it wrote none.">not
              recorded</span> <span class="u">· started 1h10m ago</span></span></div>
          <div class="metric" style="min-width:104px"><span class="lbl">agents</span>
            <span class="v"><b>5</b><span class="u">/9</span><span class="u" style="font-size:11px"> ·4 orphaned</span></span></div>
          <div class="metric" style="min-width:126px"><span class="lbl">in / out</span>
            <span class="v">612k<span class="u"> / </span><b>148.2k</b></span></div>
          <div class="metric" style="min-width:70px"><span class="lbl">cost</span><span class="v"><b>$4.10</b></span></div>
        </div>
      </div>
      <div class="resume-card">
        <div class="rc-top">${glyph('stale')}<b>This run's engine died mid-flight.</b></div>
        <p>It wrote no terminal event, so there is no time of death to report — the run started
          1h10m ago and <code>run.lock</code> is held by a pid that is gone.
          4 agents were left unfinished. They render <span class="g u orphan">${ic('orphaned')}</span>
          <b>orphaned</b> — the run's fate, dimmed — never a live spinner (parity #58). Resuming
          replays the 5 that completed from their keys and re-runs only the 4.</p>
        <div class="rc-actions">
          <button class="btn primary">${ic('resume', '12')}Resume run</button>
          <button class="btn">${ic('external', '12')}run.log</button>
          <button class="btn danger" style="margin-left:auto">${ic('trash', '12')}Delete</button>
        </div>
      </div>
      ${tabs('timeline')}
      <div class="tl scroller">
        <div class="tl-head">
          <span class="lbl">timeline</span>
          <span class="tl-note">bars stop where the engine did — no bar is extended to "now"</span>
        </div>
        ${ruler()}
        <div class="lanes">
${[
    { i: 0, state: 'done', adapter: 'claude', label: 'survey:routes', left: 0, w: 118, dur: '3m18s' },
    { i: 1, state: 'done', adapter: 'codex', label: 'survey:auth', left: 0, w: 96, dur: '2m41s' },
    { i: 2, state: 'done', adapter: 'claude', label: 'audit:csp', left: 120, w: 142, dur: '3m58s' },
    { i: 3, state: 'cancelled', adapter: 'codex', label: 'audit:tokens', left: 120, w: 74, dur: '2m04s', orphan: true },
    { i: 4, state: 'cancelled', adapter: 'claude', label: 'audit:rebinding', left: 196, w: 61, dur: '1m42s', orphan: true },
  ].map((a) => `          <div class="lane" style="grid-template-columns:${GEOM_800.label}px 1fr">
            <div class="lane-label">
              <span class="idx">${a.i}</span>
              ${glyph(a.state, { orphan: a.orphan })}
              ${adapter(a.adapter)}
              <span class="nm trunc">${a.label}</span>
            </div>
            <div class="lane-track">
              <div class="bar nowait" style="left:${a.left}px;width:${a.w}px">
                <div class="exec ${CLS[a.state]}${a.orphan ? ' orphan' : ''}" style="flex:1"></div>
              </div>
              <div class="bar-meta" style="left:${a.left + a.w + 8}px">${a.dur}${
  a.orphan ? ' <span class="badge">orphaned</span>' : ''}</div>
            </div>
          </div>`).join('\n')}
        </div>
        <div class="rawgrp" style="margin-top:12px">${ic('unknown', '12')}
          <b>The time of death is unknown, and the header says so.</b>
          <span class="mono">endedAt</span> comes from a terminal <span class="mono">run</span>
          event and from nothing else (§6.2, <span class="mono">src/viewer/summaries.js</span>),
          and a run is <i>stale</i> precisely because the engine went away without writing one.
          Nothing on disk records when the process was last alive: <span class="mono">run.lock</span>
          is written when the engine ACQUIRES the run, so its mtime dates the start, not the
          death, and W6 exposes no <span class="mono">lastSeenAt</span>. Substituting either one
          would turn the run's age into a claim about when it stopped. The built Home already
          renders this the honest way; W11 must not contradict it. An authoritative
          <span class="mono">lastSeenAt</span> on RunSummary is the only thing that would let
          this cell carry a number, and adding it is a W6 change, not a rendering choice.</div>
      </div>
    </div>
    <div class="col strip drawer">
      <button class="icb" aria-label="Open inbox rail">${ic('mail', '14')}</button>
      <span class="vlbl">inbox</span>
    </div>
  </div>
</div>`);

/* ================================== rails as drawers — the OPEN state (§3.6) */
/**
 * §3.3 says "below 900px the cockpit rails collapse into drawers" and parity #42 is the
 * behavior. Every other narrow frame in this set shows the drawers CLOSED, which draws the
 * strip and leaves the drawer itself — the thing §3.6 has requirements about — undrawn.
 * This frame is the open state, with the focus model shown rather than described:
 *
 *   • the scrim is a real element over the whole page below the top bar, and it is
 *     click-to-dismiss — it is NOT a background tint on the drawer;
 *   • opening moves focus to the drawer's header (§3.6: "opening a panel moves focus to
 *     its header"), which is why the focus ring is drawn on the header's title, not on the
 *     first row — a roving-tabindex list must not steal the initial focus;
 *   • Escape closes and focus is RESTORED to the 44px handle that opened it (§3.6, §2.7:
 *     "Esc closes panel / drawer"); selecting a run closes it the same way;
 *   • Tab is contained while it is open. The drawer is a `role=dialog aria-modal` overlay
 *     for exactly as long as it covers the page, so Tab cannot land on the cockpit behind
 *     the scrim — the confirm dialog's trap (§3.6) generalized to any overlay.
 *
 * Both rails use one idiom, so the run rail and the inbox differ only in which edge they
 * come from and what they contain.
 */
const drawerOpen800 = () => withGeometry(GEOM_800, () => `<div class="app" style="height:600px">
  ${topbar('run')}
  <div class="cockpit narrow" style="height:556px">
    <div class="col strip drawer">
      <button class="icb" aria-label="Open run rail" aria-expanded="true">${ic('chevron', '14')}</button>
      <span class="vlbl">41 runs</span>
    </div>
    <div class="col">
      ${runHeader800()}
      ${tabs('timeline')}
    </div>
    <div class="col strip drawer">
      <button class="icb" aria-label="Open inbox rail">${ic('mail', '14')}</button>
      <span class="dotn">1</span>
      <span class="vlbl">inbox</span>
    </div>
  </div>
  <div class="drawer-scrim"></div>
  <div class="drawer-panel left rail-run" role="dialog" aria-modal="true" aria-label="Runs">
    <div class="drawer-head">
      <span class="lbl demo-focus" tabindex="-1">runs</span><span class="count">41</span>
      <div class="right">
        <span class="dim micro mono">esc closes</span>
        <button class="icb" aria-label="Close run rail">${ic('close', '14')}</button>
      </div>
    </div>
    <div class="scroller fade-b">
${RUNS.slice(0, 6).map((r) => `      <div class="rrow"${r.sel ? ' aria-current="true"' : ''} tabindex="${r.sel ? '0' : '-1'}">
        ${glyph(r.state, { spin: r.state === 'running' })}
        <span style="min-width:0">
          <div class="nm trunc">${r.name ?? `<span class="mono dim">${r.id}</span>`}</div>
          <div class="sub">${r.agents.done}/${r.agents.total} · ${r.out} out${r.cost ? ` · ${r.cost}` : ''}</div>
        </span>
        <span class="when">${r.when.replace('started ', '')}</span>
      </div>`).join('\n')}
    </div>
    <div class="drawer-note">
      focus moved here on open · <b>esc</b> closes and returns focus to the 44px handle ·
      <b>j / k</b> rove the list without leaving the drawer · tab is trapped while the scrim is up
    </div>
  </div>
</div>`);

/* ============================================================= 480px cockpit */
const GEOM_480 = { track: 350, label: 104 };

/**
 * 480 is not one of §3.7's required viewports; it is the floor that makes §3.3's single
 * 900px breakpoint buildable. Nothing new happens to the RULES here — the same breakpoint,
 * the same drawers — only to what fits:
 *   • the header metrics wrap two-per-line and the gauge keeps its own full-width row;
 *   • the tab row scrolls rather than collapsing into an overflow menu;
 *   • the Gantt is neither dropped nor rescaled. Ruler, saturation strip and lanes scroll
 *     together inside one horizontal scroller, so they stay on one axis and the trace is
 *     the same trace. Rescaling per viewport would make two screenshots of the same run
 *     uncomparable, which is the one thing a timeline may not do.
 */
const cockpit480 = () => withGeometry(GEOM_480, () => `<div class="app" style="height:720px">
  ${topbar('run')}
  <div class="cockpit narrow" style="height:676px">
    <div class="col strip drawer">
      <button class="icb" aria-label="Open run rail">${ic('chevron', '14')}</button>
    </div>
    <div class="col">
      ${runHeader800()}
      ${tabs('timeline')}
      <div class="tl-scrollx">
        <div style="width:486px">${timelineTab()}</div>
      </div>
    </div>
    <div class="col strip drawer">
      <button class="icb" aria-label="Open inbox rail">${ic('mail', '14')}</button>
      <span class="dotn">1</span>
    </div>
  </div>
</div>`);

/* ==================================================================== page */
export function pageCockpit() {
  const shell = (tabName, content, opts = {}) => `<div class="app" style="height:${opts.h ?? 904}px">
  ${topbar('run')}
  <div class="cockpit full" style="height:${(opts.h ?? 904) - 44}px">
    ${runRail()}
    <div class="col">
      ${runHeader()}
      ${tabs(tabName)}
      ${content}
      ${opts.log ? logLane() : ''}
    </div>
    ${inboxRail()}
  </div>
</div>`;

  const body = `
${frame('Run cockpit — Timeline (default tab, live run, budget overshoot)', '1440 × 904 · §2.4, §3.7', `
  ${shell('timeline', timelineTab(), { h: 904 })}
  ${mk(1, 'top:60px;left:296px')}
  ${mk(2, 'top:104px;left:1000px')}
  ${mk(3, 'top:168px;left:296px')}
  ${mk(4, 'top:262px;left:296px')}
  ${mk(5, 'top:470px;left:352px')}
  ${mk(6, 'top:560px;left:800px')}
  ${mk(7, 'top:640px;left:600px')}
  ${mk(8, 'top:104px;left:1128px')}
`)}

${frame('Run cockpit — Structure (the DAG from E2 fanout paths)', '1440 × 904 · §2.4', `
  ${shell('structure', structureTab(), { h: 904 })}
  ${mk(9, 'top:330px;left:296px')}
  ${mk(10, 'top:470px;left:820px')}
`)}

${frame('Run cockpit — Agents, flat and sorted by cost, with the log lane open', '1440 × 964 · §2.4, §2.4.2', `
  ${shell('agents', agentsTab(), { h: 964, log: true })}
  ${mk(11, 'top:300px;left:1040px')}
  ${mk(12, 'top:760px;left:296px')}
`)}

${frame('Run cockpit — Agents, Phases grouping', '1440 × 904 · §2.4.1', `
  ${shell('agents', phaseTree(), { h: 904 })}
  ${mk(13, 'top:300px;left:640px')}
`)}

${frame('Run cockpit — live, at 800px (§3.7\'s second required viewport)', '800 × 856 · §3.3 · parity #42', `
  ${cockpitLive800()}
  ${mk(14, 'top:180px;left:6px')}
  ${mk(15, 'top:186px;left:60px')}
  ${mk(16, 'top:600px;left:245px')}
  ${mk(17, 'top:298px;left:340px')}
`, 'w800')}

${frame('Run cockpit — failed / stale, at 800px', '800 × 648 · §3.3 · §6.4 step 8 · parity #58', `
  ${cockpitStale800()}
  ${mk(18, 'top:150px;left:56px')}
  ${mk(19, 'top:120px;left:250px')}
`, 'w800')}

${frame('Run cockpit at 800px — the run rail OPEN as a drawer (scrim + focus model)',
    '800 × 600 · §3.3 · §3.6 · parity #42', `
  ${drawerOpen800()}
  ${mk(20, 'top:300px;left:420px')}
  ${mk(21, 'top:96px;left:290px')}
  ${mk(22, 'top:520px;left:290px')}
`, 'w800')}

${frame('Run cockpit at 480px — the floor of §3.3\'s single breakpoint', '480 × 720 · §3.3 · §2.4', `
  ${cockpit480()}
  ${mk(23, 'top:120px;left:56px')}
  ${mk(24, 'top:300px;left:56px')}
  ${mk(25, 'top:400px;left:56px')}
`, 'w800 w480')}

<div class="frame-wrap">
  <div class="frame-head"><h2>Cockpit — degraded and empty states</h2>
    <span class="w">§6.5 · §2.4.2 · parity #60–#62</span></div>
  <div class="frame" style="padding:24px;display:grid;gap:20px">
    <div>
      <div class="lbl" style="margin-bottom:8px">pre-E1 run — every missing capability is named, no panel is blank</div>
      <div class="card" style="padding:0">
        <div class="tl" style="padding:16px">
          <div class="rawgrp" style="margin-bottom:12px">${ic('unknown', '12')}
            <b>Recorded by an older engine (pre-0.2).</b> Queue wait, progress ticks and the
            saturation strip are unavailable for this run; bars start at the first
            <span class="mono">running</span> event. Structure and phase association are
            unavailable too. This is derived from the run event's engine version, never from
            whether a field happened to appear (critique M2).</div>
          <div class="ruler" style="margin-left:120px"><div class="tk" style="left:0"><span>0m</span></div>
            <div class="tk" style="left:160px"><span>1m</span></div><div class="tk" style="left:320px"><span>2m</span></div></div>
          <div class="lanes">
            <div class="lane"><div class="lane-label"><span class="idx">0</span>${glyph('done')}${adapter('unknown')}<span class="nm">agent 0</span></div>
              <div class="lane-track"><div class="bar nowait" style="left:0;width:186px"><div class="exec d" style="flex:1"></div></div>
                <div class="bar-meta" style="left:198px">1m10s</div></div></div>
            <div class="lane"><div class="lane-label"><span class="idx">1</span>${glyph('cancelled')}${adapter('unknown')}<span class="nm">agent 1</span></div>
              <div class="lane-track"><div class="bar nowait" style="left:0;width:92px"><div class="exec x" style="flex:1"></div></div>
                <div class="bar-meta" style="left:104px">35s</div></div></div>
          </div>
        </div>
      </div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
      <div>
        <div class="lbl" style="margin-bottom:8px">snapshot not loaded — skeleton header + skeleton lanes (#61)</div>
        <div class="card" style="padding:16px;display:grid;gap:10px">
          <div style="display:flex;gap:8px;align-items:center"><span class="skel" style="width:14px;height:14px;border-radius:999px"></span><span class="skel" style="width:210px;height:14px"></span></div>
          <div class="skel" style="width:100%;height:44px"></div>
${[70, 52, 84, 40].map((w) => `          <div style="display:grid;grid-template-columns:120px 1fr;gap:12px;align-items:center"><span class="skel" style="width:88px"></span><span class="skel" style="width:${w}%;height:12px"></span></div>`).join('\n')}
        </div>
      </div>
      <div>
        <div class="lbl" style="margin-bottom:8px">loaded, zero agents (#60) — and the stale-run resume path</div>
        <div class="card" style="padding:0;margin-bottom:12px">
          <div class="empty" style="padding:28px 24px">
            ${ic('gantt', '20', 'dim')}
            <p style="font-size:13px">No agents yet — the workflow hasn't called <span class="mono">agent()</span>.</p>
          </div>
        </div>
        <div class="card" style="padding:12px">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
            ${glyph('stale')}<span class="strong">audit-viewer-security</span>${chip('stale')}
            <span class="live-detail" style="--st-running:var(--st-stale)">run.lock held by pid 48812 — not running</span>
          </div>
          <div class="meta" style="margin-bottom:10px">4 agents were left mid-flight. They render
            <span class="g u orphan">${ic('orphaned')}</span> <b>orphaned</b> — the run's fate, dimmed — never a live spinner (parity #58).</div>
          <div style="display:flex;gap:6px"><button class="btn">${ic('resume', '12')}Resume</button>
            <button class="btn danger">${ic('trash', '12')}Delete</button></div>
        </div>
      </div>
    </div>
  </div>
</div>`;

  return page({
    title: 'Run cockpit',
    file: 'cockpit.html',
    sections: '§2.4, §2.4.1, §2.4.2, §3.7',
    viewports: '1440 + 800',
    note: 'run rail 280 · main 840 · inbox 320',
    body,
    notes: [
      `<b>The grid is §3.7 verbatim at 1440:</b> run rail 280 (drag 200–480) │ main 840
       (min 640) │ inbox rail 320 (drag 260–420). Default states are also §3.7's: run rail open,
       inbox rail open <i>because there is an open question</i>, log lane closed, Timeline active.
       The active run carries a 2px accent left edge plus <code>--surface-selected</code> — the
       only place selection is expressed, and it costs no saturated color.`,

      `<b>The budget gauge plots output tokens only.</b> <code>spend.output</code> 375.1k against
       <code>budget.total</code> 340k. Input tokens (1.51M) and cost ($9.05) sit in their own
       metric cells and never enter the bar (critique M19). Past the ceiling marker the bar is
       hatched red and the legend says <i>soft ceiling</i>: the engine checks the budget before
       admitting an agent and never kills a running one, so the UI must not imply a hard cap.
       <b>Rule on this:</b> hatch-past-ceiling vs. a separate overflow segment to the right.`,

      `<b>Liveness is a ladder, not a dot (Q2).</b> Three independent signals are on screen: the
       state chip's <code>deriveRunState().detail</code> ("run.lock held by live pid 51204"), the
       lineage strip showing this is attempt 2 after an interruption, and per-agent
       <code>lastOutputAt</code> age. Below the header, the last log line is a single truncated
       row (parity #59) with the log lane one keystroke away.`,

      `<b>The saturation strip is the argument for the Timeline tab (Q5).</b> Concurrency 2 is
       pinned at the ceiling for 13 of 14 minutes with two agents queued the entire time — the
       chart's conclusion, "raise <code>--concurrency</code>", is legible in under a second. The
       trace is mechanically valid: every hatched wait ends exactly when a slot frees, and each
       wait segment's tooltip names the releasing agent. <b>Rule on this:</b> is the queue-depth
       overlay (hatched, stacked above active) readable, or should queue depth be its own strip?`,

      `<b>Queue wait is hatched, execution is solid, and both are drawn to scale.</b> Agent 6
       waited 3m08s and ran 2m26s; agent 4 failed after 2.0s and still gets a real width from
       E5's <code>durationMs</code> rather than vanishing. Agents 8 and 9 are still queued, so
       their bars are open-ended hatch with no execution segment at all — the shape says
       "nothing has happened yet" without a label.`,

      `<b>Agent 5 is quiet, not stuck — and the UI says which.</b> Its last provider output was
       6m18s ago against an <i>emitted</i> <code>stallMs</code> of 30m (E4), which crosses the
       50% warning line, so it gets an amber "quiet for 6m18s" tag. Amber, not red: nothing has
       failed. On an old run with no emitted <code>stallMs</code> the tag reads "quiet for Nm
       (stall threshold unknown)" against the 30m engine default (critique M10 / Sol-11).`,

      `<b>Faint notches on a running bar are E6 progress ticks</b> — real provider-output
       timestamps, never a progress event's arrival time (Sol-11). Bars are clickable straight to
       the transcript, which is the single most-used path in the product.`,

      `<b>The inbox rail is a work queue in three registers:</b> open questions with an inline
       composer (the region's one accent action), agent reports (<code>mail dir:out</code> —
       a surface no watch-only viewer has), and steering history (<code>dir:in</code>) with the
       delivery verdict and the callsite when journalled. The dropped verdict on agent 4 is shown
       in red because a steer that never landed is a fact the operator must know.`,

      `<b>The DAG renders the container shape, not a tree of names.</b> <code>parallel(3)</code>
       is a fan of item lanes; <code>pipeline(5 × 2)</code> is a 5-row × 2-stage grid, which is
       the only view that explains why 7 of 10 slots exist. Container headers roll up
       state/cost/duration; the cached agent carries the replay badge.`,

      `<b>Two empty cells, two different honest reasons.</b> Item 1 stage 1 says "skipped — stage
       0 threw" (the pipeline dropped that item); items 2 and 4 say "not created — stage 0 still
       running". A generic dash would have collapsed a permanent outcome and a pending one into
       the same glyph. Phase 2 (Report) is declared in <code>meta.phases</code> but not reached,
       so it is dimmed "pending" — and would read "not run" once the run goes terminal.`,

      `<b>The agents table shows the error message inline, truncated to one row</b> (parity #54)
       with the code as a mono chip beside it. Absent fields are <i>blank</i>, never
       <code>0</code> or <code>—</code> (parity #53): agent 4 never reported usage, so its in/out/cost
       cells are empty. 13 columns at 32px still read cleanly because only the label column is
       proportional; everything else is a fixed mono column.`,

      `<b>The log lane is the whole stream</b>, paged backwards, with workflow/engine source
       lanes and level filters — a last-line readout (<code>logs.at(-1)</code>) is a status,
       not a log view. Agent-index chips are links. It overlays the main column bottom at 240px and is
       closed by default.`,

      `<b>Phase collapse has a memory.</b> Survey's agents are all done/cached so the automatic
       rule would collapse it; the "kept open by you" marker shows the explicit toggle winning,
       stored per <code>(runId, phaseIndex)</code> for the life of the page and surviving later
       fold updates (parity #50, DOM-tested per #119).`,

      `<b>800px: both rails become 44px drawer handles, and neither is a hidden feature.</b>
       §3.3 / parity #42. The run handle keeps the run count and the inbox handle keeps its open
       count, so the two questions a closed rail would otherwise hide — how many runs, is
       anything waiting on me — are still answered on the strip. Tapping either opens it as an
       overlay over the main column; Escape closes it and returns focus to the handle (§3.6).
       <b>Rule on this:</b> two 44px strips cost 88px of an 800px viewport. The alternative is
       one strip plus a top-bar inbox button, which is cheaper but splits the two rails into two
       different idioms.`,

      `<b>800px: the header wraps to four rows, and the gauge takes a row of its own.</b> At
       1440 the five metric cells and the gauge share one row. At 800 the four number cells stay
       together — they are scanned as a block — and the gauge, which carries a <i>shape</i>
       rather than a number, gets the full 756px rather than being squeezed to ~200px where the
       hatched overshoot zone stops being legible. The run id and the liveness detail drop to
       their own line under the title so the title never truncates.`,

      `<b>800px: the Gantt keeps its scale, and only the label column pays.</b> The lane label
       narrows 168 → 120px and the track 640 → 508px; every bar, notch, wait segment and grid
       line is recomputed from the same fixture times, so the trace is the 1440 trace drawn
       narrower — not a redrawn approximation. The saturation strip is unchanged in height: it
       is the tab's whole argument (Q5) and shrinking it would be shrinking the conclusion.
       <b>Rule on this:</b> at 508px the two-minute grid is tight; the alternative is a
       four-minute grid below 900px.`,

      `<b>800px: the tab row keeps all three tabs.</b> Timeline / Structure / Agents fit in
       756px with the "[ ] to switch" hint dropped. Nothing moves into an overflow menu — the
       tabs are the cockpit's primary navigation and a tab behind a menu is a tab nobody uses.`,

      `<b>800px stale: the resume card is promoted above the tabs.</b> This is the one place the
       narrow layout REORDERS rather than reflows, and it is deliberate. An operator opening a
       dead run at 800px came for one decision — resume or delete — and at 1440 that card sits in
       the panel area below the fold. Here it is the first thing under the header, and it is the
       only accent-filled action on the screen (§3.7's action hierarchy: one primary per region).
       <b>Rule on this:</b> promotion is a layout difference between viewports, which the rest of
       this comp set avoids.`,

      `<b>800px stale: bars stop where the engine did, orphaned agents are dimmed, and the
       time of death is stated as UNKNOWN.</b> The two unfinished agents carry the orphaned mark
       (§6.4 step 8 / parity #58) and their bars end at the last event rather than being extended
       to "now" — a dead run has no "now". The <code>died</code> cell reads <i>not recorded</i>
       for the same reason: <code>endedAt</code> is written from a terminal <code>run</code> event
       and from nothing else (§6.2), and a run is stale precisely because it wrote none.
       <b>An earlier revision of this frame said "died 26m ago", derived from the
       <code>run.lock</code> mtime. That was wrong and is withdrawn</b> — the lock is created when
       the engine ACQUIRES the run, so its mtime dates the start; W6 exposes no death time and no
       <code>lastSeenAt</code>; and the shipped Home already renders this case honestly
       (<code>AttentionStrip.tsx</code>: "It wrote no terminal event, so there is no time of death
       to report"). Approving the old frame would have instructed W11 to contradict the live API
       and §6.5. <b>Rule on this:</b> "not recorded · started 1h10m ago" in the metric cell, versus
       dropping the cell entirely on a run that has no death time to show.`,

      `<b>The drawer is an overlay with a real scrim, not a rail that got narrow.</b> §3.3 puts
       one breakpoint at <b>900px</b> — the only one in this comp set, and the same one at 800 and
       at 480. Below it both rails become 44px handles, and tapping a handle slides its drawer
       over the page with a scrim across everything under the top bar. The scrim is
       click-to-dismiss and is an element, not a tint on the panel: the operator must be able to
       leave the drawer by pointing at the thing they were reading. The top bar stays uncovered so
       the run is still identifiable while the drawer is open. <b>Rule on this:</b> the scrim at
       ink 42%, and whether the drawer should come from the same edge as its handle (it does here)
       or always from the left.`,

      `<b>The §3.6 focus model, drawn.</b> Opening moves focus to the drawer's HEADER, not to the
       first row — a roving-tabindex list that grabs initial focus makes the first run look
       selected. <b>Escape</b> closes and focus is <i>restored</i> to the 44px handle that opened
       it (§2.7: "Esc closes panel / drawer"), and so does choosing a run, so the operator never
       lands back at the top of the document. While the scrim is up the drawer is
       <code>role="dialog" aria-modal="true"</code> and Tab is contained inside it — the confirm
       dialog's trap (§3.6) generalized to any overlay, because a Tab that reaches the cockpit
       behind a scrim is a keyboard user operating a UI they cannot see.`,

      `<b>What the drawer does NOT do.</b> It does not remember scroll position across opens (the
       selected run is scrolled into view instead), it does not animate wider than
       §3.4's 200ms panel slide, and <code>prefers-reduced-motion</code> replaces the slide with
       an instant swap while keeping the scrim — the scrim carries the "you are in an overlay"
       information and is not decoration. <b>Rule on this:</b> the drawer is 320px at 800 and
       300px at 480, rather than full-bleed.`,

      `<b>480px: the same breakpoint, not a new one.</b> §3.3 names 900px and this comp set
       introduces no second threshold — 480 is drawn to show that the &lt;900px rules bottom out
       somewhere real. What changes is only what fits: the header metrics wrap two per line, the
       budget gauge keeps its own full-width row (it carries a shape, not a number), and the tab
       row scrolls. <b>All three tabs are still tabs</b> — nothing moves into an overflow menu, at
       any viewport.`,

      `<b>480px: the Gantt is neither dropped nor rescaled — it SCROLLS.</b> The lane label
       narrows 170 → 104px and the plot keeps its 350px track, so the bars, notches, wait
       segments and grid lines are the same geometry as the 800px frame. Ruler, saturation strip
       and lanes scroll together in one horizontal scroller, so they never come off a common
       axis. The alternative — rescaling the track to the viewport — would mean two screenshots
       of the same run could not be compared, which is the one thing a timeline may not do.
       <b>Rule on this:</b> horizontal scroll versus a four-minute grid below 600px.`,

      `<b>480px: the saturation strip stays, at full height.</b> It is the Timeline tab's whole
       argument (Q5 — "raise <code>--concurrency</code>"), and a strip shrunk to a hairline is a
       conclusion nobody reads. It is the first thing that would go if the tab had to lose
       something; it does not have to, because the tab scrolls. The run table at 480 is where
       something genuinely goes: its rows wrap into a two-line record (identity, then the numbers
       as a meta strip) and the column header row is dropped, because every remaining value is
       self-describing and a column label with no column is furniture.`,
    ],
  });
}
