import { page, frame, mk, topbar, ic, chip, glyph, cluster } from './shell.mjs';
import { RUNS } from './fixtures.mjs';

const BADGE = {
  log: `<span class="badge">${ic('external', '12')}detached log</span>`,
  budget: `<span class="badge">${ic('bolt', '12')}budget</span>`,
  ask: `<span class="badge ask">${ic('blocked', '12')}1 question</span>`,
  resumed: `<span class="badge">resumed ×1</span>`,
  resumed1: `<span class="badge">resumed ×1</span>`,
  resumed2: `<span class="badge">resumed ×2</span>`,
  cached: `<span class="badge replay">${ic('cached', '12')}6 cached</span>`,
  old: `<span class="badge">${ic('unknown', '12')}older engine</span>`,
  'err:spawn_failed': `<span class="badge err">spawn_failed</span>`,
};

function progressBar(a) {
  const w = (n) => `${((n || 0) / a.total) * 100}%`;
  return `<span class="progress-mini">
    <span class="bar" aria-hidden="true"><i class="d" style="width:${w(a.done + (a.cached || 0))}"></i></span>
    <span>${a.done}/${a.total}${a.cached ? `<span class="dim"> +${a.cached}c</span>` : ''}</span>
  </span>`;
}

function runRow(r) {
  const spin = r.state === 'running';
  return `      <div class="rt-row${r.sel ? ' sel' : ''}" role="row" tabindex="-1">
        ${glyph(r.state, { spin })}
        <span class="rt-name">
          <span class="nm trunc">${r.name ?? `<span class="mono dim">${r.id}</span>`}</span>
          ${r.name ? `<span class="rid">${r.id}</span>` : ''}
          <span class="rt-badges">${r.badges.map((b) => BADGE[b] ?? '').join('')}</span>
        </span>
        <span class="col-ad">${cluster(r.adapters, r.more || 0)}</span>
        <span>${progressBar(r.agents)}</span>
        <span class="n col-out">${r.out}</span>
        <span class="n">${r.cost ?? '<span class="absent" title="no cost in the journal for this run">&nbsp;</span>'}</span>
        <span class="n">${r.dur}</span>
        <span class="when">${r.when}</span>
      </div>`;
}

const attention = `<div class="attn">
  <div class="attn-head">
    <span class="lbl">Needs you</span>
    <span class="count">3</span>
    <span class="dim micro" style="margin-left:4px">runs blocked on an answer, runs whose engine died, and what is burning money right now</span>
  </div>
  <div class="attn-grid">

    <div class="acard ask">
      <div class="acard-top">
        ${glyph('blocked')}
        <span class="nm">migrate-callsites</span>
        <span class="rid">r_a03d51e7</span>
        <span class="right">${chip('blocked', 'blocked 2m')}</span>
      </div>
      <div class="qtext">
        <span class="who">agent 3 · rewrite:cli asked 2m ago · qid q_9d41</span>
        Two call sites in <span class="mono">src/cli.js</span> pass a bare string where the new
        adapter API expects <span class="mono">{path}</span>. Rewrite both, or keep a
        compatibility shim for one release?
      </div>
      <form class="answer" onsubmit="return false">
        <label class="vh" for="ans">Answer the question</label>
        <input class="inp" id="ans" value="rewrite both — no shim" >
        <button class="btn primary lg" type="submit">${ic('send', '12')}Send</button>
        <span class="hint">⌘↵ sends · answer here or press <b>a</b> · 2 clicks from Home to answered</span>
      </form>
    </div>

    <div class="acard stale">
      <div class="acard-top">
        ${glyph('stale')}
        <span class="nm">audit-viewer-security</span>
        <span class="right">${chip('stale')}</span>
      </div>
      <div class="why">
        Engine died. It wrote no terminal event, so there is no time of death to report — the
        run started 1h10m ago. <code>run.lock</code> held by pid 48812 — not running.
        5 of 9 agents finished; 4 render <b>orphaned</b>, not spinning.
      </div>
      <div class="acard-actions">
        <button class="btn">${ic('resume', '12')}Resume</button>
        <button class="btn ghost">${ic('external', '12')}run.log</button>
        <span class="dim micro" style="margin-left:auto">$4.10</span>
      </div>
    </div>

    <div class="acard live">
      <div class="acard-top">
        ${glyph('running', { spin: true })}
        <span class="nm">judge-panel-auth-refactor</span>
        <span class="right"><span class="badge warn">${ic('bolt', '12')}over budget</span></span>
      </div>
      <dl class="ticker">
        <dt>spend</dt><dd><b>$9.05</b> <span class="dim">· 375.1k out</span></dd>
        <dt>budget</dt><dd><span style="color:var(--st-failed)">110.3%</span> <span class="dim">of the 340k soft ceiling</span></dd>
        <dt>agents</dt><dd>4/10 <span class="dim">· 2 running · 1 failed</span></dd>
      </dl>
      <div class="gauge">
        <div class="gauge-bar">
          <div class="fill" style="width:90.6%"></div>
          <div class="over" style="left:90.6%;right:0"></div>
          <div class="ceiling" style="left:90.6%"></div>
        </div>
      </div>
    </div>

  </div>
</div>`;

