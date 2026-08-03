import { page, frame, mk, topbar, ic, chip, glyph, adapter } from './shell.mjs';
import { AGENTS, RUN } from './fixtures.mjs';
import { railStrip, inboxStrip } from './page-cockpit.mjs';

const A5 = AGENTS[5];   // review:tests — claude / opus-5 / xhigh, running, quiet 6m18s
const A3 = AGENTS[3];   // review:auth — done, the compare panel

/** A transcript row: absolute time in the gutter at minute boundaries, relative on hover. */
const row = (time, rel, inner, cls = '') => `      <div class="trow ${cls}">
        <div class="gut">${time ? `<span class="abs">${time}</span>` : ''}<span class="rel dim">${rel}</span></div>
        <div class="bd">${inner}</div>
      </div>`;

/* ------------------------------------------------------------------ blocks */
const promptBlock = `<div class="prompt-block">
  <div class="ph">${ic('tool', '14', 'dim')}<span class="lbl">prompt</span>
    <span class="dim micro mono">6,142 chars · full text (E10)</span>
    <div class="right">
      <button class="btn sm ghost">${ic('copy', '12')}Copy</button>
      <button class="btn sm">${ic('chevdown', '12')}Expand</button>
    </div>
  </div>
  <div class="pb">Review the test suite for the auth change on branch feat-frontend.

You are one of five reviewers in a judge panel. Your dimension is TESTS. Do not
review style, performance, or routing — other reviewers own those and duplicate
findings are discarded at the merge stage.

Read, in order:
  1. test/viewer-http.test.js — the security matrix
  2. test/zero-deps.test.js — the import denylist
  3. src/viewer/auth.js — the implementation under review

For every gap you find, return {file, line, claim, failure_scenario}. A finding
without a concrete failure scenario is not a finding; drop it rather than pad the
list. Rank by severity, most severe first.</div>
  <div class="pf">${ic('unknown', '12')}
    full prompt recorded — the 4,000-char cap marker is absent, so nothing was truncated</div>
</div>`;

const reasoningBlock = `<div class="reason">
  <button class="reason-h" aria-expanded="false">
    ${ic('reasoning', '14', 'dim')}
    <span class="lbl" style="flex:none">reasoning</span>
    <span class="prev trunc">The security matrix covers Host and token but I don't see a
      constant-time comparison test — checking whether…</span>
    <span class="dim micro mono" style="flex:none">14 lines</span>
    ${ic('chevron', '', 'chev')}
  </button>
</div>`;

const stepCollapsed = `<div class="step">
  <button class="step-head" aria-expanded="false">
    ${ic('chevron', '', 'chev')}
    ${ic('tool', '14', 'dim')}
    <span class="sum">Ran 3 commands, explored 5 files</span>
    <span class="right"><span>8 rows</span><span>1m04s</span></span>
  </button>
</div>`;

const toolCard = `<div class="tcard">
  <div class="tcard-h">${ic('search', '14', 'dim')}<span class="tn">Grep</span>
    <span class="right">
      <span class="pairid" title="paired by toolUseId → id (E11), not by position">id toolu_01H9…f3</span>
      <span>2.1s</span>
    </span>
  </div>
  <div class="args">
    <div class="a"><span class="k">pattern</span><span class="v">timingSafeEqual|===\\s*expected</span></div>
    <div class="a"><span class="k">path</span><span class="v">src/viewer</span></div>
    <div class="a"><span class="k">output_mode</span><span class="v">content</span></div>
    <div class="a"><span class="k">-n</span><span class="v">true</span></div>
  </div>
  <div class="tres">
    <div class="tres-h">${ic('check', '12')}result · 2 matches</div>
    <div class="tres-b">src/viewer/auth.js:71:  if (provided === expected) return true
src/viewer/auth.js:88:  // TODO: constant-time compare</div>
  </div>
</div>`;

const toolCardLongHeader = `<div class="tcard">
  <div class="tcard-h">${ic('tool', '14', 'dim')}<span class="tn">Task</span>
    <span class="right"><span class="pairid">id toolu_01K2…9c</span><span>18.4s</span></span>
  </div>
  <div class="args clamp3">
    <div class="a"><span class="k">subagent_type</span><span class="v">general-purpose</span></div>
    <div class="a"><span class="k">description</span><span class="v">Trace every reader of the read token</span></div>
    <div class="a"><span class="k">prompt</span><span class="v">Find every code path that reads
      the viewer read token, including the SSE handshake, the static file handler, and the
      control bridge. For each, report whether the comparison is constant-time and whether the
      token can reach a log line or an error envelope…</span></div>
  </div>
  <button class="showmore">${ic('chevdown', '12')}Show more</button>
  <div class="tres">
    <div class="tres-h">${ic('check', '12')}result · 1,204 chars</div>
    <div class="tres-b">3 readers. auth.js:71 uses ===; http.js:212 delegates to auth.js;
stream.js:96 delegates. No reader logs the token. The 403 envelope echoes the Host header
but not the token.</div>
  </div>
</div>`;

const errorToolCard = `<div class="tcard err">
  <div class="tcard-h">${ic('tool', '14')}<span class="tn">Read</span>
    <span class="right"><span class="pairid">id toolu_01M4…7a</span></span>
  </div>
  <div class="args">
    <div class="a"><span class="k">file_path</span><span class="v">/repo/test/viewer-auth.test.js</span></div>
  </div>
  <div class="tres">
    <div class="tres-h">${ic('failed', '12')}error</div>
    <div class="tres-b">ENOENT: no such file or directory. Did you mean test/viewer-http.test.js?</div>
  </div>
</div>`;

const terminalCard = `<div class="well">
  <div class="well-h">${ic('terminal', '14')}
    <span class="cmd">node scripts/test.mjs 2>&amp;1 | tail -40 &amp;&amp; echo "---" &amp;&amp; git diff --stat HEAD~1</span>
    <span class="right"><span class="a8">4.2s</span></span>
  </div>
  <div class="well-b"><span class="a8">$</span> node scripts/test.mjs
<span class="a2">✔</span> auth: rejects a wrong Host header <span class="a8">(4ms)</span>
<span class="a2">✔</span> auth: rejects a missing token <span class="a8">(2ms)</span>
<span class="a2">✔</span> auth: rejects a mutation without the control token <span class="a8">(3ms)</span>
<span class="a1">✖</span> auth: token comparison is constant-time <span class="a8">(1ms)</span>
  <span class="a3">expected</span> <span class="a6">timingSafeEqual</span> <span class="a3">got</span> <span class="a6">strict equality</span>
  <span class="a8">at test/viewer-http.test.js:214</span>
<span class="a11 abold">warning</span> <span class="a7">1 failing, 143 passing</span>
<span class="a8">---</span>
 src/viewer/auth.js | 22 <span class="a2">++++++++++++++++</span><span class="a1">------</span></div>
  <div class="well-f">${ic('close', '12')}<span class="ec">exit code 1</span>
    <span class="a8">· command clamps to two lines collapsed; a mouseup after a text selection does not toggle it</span></div>
</div>`;