const table = `<div class="rt">
  <div class="rt-tools">
    <span class="lbl">Filter</span>
    <button class="fchip" aria-pressed="false">${ic('running', '12')}running <span class="n">2</span></button>
    <button class="fchip" aria-pressed="true">${ic('blocked', '12')}blocked <span class="n">1</span></button>
    <button class="fchip" aria-pressed="false">${ic('failed', '12')}failed <span class="n">1</span></button>
    <button class="fchip" aria-pressed="false">${ic('done', '12')}completed <span class="n">3</span></button>
    <button class="fchip" aria-pressed="false">${ic('stale', '12')}stale <span class="n">1</span></button>
    <div class="search">
      ${ic('search', '14')}
      <label class="vh" for="q">Filter by name or run id</label>
      <input class="inp" id="q" placeholder="name or run id   /">
    </div>
    <button class="btn ghost" aria-label="Choose columns">${ic('columns', '12')}</button>
  </div>
  <div role="table" aria-label="Runs">
    <div class="rt-row head" role="row">
      <span></span>
      <span class="lbl">run</span>
      <span class="lbl col-ad">adapters</span>
      <span class="lbl">agents</span>
      <span class="lbl col-out" style="text-align:right">out</span>
      <span class="lbl" style="text-align:right">cost</span>
      <span class="lbl" style="text-align:right">duration</span>
      <span class="lbl" style="text-align:right">started ↓</span>
    </div>
${RUNS.map(runRow).join('\n')}
  </div>
  <div class="rt-more"><button class="btn">Load more <span class="dim">· 41 runs total</span></button></div>
</div>`;

const main = `<div class="app" style="height:880px">
  ${topbar('home')}
  <div class="home">
    <div class="home-head">
      <h1>Runs</h1>
      <span class="sub">41 runs · 2 live · <span class="mono">~/projects/flowition</span></span>
      <div style="margin-left:auto;display:flex;gap:6px">
        <button class="btn">${ic('filter', '12')}Stale only</button>
        <button class="btn">${ic('trash', '12')}Trash <span class="dim">3</span></button>
      </div>
    </div>
    ${attention}
    <div class="attn-head"><span class="lbl">All runs</span><span class="count">41</span></div>
    ${table}
  </div>
</div>`;

/**
 * §3.7's second required viewport. Same world, same tokens, same components — the layout
 * decisions are what is being ruled on:
 *   • the run rail is a 44px icon strip (§3.3 / parity #42 — below 900px it is a drawer,
 *     and Home is where it rests closed);
 *   • the attention grid stacks (already the rule below 1100px), so the answer composer
 *     gets the full width at the top of the queue rather than a 260px slot;
 *   • the table drops the adapter cluster and the output-token column, which buys the
 *     NAME column ~190px — the column the operator actually scans. Both live on the
 *     cockpit; nothing here is visible only at 1440.
 */
const narrow = `<div class="app" style="height:1000px">
  ${topbar('home')}
  <div style="display:flex;flex:1;min-height:0">
    <div class="strip" style="width:44px;flex:none;border-right:1px solid var(--hairline)">
      <button class="icb" aria-label="Expand run rail">${ic('chevron', '14')}</button>
      <span class="dotn">41</span>
      <span class="vlbl">runs</span>
    </div>
    <div style="flex:1;min-width:0;overflow:hidden">
      <div class="home">
        <div class="home-head">
          <h1>Runs</h1>
          <span class="sub">41 runs · 2 live</span>
        </div>
        ${attention}
        <div class="attn-head"><span class="lbl">All runs</span><span class="count">41</span></div>
        ${table}
      </div>
    </div>
  </div>
</div>`;