const diffCard = `<div class="fcard">
  <div class="frow">
    ${ic('fileedit', '14', 'dim')}
    <span class="path"><span class="dim">src/viewer/</span><b>auth.js</b></span>
    <span class="verb">edited</span>
    <span class="stat"><span class="add">+18</span><span class="del">−4</span>
      <span class="barsq"><i class="a"></i><i class="a"></i><i class="a"></i><i class="a"></i><i class="d"></i></span></span>
  </div>
  <div class="fdiff">
    <div class="dl hunk"><span class="ln"></span><span class="ln"></span><span class="tx">@@ -66,8 +66,22 @@ export function verifyReadToken (provided, expected) {</span></div>
    <div class="dl"><span class="ln">66</span><span class="ln">66</span><span class="tx">   if (typeof provided !== 'string') return false</span></div>
    <div class="dl del"><span class="ln">67</span><span class="ln"></span><span class="tx">-  if (provided === expected) return true</span></div>
    <div class="dl del"><span class="ln">68</span><span class="ln"></span><span class="tx">-  return false</span></div>
    <div class="dl add"><span class="ln"></span><span class="ln">67</span><span class="tx">+  const a = Buffer.from(provided, 'utf8')</span></div>
    <div class="dl add"><span class="ln"></span><span class="ln">68</span><span class="tx">+  const b = Buffer.from(expected, 'utf8')</span></div>
    <div class="dl add"><span class="ln"></span><span class="ln">69</span><span class="tx">+  if (a.length !== b.length) return false</span></div>
    <div class="dl add"><span class="ln"></span><span class="ln">70</span><span class="tx">+  return timingSafeEqual(a, b)</span></div>
    <div class="dl"><span class="ln">69</span><span class="ln">71</span><span class="tx"> }</span></div>
  </div>
  <div class="frow">
    ${ic('filenew', '14', 'dim')}
    <span class="path"><span class="dim">test/</span><b>viewer-auth-timing.test.js</b></span>
    <span class="verb">created</span>
    <span class="stat"><span class="add">+41</span>
      <span class="barsq"><i class="a"></i><i class="a"></i><i class="a"></i><i class="a"></i><i class="a"></i></span></span>
  </div>
  <div class="frow">
    ${ic('filemove', '14', 'dim')}
    <span class="path"><span class="dim">test/</span><b>auth.test.js</b> <span class="dim">→ test/viewer-http.test.js</span></span>
    <span class="verb">renamed</span>
    <span class="stat dim">no content change</span>
  </div>
  <div class="frow">
    ${ic('filedel', '14', 'dim')}
    <span class="path"><span class="dim">scratch/</span><b>probe.mjs</b></span>
    <span class="verb">deleted</span>
    <span class="stat"><span class="del">−12</span>
      <span class="barsq"><i class="d"></i><i class="d"></i><i class="d"></i><i class="d"></i><i class="d"></i></span></span>
  </div>
  <div class="nodiff">${ic('unknown', '12')} <b>package-lock.json</b> — no diff available: the tool
    reported the write but returned no body and no arguments to synthesize one (#82). The card is
    explicit rather than empty.</div>
</div>`;

const answer = `<div class="prose">
  <p>Two gaps in the security matrix, both exploitable, ranked by severity.</p>
  <h3>1 — the token comparison is not constant-time</h3>
  <p><code>verifyReadToken</code> at <code>src/viewer/auth.js:71</code> uses <code>===</code>.
  Node short-circuits string comparison on the first differing byte, so response latency leaks
  a prefix oracle. With the viewer bound to <code>127.0.0.1</code> this needs local code
  execution to exploit, which is exactly the threat the control token exists to bound.</p>
  <ul>
    <li><b>Fix:</b> <code>timingSafeEqual</code> on equal-length buffers, length-check first.</li>
    <li><b>Test:</b> assert the comparator identity, not the timing — a timing assertion is flaky in CI.</li>
  </ul>
  <h3>2 — the Host check accepts a trailing dot</h3>
  <p><code>127.0.0.1.</code> is a distinct, valid Host that resolves identically and is not in
  the allowlist, so DNS-rebinding protection can be walked past.</p>
  <blockquote>Both findings are in <code>auth.js</code>. Neither is covered by the 144-test
  suite, so both would survive a green run.</blockquote>
  <div class="fence">
    <div class="fh">js<span style="margin-left:auto"><button class="btn sm ghost">${ic('copy', '12')}Copy</button></span></div>
    <pre>const host = (req.headers.host ?? '').replace(/\\.$/, '').toLowerCase()
if (!ALLOWED_HOSTS.has(host)) return deny(403, 'bad_host')</pre>
  </div>
</div>`;

const steerMarker = `<div class="marker">
  ${ic('steered', '14')}
  <span><b>operator</b> steered this agent — “Also check the SSE endpoint for token leakage in
    error envelopes.”</span>
  <span class="right"><span class="verdict live">live</span><span class="dim micro mono">14:15:03</span></span>
</div>`;

const attemptMarker = `<div style="display:flex;align-items:center;gap:10px">
  <span class="seg-l" style="height:1px;flex:1;background:var(--hairline-strong)"></span>
  <span class="badge">${ic('resume', '12')}attempt 2 begins here</span>
  <span class="seg-l" style="height:1px;flex:1;background:var(--hairline-strong)"></span>
</div>`;