const states = `<div class="frame-wrap">
  <div class="frame-head"><h2>Home — the three states that are not the happy path</h2>
    <span class="w">§2.3 · parity #40 · zero-runs teaching card</span></div>
  <div class="frame" style="padding:24px;display:grid;gap:20px">
    <div>
      <div class="lbl" style="margin-bottom:8px">loading — skeleton rows, no spinner, no layout shift</div>
      <div class="rt">
        <div class="rt-row head" role="row"><span></span><span class="lbl">run</span><span class="lbl">adapters</span>
          <span class="lbl">agents</span><span class="lbl" style="text-align:right">out</span>
          <span class="lbl" style="text-align:right">cost</span><span class="lbl" style="text-align:right">duration</span>
          <span class="lbl" style="text-align:right">started</span></div>
${[62, 44, 54].map((w) => `        <div class="rt-row"><span class="skel" style="width:12px;height:12px;border-radius:999px"></span>
          <span class="rt-name"><span class="skel" style="width:${w}%"></span></span>
          <span class="skel" style="width:52px"></span><span class="skel" style="width:44px"></span>
          <span class="skel" style="width:40px;margin-left:auto"></span><span class="skel" style="width:36px;margin-left:auto"></span>
          <span class="skel" style="width:38px;margin-left:auto"></span><span class="skel" style="width:56px;margin-left:auto"></span></div>`).join('\n')}
      </div>
    </div>
    <div>
      <div class="lbl" style="margin-bottom:8px">API unreachable — parity #40. Names the command, does not blame the network.</div>
      <div class="banner">
        ${ic('failed', '14')}
        <span><b>API unreachable.</b> Is <code>flowition viewer</code> still running? The viewer
        shuts down after 30 minutes idle.</span>
        <button class="btn sm" style="margin-left:auto">${ic('resume', '12')}Retry</button>
      </div>
    </div>
    <div>
      <div class="lbl" style="margin-bottom:8px">zero runs — the quick-start snippet, not a shrug</div>
      <div class="card" style="padding:0">
        <div class="empty">
          ${ic('gantt', '20', 'dim')}
          <h3>No runs yet</h3>
          <p>flowition records every run under <span class="mono">.flowition/runs/</span>. Start
          one and this page fills in — the viewer is already watching.</p>
          <div class="snippet"><span class="p">$</span><span>flowition run hello.workflow.js</span>
            <button class="icb" aria-label="Copy command">${ic('copy', '12')}</button></div>
        </div>
      </div>
    </div>
  </div>
</div>`;