/* ------------------------------------------------------------------- panel */
/** Every row type, in journal order. `slice` limits how many the framed split shows. */
const ROWS = [
  ['14:10:19', '11m ago', () => promptBlock, ''],
  ['', '11m ago', () => attemptMarker, ''],
  ['14:11', '10m ago', () => reasoningBlock, ''],
  ['', '10m ago', () => stepCollapsed, ''],
  ['14:12', '9m ago', () => toolCard, ''],
  ['', '9m ago', () => terminalCard, 'breakout'],
  ['14:14', '8m ago', () => diffCard, 'breakout'],
  ['', '8m ago', () => errorToolCard, ''],
  ['14:15', '7m ago', () => steerMarker, ''],
  ['', '7m ago', () => `<div class="sysline">session resumed · sess_a91f4c…2e · model claude-opus-5</div>`, ''],
  ['14:16', '6m ago', () => toolCardLongHeader, ''],
  ['', '6m ago', () => `<div class="rawgrp">${ic('chevron', '12')}6 unparsed provider lines
      <span style="margin-left:auto">kinds this client does not know render as neutral raw JSON — never dropped, never read as success</span></div>`, ''],
  ['14:17', '5m ago', () => answer, ''],
];
const rows = (n) => ROWS.slice(0, n).map(([t, rel, f, cls]) => row(t, rel, f(), cls)).join('\n');

const transcriptPanel = (n = ROWS.length, { clip = true, compare = false } = {}) => `<div class="col tp">
  <div class="tp-head">
    <div class="r1">
      ${glyph('running', { spin: true })}
      <h2>review:tests</h2>
      <span class="aidx">agent 5</span>
      ${chip('running', 'running', { spin: true })}
      <div class="right">
        <button class="btn sm ghost">${ic('search', '12')}In transcript</button>
        ${compare
    ? `<button class="btn sm ghost" aria-pressed="true">${ic('drag', '12')}Pinned</button>
        <button class="icb" aria-label="Close this panel">${ic('close', '14')}</button>`
    : `<button class="btn sm ghost">${ic('columns', '12')}Compare</button>
        <button class="icb" aria-label="Close transcript panel">${ic('close', '14')}</button>`}
      </div>
    </div>
    <div class="tp-facts">
      <span>${adapter(A5.adapter)} claude <span class="k">·</span> ${A5.model} <span class="k">·</span> ${A5.effort}</span>
      <span><span class="k">lifetime</span> ${A5.tin} in / <b>${A5.tout}</b> out <span class="live">·</span></span>
      <span><span class="k">cost</span> ${A5.cost}</span>
      <span><span class="k">running</span> ${A5.dur}</span>
      <span><span class="quiet-tag">${ic('stale', '12')}quiet for ${A5.quiet}</span></span>
      <span><button class="rid" title="provider conversation handle">sess_a91f4c…2e ${ic('copy', '12')}</button></span>
    </div>
    <div class="attempt-bar">
      <span class="lbl">attempt</span>
      <div class="attempt-steps">
        <button aria-pressed="false">1</button><button aria-pressed="true">2</button>
      </div>
      <span class="lt">2 of 2 · <b>this attempt</b> 58.4k out · $1.692 · 11m46s
        <span class="dim">│ <b>lifetime</b> ${A5.tout} out · ${A5.cost}</span></span>
      <button class="btn sm ghost" style="margin-left:auto">${ic('chevdown', '12')}Attempt 1</button>
    </div>
  </div>

  <div class="tp-body${clip ? ' fade-b' : ''}"${clip ? '' : ' style="overflow:visible"'}>
${rows(n)}
  </div>

  <div class="tp-foot">
    <div class="working">${ic('running', '12', 'ic-spin')}Thinking…</div>
    <form class="composer" onsubmit="return false">
      <label class="vh" for="steer">Steer this agent</label>
      <input class="inp" id="steer" placeholder="steer this agent — it is running, so the message lands live">
      <button class="btn primary" type="submit">${ic('send', '12')}Send</button>
      <button class="btn danger">${ic('cancel', '12')}Cancel agent</button>
      <span class="hint">
        <span><kbd>⌘</kbd><kbd>↵</kbd> sends</span>
        <span>enabled because the folded state is exactly <span class="mono">running</span></span>
        <span style="margin-left:auto">2 steers delivered</span>
      </span>
    </form>
  </div>
</div>`;

/* ------------------------------------------- the SECOND panel: agent 3, done */
/**
 * The compared agent. §2.5's "up to two panels side-by-side" is only comped if the second
 * panel is DRAWN — review round 3 found both compare frames showing one pane plus an
 * affordance, which is the state the operator is in *before* the comparison, not the
 * comparison. So this is a full panel, not a stub: its own header, its own facts row, its
 * own rows, and the footer a NON-running agent gets (§2.5 — steering closes with the
 * agent, and the working indicator is never shown for one that is not live).
 *
 * Its content is the same step from the other side, which is the whole reason to compare:
 * agent 3 reached the same `auth.js:71` finding from the Host check rather than from the
 * test suite, cheaper and with one fewer attempt.
 */
const stepB = `<div class="step">
  <button class="step-head" aria-expanded="false">
    ${ic('chevron', '', 'chev')}
    ${ic('tool', '14', 'dim')}
    <span class="sum">Read 3 files, ran the auth suite</span>
    <span class="right"><span>6 rows</span><span>48s</span></span>
  </button>
</div>`;

const toolCardB = `<div class="tcard">
  <div class="tcard-h">${ic('search', '14', 'dim')}<span class="tn">Grep</span>
    <span class="right">
      <span class="pairid" title="paired by toolUseId → id (E11), not by position">id toolu_01B7…a4</span>
      <span>1.4s</span>
    </span>
  </div>
  <div class="args">
    <div class="a"><span class="k">pattern</span><span class="v">ALLOWED_HOSTS|req.headers.host</span></div>
    <div class="a"><span class="k">path</span><span class="v">src/viewer</span></div>
  </div>
  <div class="tres">
    <div class="tres-h">${ic('check', '12')}result · 3 matches</div>
    <div class="tres-b">src/viewer/auth.js:52:  const host = req.headers.host ?? ''
src/viewer/auth.js:71:  if (provided === expected) return true</div>
  </div>
</div>`;

const answerB = `<div class="prose">
  <p>One finding. It is the same line agent 5 reached — from the Host check, not from the
  test suite — which is what makes these two panels worth reading side by side.</p>
  <h3>1 — <code>verifyReadToken</code> compares with <code>===</code></h3>
  <p><code>src/viewer/auth.js:71</code>. Same fix: <code>timingSafeEqual</code> over
  equal-length buffers. I did <b>not</b> find the trailing-dot Host bypass; my Grep stopped at
  the allowlist membership test.</p>
</div>`;

const steerMarkerB = `<div class="marker">
  ${ic('steered', '14')}
  <span><b>operator</b> steered this agent — “Rank by exploitability, not by file.”</span>
  <span class="right"><span class="verdict live">delivered</span><span class="dim micro mono">14:05:41</span></span>
</div>`;