export function pageHome() {
  const body = `${frame('Home — attention-heavy', '1440 × 880 · §2.3', `
    ${main}
    ${mk(1, 'top:114px;left:22px')}
    ${mk(2, 'top:186px;left:352px')}
    ${mk(3, 'top:114px;left:996px')}
    ${mk(4, 'top:352px;left:22px')}
    ${mk(5, 'top:474px;left:686px')}
    ${mk(6, 'top:518px;left:918px')}
    ${mk(7, 'top:672px;left:246px')}
    ${mk(11, 'top:186px;left:686px')}
  `)}
  ${frame('Home — 800px (§3.7\'s second required viewport)', '800 × 1000 · §3.3 · parity #42', `
    ${narrow}
    ${mk(8, 'top:60px;left:8px')}
    ${mk(9, 'top:150px;left:60px')}
    ${mk(10, 'top:690px;left:400px')}
    ${mk(11, 'top:330px;left:8px')}
  `, 'w800')}
  ${frame('Home — 480px (the floor of §3.3\'s single 900px breakpoint)', '480 × 1000 · §3.3 · §2.3', `
    ${narrow}
    ${mk(12, 'top:420px;left:8px')}
  `, 'w800 w480')}
  ${states}`;

  return page({
    title: 'Home',
    file: 'home.html',
    sections: '§2.3, §3.2, §3.7',
    viewports: '1440 + 800',
    note: 'attention strip + run table',
    body,
    notes: [
      `<b>The attention strip is the product thesis, not a banner.</b> §2.3 / Q1: three card
       kinds — blocked on an answer, engine died, burning money — each with the one action that
       resolves it. It renders only when non-empty, so a calm queue means a calm screen. Rule on
       the three-column split: I gave the answer card 1.35fr because typing happens there.`,

      `<b>Inline answering, and the only accent fill on the screen.</b> §3.7's action hierarchy
       gives each region exactly one primary action; Home's is <i>Send</i>. Resume, Trash, Load
       more and every filter are quiet outlines. That is why the eye lands on the answer box
       first — the color budget was spent deliberately.`,

      `<b>Live spend is a gauge, not a number.</b> The ticker plots <code>spend.output</code>
       against <code>budgetTotal</code> — both output tokens (§2.4, critique M19). Input tokens
       and dollars never enter the bar. This run is at 110.3%, so the hatched overshoot zone is
       showing on Home too, and the badge reads "over budget" rather than "blocked" — the
       budget is pre-admission advisory and the UI must never imply a hard cap.`,

      `<b>Filters are chips with counts; sort is fixed to newest-first (§2.3).</b> Pressed state
       is <code>--surface-selected</code> plus an accent-38% edge — no fill, because a filter is
       not an action. <code>/</code> focuses the search field.`,

      `<b>Empty ≠ zero.</b> Row 7 (<code>hello.workflow.js</code>) has no cost in its journal, so
       the cost cell is <b>blank</b>. Parity #53/#114: never fabricate <code>$0.00</code> or a
       placeholder dash for a number the engine never wrote. Row 8 has no name and shows its
       run id in mono instead.`,

      `<b>Old runs are labelled, not hidden.</b> Row 8 carries an "older engine" badge; its
       cockpit will show the §6.5 degradation notes rather than blank panels. Caps come from the
       run event's engine version (E3), never from field-presence sniffing (critique M2).`,

      `<b>Density target: 44px rows, eight aligned columns, tnum everywhere.</b> Numbers are
       right-aligned mono so magnitudes compare down the column at a glance; the status glyph is
       16px in an 18px well so the leftmost column reads as a single scannable strip. The done
       check is <i>kept</i> here (it is not a quiet list) but is the least saturated of the
       state colors on purpose.`,

      `<b>800px: the rail is a 44px icon strip, not a hidden feature.</b> §3.3 / parity #42 —
       below 900px the rail becomes an overlay drawer, and Home is where it rests closed. The
       strip keeps the run count visible, so "how many runs are there" never requires opening
       anything. Tapping it opens the drawer over the page; Escape or a selection closes it and
       returns focus to this button (§3.6).`,

      `<b>800px: the queue stacks, and the answer composer gets the full width.</b> The attention
       grid is one column below 1100px, so the card order becomes the priority order — blocked
       first, then stale, then spend. This is the one place the narrow layout is <i>better</i>:
       the composer is 720px wide instead of 380px.`,

      `<b>800px: two columns are dropped, and they are the right two.</b> The adapter cluster and
       the output-token count come out; status, name+badges, agents, cost, duration and started
       stay. That returns ~190px to the name column, which is what is actually scanned. Both
       dropped values are on the run's own cockpit, so nothing is reachable only at 1440.`,

      `<b>The stale card does not date the death, and that is the composition.</b> An earlier
       revision of this comp read "Engine died 26m ago" at both viewports. Nothing on disk
       supports it: <code>endedAt</code> is written from a terminal <code>run</code> event and
       from nothing else (§6.2, <code>src/viewer/summaries.js</code>), and a run is <i>stale</i>
       precisely because the engine went away without writing one. Substituting
       <code>startedAt</code> — or the <code>run.lock</code> mtime, which dates when the engine
       ACQUIRED the run — turns the run's AGE into a claim about when it stopped, and makes the
       runtime figure climb for as long as the tab is open. The card now states what it knows
       (the run started then; the server's own lock verdict) and the elapsed figure is gone with
       it. The BUILT Home in <code>built/home-built-*.png</code> already renders it this way, so
       this is also what makes the §3.7 side-by-side compare rather than diverge. A
       <code>lastSeenAt</code> on RunSummary is the only thing that would let this card carry a
       death time, and that is a W6 change.`,

      `<b>480px: the run table stops being a table.</b> There is still exactly one breakpoint —
       §3.3's 900px — and the 480 frame runs the same rules; what changes is that fixed columns
       stop fitting. Each row wraps into a two-line record: identity on line one (status glyph,
       name, badges), the numbers on line two as a dot-separated meta strip. <b>The column header
       row is dropped</b>, because every remaining value is self-describing (<code>4/10</code>
       agents, <code>$9.05</code>, <code>14m02s</code>, <code>2m ago</code>) and a column label
       with no column is furniture. Sort stays newest-first and the filter chips stay, so nothing
       becomes unreachable — only re-shaped. The attention queue needs no change at all: it has
       been one card per row since 1100px. <b>Rule on this:</b> the wrapped record versus keeping
       three columns and truncating the name, which is the other way this could go.`,
    ],
  });
}