const ROWS_B = [
  ['14:02', '14m ago', () => `<div class="sysline">attempt 1 · sess_5c02be…91 · model claude-opus-5</div>`, ''],
  ['', '13m ago', () => stepB, ''],
  ['14:04', '12m ago', () => toolCardB, ''],
  ['', '12m ago', () => steerMarkerB, ''],
  ['14:06', '11m ago', () => answerB, ''],
  ['', '11m ago', () => `<div class="rawgrp">${ic('unknown', '12')}2 unparsed provider lines
      <span style="margin-left:auto">the same neutral treatment the other panel gives them — a compare must not render one agent's unknowns differently</span></div>`, ''],
  ['14:07', '10m ago', () => `<div class="sysline">agent finished · ${A3.tout} out · ${A3.cost} recorded to the journal</div>`, ''],
];

const rowsB = (n = ROWS_B.length) =>
  ROWS_B.slice(0, n).map(([t, rel, f, cls]) => row(t, rel, f(), cls)).join('\n');

const comparedPanel = (n = ROWS_B.length) => `<div class="col tp">
  <div class="tp-head">
    <div class="r1">
      ${glyph('done')}
      <h2>${A3.label}</h2>
      <span class="aidx">agent 3</span>
      ${chip('done')}
      <div class="right">
        <button class="btn sm ghost">${ic('search', '12')}In transcript</button>
        <button class="btn sm ghost" aria-pressed="true">${ic('drag', '12')}Pinned</button>
        <button class="icb" aria-label="Close this panel">${ic('close', '14')}</button>
      </div>
    </div>
    <div class="tp-facts">
      <span>${adapter(A3.adapter)} claude <span class="k">·</span> ${A3.model} <span class="k">·</span> ${A3.effort}</span>
      <span><span class="k">lifetime</span> ${A3.tin} in / <b>${A3.tout}</b> out</span>
      <span><span class="k">cost</span> ${A3.cost}</span>
      <span><span class="k">ran</span> ${A3.dur}</span>
      <span><span class="k">steers</span> ${A3.steers}</span>
      <span><button class="rid" title="provider conversation handle">sess_5c02be…91 ${ic('copy', '12')}</button></span>
    </div>
  </div>

  <div class="tp-body fade-b">
${rowsB(n)}
  </div>

  <div class="tp-foot">
    <form class="composer" onsubmit="return false">
      <label class="vh" for="steerB">Steer this agent</label>
      <input class="inp" id="steerB" disabled value="agent finished — steering closes with the agent">
      <button class="btn" type="submit" aria-disabled="true">${ic('send', '12')}Send</button>
      <button class="btn" aria-disabled="true">${ic('cancel', '12')}Cancel agent</button>
      <span class="hint">
        <span>no working indicator: this agent is not live (parity #58)</span>
        <span style="margin-left:auto">1 steer delivered</span>
      </span>
    </form>
  </div>
</div>`;

/** The bar both panels hang from — identity of the pair, the shared pin, and the delta. */
const compareBar = ({ swapKbd = true } = {}) => `<div class="cmp-bar">
  <span class="lbl">comparing</span>
  <span class="cmp-who">${glyph('running', { spin: true })}<b>review:tests</b><span class="aidx">agent 5</span></span>
  <span class="k">vs</span>
  <span class="cmp-who">${glyph('done')}<b>review:auth</b><span class="aidx">agent 3</span></span>
  <div class="cmp-right">
    <button class="btn sm ghost">${ic('columns', '12')}Swap${swapKbd ? ' <kbd>\\</kbd>' : ''}</button>
    <button class="icb" aria-label="End comparison">${ic('close', '14')}</button>
  </div>
</div>`;

const comparePin = `<div class="cmp-pin">
  ${ic('drag', '12')}
  <span>pinned to <b>step 4 — “run the auth suite”</b></span>
  <span class="k">·</span>
  <span>both panels scroll to the matching step; either can be unpinned</span>
  <span class="delta" style="margin-left:auto">agent 5 <b>58.4k</b> out · agent 3 41.9k · <span class="dim">Δ +16.5k</span></span>
</div>`;

/* -------------------------------------------- 1440px two-panel compare */
/**
 * §3.7's fourth canonical state at its first required viewport, and §2.5's "**Up to two
 * panels side-by-side** (`?a=<m>` adds a compare panel)" drawn literally.
 *
 * Entering the compare collapses BOTH rails to their 44/48px strips — 1440 − 92 = 1348,
 * so each panel is 674px, comfortably past the 607px the row types were designed at. That
 * is the composition's one real decision and it is annotated as such: a compare that kept
 * the 280px run rail would give each panel 534px and reflow every card being compared,
 * which defeats the comparison.
 */
const compare1440 = () => `<div class="app" style="height:1004px">
  ${topbar('run')}
  <div class="cockpit compare" style="height:960px">
    ${railStrip()}
    <div class="col cmp2">
      ${compareBar()}
      ${comparePin}
      <div class="cmp-panes" data-layout="side-by-side">
        ${transcriptPanel(5, { compare: true })}
        ${comparedPanel()}
      </div>
    </div>
    ${inboxStrip()}
  </div>
</div>`;

/* ---------------------------------------------- 800px two-panel compare */
/**
 * §3.7's fourth canonical state at its second required viewport — THE APPROVED
 * COMPOSITION, as ruled by the operator (Ben Vargas) on the §3.7 comp set.
 *
 * The set offered two drawings here and asked the operator to choose. They chose the
 * stacked pair, and amended DESIGN §2.5 to match: "side-by-side" stays normative at
 * ≥900px, and below §3.3's single 900px breakpoint the compare renders as a stacked pair
 * (full-width panels, sequential scroll). The side-by-side drawing is retained below as
 * ALTERNATIVE A, the one that was considered and not chosen.
 *
 * The arithmetic behind the ruling: §3.3 replaces the cockpit with the transcript below
 * 900px and both rails are 44px handles, so the compare column is 712px. Side by side that
 * is ~355px a pane — under the 607px the row types were designed at, so the SAME row wraps
 * differently on the two sides and the eye is comparing two renderings rather than two
 * answers. Stacked, both panes keep the full 712px and a row renders identically in both.
 * What it spends is scrollback depth (~370px of height per pane), which the shared pin bar
 * buys back by anchoring both panes to the same step.
 */
const compare800 = () => `<div class="app" style="height:870px">
  ${topbar('run')}
  <div class="cockpit narrow" style="height:826px">
    <div class="col strip drawer">
      <button class="icb" aria-label="Open run rail">${ic('chevron', '14')}</button>
      <span class="vlbl">41 runs</span>
    </div>
    <div class="col cmp2">
      ${compareBar({ swapKbd: false })}
      ${comparePin}
      <div class="cmp-panes stack" data-layout="stacked">
        ${transcriptPanel(2, { compare: true })}
        ${comparedPanel(3)}
      </div>
    </div>
    <div class="col strip drawer">
      <button class="icb" aria-label="Open inbox rail">${ic('mail', '14')}</button>
      <span class="dotn">1</span>
      <span class="vlbl">inbox</span>
    </div>
  </div>
</div>`;

/**
 * ALTERNATIVE A — the side-by-side pair at 800px. NOT the composition; retained as the
 * annotated record of what the operator ruled against.
 *
 * It is kept rather than deleted because the ruling is only legible beside the thing it
 * rejected: this is the drawing §2.5's unqualified "side-by-side" produced at 800px, with
 * its costs visible — the facts row wraps to two lines, the gutter narrows 56 → 40px, and
 * tool/terminal cards wrap where the 1440 frame does not. Every pane carries a 340px
 * minimum, so the pair would have scrolled horizontally rather than degrading into a
 * switcher; that mechanism is still what the ≥900px composition uses when a window is
 * dragged narrow, which is the other reason the frame stays.
 */
const compare800SideBySide = () => `<div class="app" style="height:870px">
  ${topbar('run')}
  <div class="cockpit narrow" style="height:826px">
    <div class="col strip drawer">
      <button class="icb" aria-label="Open run rail">${ic('chevron', '14')}</button>
      <span class="vlbl">41 runs</span>
    </div>
    <div class="col cmp2">
      ${compareBar({ swapKbd: false })}
      ${comparePin}
      <div class="cmp-panes" data-layout="side-by-side">
        ${transcriptPanel(4, { compare: true })}
        ${comparedPanel(5)}
      </div>
    </div>
    <div class="col strip drawer">
      <button class="icb" aria-label="Open inbox rail">${ic('mail', '14')}</button>
      <span class="dotn">1</span>
      <span class="vlbl">inbox</span>
    </div>
  </div>
</div>`;

/* ------------------------- transcript REPLACES the cockpit (§3.3, <900px) */
/**
 * §3.3: "below 900px the cockpit rails collapse into drawers and the transcript replaces
 * the cockpit". The 1440 frame shows the transcript as a right split beside the cockpit;
 * this is what the same route renders once the split cannot hold two columns.
 *
 * The one thing this composition has to get right is the way BACK. Replacing the cockpit
 * means the operator's context is gone from the screen, so the panel grows a back
 * affordance that names what it returns to — the run, not "back" — and the agent stepper
 * beside it, so moving between agents does not require a round trip through the cockpit.
 *
 * `w` is the pane width the frame is drawn at, which is the only difference between the
 * 800 and 480 versions: the same composition, the same rules, less room.
 */
const transcriptReplaces = (h, { rows = 4, kbd = true } = {}) => `<div class="app" style="height:${h}px">
  ${topbar('run')}
  <div class="cockpit narrow" style="height:${h - 44}px">
    <div class="col strip drawer">
      <button class="icb" aria-label="Open run rail">${ic('chevron', '14')}</button>
    </div>
    <div class="col">
      <div class="backbar">
        <button class="btn sm ghost">${ic('chevron', '12', 'flip')}judge-panel-auth-refactor</button>
        <span class="k">·</span>
        <span class="dim micro mono trunc">the cockpit is one tap away, and it is named</span>
        <div class="bb-right">
          <button class="icb" aria-label="Previous agent">${ic('chevron', '14', 'flip')}</button>
          <span class="dim micro mono">6 of 10</span>
          <button class="icb" aria-label="Next agent">${ic('chevron', '14')}</button>
          ${kbd ? '<span class="dim micro mono">j / k</span>' : ''}
        </div>
      </div>
      ${transcriptPanel(rows, { compare: true })}
    </div>
    <div class="col strip drawer">
      <button class="icb" aria-label="Open inbox rail">${ic('mail', '14')}</button>
      <span class="dotn">1</span>
    </div>
  </div>
</div>`;

/* ------------------------------------------------- compressed cockpit side */
const cockpitSide = () => `<div class="col">
  <div class="sect">
    <span class="lbl">${RUN.name}</span>
    ${chip('running', 'running', { spin: true })}
    <div class="sect-right"><span class="dim micro mono">4/10 · 375.1k out · $9.05</span></div>
  </div>
  <div class="tl scroller" style="padding:12px 14px">
    <div class="tl-head" style="margin-bottom:6px">
      <span class="lbl">timeline</span>
      <span class="tl-note">the cockpit keeps its place — the split is 55 / 45 and drag-persisted</span>
    </div>
${AGENTS.map((a) => {
    const span = 560;
    const x = (ms) => (ms / 842000) * span;
    const wStart = a.wait ?? a.start ?? 0;
    const waitW = a.wait != null ? x(a.start ?? 842000) - x(a.wait) : 0;
    const execW = a.state === 'queued' ? 0 : Math.max(x(a.end ?? 842000) - x(a.start), 4);
    return `    <div class="lane" style="grid-template-columns:132px 1fr;height:28px${a.i === 5 ? ';background:var(--surface-selected)' : ''}">
      <div class="lane-label"><span class="idx">${a.i}</span>${glyph(a.state, { spin: a.state === 'running' })}${adapter(a.adapter)}<span class="nm trunc">${a.label}</span></div>
      <div class="lane-track">
        ${a.state === 'cached'
      ? `<div class="bar nowait" style="left:0;width:8px"><div class="exec c" style="flex:1"></div></div>`
      : `<div class="bar ${a.wait == null ? 'nowait' : ''} ${a.state === 'queued' ? 'open' : ''}" style="left:${x(wStart)}px;width:${waitW + execW}px">
          ${a.wait != null ? `<div class="wait" style="width:${waitW}px"></div>` : ''}
          ${a.state === 'queued' ? '' : `<div class="exec ${a.state === 'done' ? 'd' : a.state === 'running' ? 'r' : a.state === 'failed' ? 'f' : 'x'}" style="width:${execW}px"></div>`}
        </div>`}
      </div>
    </div>`;
  }).join('\n')}
  </div>
  <div class="sect" style="border-top:1px solid var(--hairline);border-bottom:0">
    <span class="lbl">compare</span>
    <div class="achip" style="flex:1;margin:0 8px">
      ${glyph('done')}${adapter(A3.adapter)}<span class="nm trunc">${A3.label}</span>
      <span class="m">${A3.dur} · ${A3.cost} · agent 3</span>
    </div>
    <button class="btn sm">${ic('columns', '12')}Open as 2nd panel <span class="mono dim">?a=3</span></button>
  </div>
</div>`;

/* ---------------------------------------------------------- queued variant */
const queuedFooter = `<div class="card" style="padding:0">
  <div class="tp-head" style="border-bottom:1px solid var(--hairline)">
    <div class="r1">
      ${glyph('queued')}<h2>verify:auth</h2><span class="aidx">agent 8</span>${chip('queued')}
      <div class="right"><span class="badge">queue position 1 of 2</span></div>
    </div>
    <div class="tp-facts">
      <span>${adapter('opencode')} opencode <span class="k">·</span> qwen3-coder</span>
      <span><span class="k">queued for</span> 8m40s</span>
      <span><span class="k">usage</span> <span style="color:var(--hairline-strong)">not started</span></span>
    </div>
  </div>
  <div class="tp-foot" style="border-top:0">
    <form class="composer" onsubmit="return false">
      <label class="vh" for="steer2">Steer this agent</label>
      <input class="inp" id="steer2" disabled value="agent hasn't started yet — steering opens when it runs">
      <button class="btn" type="submit" aria-disabled="true">${ic('send', '12')}Send</button>
      <button class="btn" aria-disabled="true">${ic('cancel', '12')}Cancel agent</button>
      <span class="hint"><span>the engine's <span class="mono">findJob</span> resolves only jobs
        inside <span class="mono">sem.with</span> — a queued agent is not steerable (critique M11)</span>
        <span style="margin-left:auto">position 1 of 2 from the E4 <span class="mono">sem</span> gauge</span></span>
    </form>
  </div>
</div>`;

const failedFooter = `<div class="card" style="padding:14px">
  <div class="errcard">
    <div class="eh">${ic('failed', '14')}<span class="t">agent 4 · review:routes failed</span>
      <span class="badge err">spawn_failed</span>
      <span class="badge">not retryable</span>
      <span style="margin-left:auto"><button class="btn sm">${ic('external', '12')}flowition doctor</button></span></div>
    <div class="em">codex: command not found</div>
    <p class="meta" style="margin-top:8px">The failure taxonomy turns an error code into an
      instruction (Q10): <span class="mono">spawn_failed</span> → "CLI not installed — run
      <span class="mono">flowition doctor</span>", <span class="mono">stalled</span> → the stall
      context, <span class="mono">schema_invalid</span> → the corrective-turn story. The card is
      pinned below the last transcript row, in addition to the header state (parity #96).</p>
  </div>
</div>`;

export function pageTranscript() {
  const shell = `<div class="app" style="height:1004px">
  ${topbar('run')}
  <div class="cockpit split" style="height:960px">
    ${railStrip()}
    ${cockpitSide()}
    ${transcriptPanel(6)}
    ${inboxStrip()}
  </div>
</div>`;

  // The split above clips, as a real transcript does. This frame unrolls every row type
  // at the panel's true 607px width so nothing the brief asks for is cut off.
  const unrolled = `<div style="display:grid;grid-template-columns:607px 1fr;gap:24px;padding:24px;align-items:start">
  <div style="border:1px solid var(--hairline);border-radius:3px;overflow:hidden">
    <div class="app" style="height:auto">${transcriptPanel(ROWS.length, { clip: false })}</div>
  </div>
  <div>
    <div class="lbl" style="margin-bottom:10px">row-type index — every kind §2.5 names, in journal order
      <span style="text-transform:none;letter-spacing:0;font-weight:400"> · the left column is the annotation number at the bottom of this page</span></div>
    <div class="swatches" style="margin-top:0">
${[
  ['prompt block', 'full text (E10), collapsed to 15 lines, copy + expand', '1'],
  ['attempt marker', 'E9 splits transcript segments; the selector steps through them', '2'],
  ['reasoning', 'collapsible with a one-line preview', '3'],
  ['step group', 'collapsed label from workSummary; boundaries close steps', '4'],
  ['tool + tool-result', 'paired by toolUseId → id (E11); the id chip is shown', '5'],
  ['terminal card', 'fixed dark well, 2-line command clamp, real exit code only', '6'],
  ['file-change card', '4 actions, computed +N −M, explicit "no diff available"', '7'],
  ['tool error', 'error-tinted result, never rendered as success', '8'],
  ['mail-in marker', 'origin + delivery verdict, appended to the timeline', '9'],
  ['status', 'muted system line', ''],
  ['long tool header', 'clamps past 3 lines with a fade and "Show more" (#78)', ''],
  ['raw', 'collapsed "n unparsed provider lines"; unknown kinds → neutral JSON', ''],
  ['assistant markdown', 'safe-by-construction subset; images become link chips', ''],
].map(([k, v, n]) => `      <div class="sw" style="grid-template-columns:20px 150px 1fr">
        <span class="mono dim micro">${n || '·'}</span><span class="tk">${k}</span><span class="val">${v}</span>
      </div>`).join('\n')}
    </div>
    <div class="rawgrp" style="margin-top:16px">${ic('unknown', '12')}
      Every row shows a relative time on hover and an absolute time in the gutter at minute
      boundaries. Manual expand/collapse is recorded per row id
      and always wins over the §9.6 automatic rule until the row leaves the 8 MiB window (#93).</div>
  </div>
</div>`;

  const body = `
${frame('Transcript panel — live agent, split beside the cockpit', '1440 × 1004 · §2.5, §2.5.1, §3.7', `
  ${shell}
  ${mk(1, 'top:200px;left:800px')}
  ${mk(2, 'top:424px;left:800px')}
  ${mk(3, 'top:470px;left:800px')}
  ${mk(4, 'top:528px;left:800px')}
  ${mk(5, 'top:592px;left:800px')}
  ${mk(6, 'top:800px;left:800px')}
  ${mk(8, 'top:906px;left:800px')}
  ${mk(9, 'top:60px;left:56px')}
  ${mk(10, 'top:950px;left:60px')}
`)}

${frame('Two-panel compare at 1440px (§3.7\'s fourth canonical state)', '1440 × 1004 · §2.5 · §3.7', `
  ${compare1440()}
  ${mk(14, "top:52px;left:600px")}
  ${mk(15, 'top:84px;left:700px')}
  ${mk(16, "top:152px;left:1352px")}
`)}

${frame('Two-panel compare at 800px (§3.7\'s second required viewport)', '800 × 870 · §3.3 · §2.5 amended', `
  ${compare800()}
  ${mk(11, "top:52px;left:520px")}
  ${mk(12, 'top:88px;left:48px')}
  ${mk(13, 'top:200px;left:6px')}
  ${mk(17, 'top:470px;left:6px')}
`, 'w800')}

${frame('Two-panel compare at 800px — ALTERNATIVE A: the side-by-side pair (considered, not chosen)',
    '800 × 870 · §2.5 · alternative', `
  ${compare800SideBySide()}
  ${mk(18, "top:120px;left:700px")}
  ${mk(19, "top:300px;left:380px")}
`, 'w800')}

${frame('Transcript replaces the cockpit at 800px (§3.3, below 900px)', '800 × 700 · §3.3 · §2.5', `
  ${transcriptReplaces(700)}
  ${mk(20, 'top:56px;left:14px')}
  ${mk(21, 'top:82px;left:642px')}
`, 'w800')}

${frame('Transcript replaces the cockpit at 480px', '480 × 700 · §3.3 · §2.5', `
  ${transcriptReplaces(700, { rows: 3, kbd: false })}
  ${mk(22, 'top:56px;left:14px')}
`, 'w800 w480')}

${frame('Transcript panel — every row type, unrolled at the panel\'s true 607px width', '607px column · §2.5.1', unrolled)}

<div class="frame-wrap">
  <div class="frame-head"><h2>Transcript — the two footers that are not "running", and the failure card</h2>
    <span class="w">§2.5 · critique M11 · parity #96</span></div>
  <div class="frame" style="padding:24px;display:grid;gap:20px">
    <div>
      <div class="lbl" style="margin-bottom:8px">queued agent — composer disabled, with the reason and the queue position</div>
      ${queuedFooter}
    </div>
    <div>
      <div class="lbl" style="margin-bottom:8px">failed agent — error card pinned below the last row</div>
      ${failedFooter}
    </div>
    <div>
      <div class="lbl" style="margin-bottom:8px">dead run — the working indicator is never shown (parity #58), and old-run notes are explicit</div>
      <div class="card" style="padding:14px;display:grid;gap:10px">
        <div class="rawgrp">${ic('unknown', '12')} <b>Recorded by an older engine.</b>
          Tool calls in this transcript are paired by <b>position</b>, not by id — the pairing is
          labelled <i>approximate</i> per card, and an orphan result surfaces as its own completed
          row rather than clobbering an unrelated call (parity #83).</div>
        <div class="rawgrp">${ic('unknown', '12')} Attempt boundaries are split on the sentinel
          string <span class="mono">— resumed run: new attempt below —</span> and the selector is
          labelled <i>approximate</i>.</div>
        <div class="rawgrp">${ic('unknown', '12')} The prompt block carries "may be truncated at
          4,000 chars" for runs recorded before E10.</div>
        <div class="sysline">no working indicator — this run is not live</div>
      </div>
    </div>
  </div>
</div>`;

  return page({
    title: 'Transcript',
    file: 'transcript.html',
    sections: '§2.5, §2.5.1, §3.3, §3.7',
    viewports: '1440 + 800',
    note: 'rails collapsed · split 55 / 45',
    body,
    notes: [
      `<b>Header answers "which agent, how far, how much" in one 11px mono strip.</b> Facts are
       separated by hairlines rather than bullets so the row reads as an instrument readout.
       Lifetime usage (summed over every <code>result</code> record for this key — the same
       aggregation <code>Journal.load</code> uses to seed the budget) sits beside the attempt
       selector's per-attempt figures, and both are <i>labelled</i>. §2.5's Sol-13 vocabulary is
       enforced by that labelling: run invocation, execution attempt, provider turn.`,

      `<b>The prompt comes first, in full.</b> E10 records the whole prompt; the block collapses
       to 15 lines with expand and copy. This is the single most common "what did you actually ask
       it" question, and most viewers make it unanswerable. The footer note says nothing was
       truncated — a claim the UI can only make because the cap marker is absent.`,

      `<b>Reasoning collapses to a one-line preview, not to a bare "reasoning" pill</b>.
       The preview is the first sentence, so the block is skippable
       without being opaque. Left border rather than a full tint: reasoning is content, not state.`,

      `<b>Tool calls are paired to results by id (E11), and the id is shown.</b> The
       <code>id toolu_…</code> chip is dotted, not solid, because it is provenance rather than
       data. On old runs the pairing falls back to a position stack and the chip reads
       <i>approximate</i>. <b>Rule on this:</b> is the id chip worth its pixels on every card, or
       should it appear only when the pairing is approximate?`,

      `<b>Terminal cards sit on the fixed dark well in both themes</b> — toggle the theme and the
       well does not move (§3.2, decision final). The command clamps to two lines; a
       <code>mouseup</code> that follows a text selection does not toggle it (#73). "exit code 1"
       renders <i>only</i> because the adapter reported one; when no code exists the line is
       omitted entirely rather than fabricated from <code>isError ? 1 : 0</code>.
       Cards break out past the 88ch prose column to panel width.`,

      `<b>File-change cards carry a computed <code>+N −M</code> tally and a five-square bar</b>
       (#79–#82): four actions with past-tense verbs, addition/deletion/hunk line classes, and an
       explicit "no diff available" card when the tool wrote a file but returned nothing to
       synthesize a diff from. An empty card would have read as "no changes".`,

      `<b>The answer is safe-by-construction markdown</b> (§9.7): headings, lists, blockquote,
       inline code, fenced code with a language chip and copy. Raw HTML renders as literal text
       and images render as link chips — never fetched. Prose is 14px/1.45 capped at 88ch because
       a reviewer's finding is read, not scanned.`,

      `<b>The steer composer is the region's one accent action, and it is enabled only because
       the folded state is exactly <code>running</code></b> (critique M11). The working indicator
       reads "Thinking…" after reasoning and "Working…" otherwise (parity #95), and is never shown
       inside a dead run (#58). Delivery verdicts toast inline <i>and</i> append to the timeline,
       which is why the operator steer at 14:15 is a permanent row.`,

      `<b>Both rails are collapsed to icon strips here</b> — 48px and 44px — because the
       transcript is what you came for. The inbox strip keeps its unread count so a question
       arriving mid-read is not silent. <b>Rule on this:</b> at 1440 the 55/45 split leaves the
       transcript 607px ≈ 73ch, under §3.3's 88ch maximum. Accept, or make the transcript the
       55 side when it is open?`,

      `<b>The compare affordance is explicit rather than hidden in a menu.</b> Judge-panel and
       adversarial-verify workflows are the entire point of flowition, so <code>?a=3</code> opens
       a second panel side by side — comparison must not require two windows. THIS frame is the state
       <i>before</i> the comparison — one transcript beside the cockpit, with the candidate agent
       docked. The comparison itself is the next two frames, at both required viewports.`,

      `<b>800px compare: the two panels are STACKED — the operator's ruling, and DESIGN §2.5 is
       amended to match.</b> §2.5 now reads: side-by-side is normative at ≥900px, and below
       §3.3's single 900px breakpoint the compare renders as a stacked pair, full-width panels,
       sequential scroll. The arithmetic that decided it: both rails are 44px handles, so the
       compare column is 712px — side by side that is ~355px a pane, under the 607px the row
       types were designed at, so the SAME row wraps differently on the two sides and the eye
       compares two renderings instead of two answers. Stacked, both panes keep the full 712px
       and a row renders identically in both. The cost is scrollback: ~370px of height per pane,
       two to three rows each, and the two agents are never simultaneously at eye level — which
       is what annotation 12's shared pin bar is for. The side-by-side drawing is kept as
       ALTERNATIVE A in the next frame, so the ruling can be read beside what it rejected.`,

      `<b>800px compare: the shared pin bar is what makes a narrow compare legible.</b> The
       comparison an operator is making is "what did B do at the step where A did X". Both panes
       are anchored to the same step, so two ~355px columns show the same moment rather than each
       pane's own last scroll position — which is what stops a narrow side-by-side from becoming
       two unrelated feeds. The output-token delta sits on the same bar because it is the other
       thing a judge-panel reader wants at a glance, and it is the one number that is only
       meaningful as a pair. Stacked, it does more work than it would side by side: the panes
       are never at eye level together, so the pin is the only thing that guarantees the two
       are showing the same moment. It is drawn identically in ALTERNATIVE A.`,

      `<b>800px compare: the rails stay as 44px handles, not a top-bar menu.</b> Same rule as the
       cockpit at 800 (cockpit.html annotation 14) — the two idioms must match, or the run rail
       means one thing on one screen and another thing on the next.`,

      `<b>1440 compare: entering the comparison collapses BOTH rails to strips.</b> 1440 − 48 − 44
       = 1348, so each panel is 674px — past the 607px the row types were designed at, which is
       the whole point. Keeping the 280px run rail would give each panel 534px and reflow every
       card being compared. <b>Rule on this:</b> auto-collapsing the rails on entering compare,
       versus leaving them and letting the panels go under 607.`,

      `<b>The pair is the unit, so the pair has a header.</b> One bar names both agents, owns Swap
       (<kbd>\\</kbd>) and owns the single Close that ends the comparison; each panel keeps only
       what is about ITSELF — its own search, its own pin toggle, its own close. Two full panel
       headers with two "end comparison" buttons would leave the operator guessing which one ends
       what.`,

      `<b>The second panel is a full panel, not a stub.</b> Same header, same facts row, same row
       types — and, at the bottom of the same column, the footer a NON-running agent gets: the
       composer is disabled with the reason stated, and there is no working indicator, because
       agent 3 is done (parity #58, critique M11). A comparison in which one side is a summary
       column is not a comparison. <b>Rule on this:</b> a disabled composer on the finished side,
       versus no footer at all there.`,

      `<b>800px compare: the pane seam is heavier than any rule inside a pane.</b> Stacked, the
       failure mode is sharper than it is side by side — agent 3's first row sits directly under
       agent 2's last one, in the same column, at the same width, so without a boundary the two
       transcripts read as one continuous feed. The seam is therefore the heaviest rule on the
       screen (2px, hairline-strong) and each pane keeps its own header directly above its own
       rows, restating whose output follows. The same answer is drawn in ALTERNATIVE A, where
       the seam is vertical.`,

      `<b>ALTERNATIVE A — the side-by-side pair. CONSIDERED AND NOT CHOSEN.</b> This is what
       §2.5's unqualified "side-by-side" produced at 800px, kept so the operator's ruling can be
       read beside the thing it rejected. Its argument was proximity: both agents at eye level,
       no scrolling between them. What it costs is on the frame — each pane is ~355px, so the
       facts row wraps, the gutter narrows 56 → 40px, and tool cards and terminal wells wrap
       where the 1440 frame does not. Nothing is dropped (a pane missing rows is not comparable
       to the pane beside it), but the same row renders differently on the two sides, and that
       is the comparison the feature exists for. The operator ruled for the stacked pair and
       amended §2.5 to scope "side-by-side" to ≥900px.`,

      `<b>ALTERNATIVE A: the 340px pane minimum, which outlives the alternative.</b> Each pane
       carries a 340px floor; below two of those the PAIR scrolls horizontally rather than one
       pane vanishing, so the layout degrades into scrolling and never into a switcher. That
       mechanism is not retired with this frame — it is what the ≥900px composition (the 1440
       frame above) does when a window is dragged toward the breakpoint, which is the second
       reason this drawing stays in the file rather than being deleted.`,

      `<b>Below 900px the transcript REPLACES the cockpit, and the way back is part of the
       composition.</b> §3.3 is the rule; the design decision is that the back affordance names
       the run it returns to (<i>judge-panel-auth-refactor</i>) rather than saying "back".
       Replacing the cockpit takes the operator's context off the screen, so an unlabelled arrow
       asks them to remember where they were. There is exactly one breakpoint, 900px — the same
       one the cockpit's drawers use — and the 480 frame below runs identical rules with less
       room, not different rules.`,

      `<b>The agent stepper lives beside the back affordance, not inside the cockpit.</b>
       "6 of 10" with prev/next, and <kbd>j</kbd>/<kbd>k</kbd> bound to the same movement (§2.7),
       so stepping through a judge panel at 800px is not ten round trips through a screen that
       had to be replaced to get here. The stepper drops its keyboard hint at 480 and keeps the
       buttons. <b>Rule on this:</b> the stepper on this bar, versus reaching agents only through
       the run rail drawer.`,

      `<b>480px transcript: nothing is removed, the panel just gets narrower.</b> Header facts
       wrap, the gutter narrows, cards wrap — and every row type still renders, because a
       transcript that drops row types at a viewport is a transcript that lies about what the
       agent did. This is the floor of §3.3's rule, drawn so W10 has a smallest case to build
       against rather than an implied one.`,
    ],
  });
}
