import { page, ic, chip, glyph, adapter } from './shell.mjs';
import {
  LIGHT, DARK, TOK, PAIRS, FAILING, THEMES, WELL, STATUS_ORDER, STATUS_GLYPH,
  ADAPTER_ORDER, ADAPTER_MONO, hex, css, r2,
} from './tokens.mjs';
import { GLYPH_NAMES } from './sprite.mjs';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* ---------------------------------------------------------------- swatches */
function swatchTable(rows) {
  return `<div class="swatches" role="table">
  <div class="sw head" role="row">
    <span class="lbl">swat</span><span class="lbl">token</span><span class="lbl">value</span>
    <span class="lbl" style="text-align:right">light</span><span class="lbl" style="text-align:right">dark</span>
  </div>
${rows.map(({ name, value }) => `  <div class="sw" role="row">
    <span class="box" style="background:var(--${name})"></span>
    <span class="tk">--${name}</span>
    <span class="val">${esc(value)}</span>
    <span class="hexv">${hex(LIGHT[name])}</span>
    <span class="hexv">${hex(DARK[name])}</span>
  </div>`).join('\n')}
</div>`;
}

const NEUTRALS = [
  ['canvas', 'oklch anchor — moving it moves every surface'],
  ['surface', 'ink 3% / 4% (cards)'],
  ['surface-raised', 'ink 6% / 7%'],
  ['surface-selected', 'accent 10% / 14%'],
  ['hairline', 'ink 12% / 14% — all structure'],
  ['hairline-strong', 'ink 25% — prefers-contrast: more promotes --hairline to this'],
  ['border', 'ink 52% / 46% — input + control edges, ≥3:1 (added, §3 has no such token)'],
  ['text', 'ink 100%'],
  ['text-2', 'ink 74% — meta rows (added)'],
  ['text-3', 'ink 62% — micro labels, still AA text (added)'],
  ['accent', 'the one interactive hue'],
];

/* ---------------------------------------------------------------- type */
const TYPE_ROWS = [
  ['11px / 600 · uppercase · 0.09em', '<span class="lbl">phase · agents · queue wait · saturation</span>', 'micro labels — the instrument voice'],
  ['11px / 400 · mono · tnum', '<span class="mono" style="font-size:11px">r_2f91c4a8 · 548.2k out · 14m02s · $11.90</span>', 'ids, tokens, durations, costs'],
  ['12px / 400', '<span style="font-size:12px">queue wait 1m58s before the semaphore admitted this agent</span>', 'meta rows, table cells'],
  ['13px / 400', '<span style="font-size:13px">judge-panel-auth-refactor</span>', 'body / UI default'],
  ['13px / 500', '<span style="font-size:13px;font-weight:500">judge-panel-auth-refactor</span>', 'row titles, active labels'],
  ['14px / 400 · 1.45', '<span style="font-size:14px;line-height:1.45">The Host check accepts a trailing dot, so <b>127.0.0.1.</b> bypasses it. Two call sites need the fix.</span>', 'transcript prose'],
  ['16px / 500', '<span style="font-size:16px;font-weight:500">Run cockpit</span>', 'panel titles'],
  ['20px / 500', '<span style="font-size:20px;font-weight:500">Runs</span>', 'screen title'],
  ['24px / 400', '<span style="font-size:24px">No runs yet</span>', 'empty-state display'],
];

/* ---------------------------------------------------------------- body */
function statusBlock() {
  return `<div class="swatches">
  <div class="sw head" style="grid-template-columns:40px 120px 1fr 150px 96px 96px">
    <span class="lbl">swat</span><span class="lbl">state</span><span class="lbl">glyph (§3.2)</span>
    <span class="lbl">chip</span>
    <span class="lbl" style="text-align:right">light</span><span class="lbl" style="text-align:right">dark</span>
  </div>
${STATUS_ORDER.map((k) => `  <div class="sw" style="grid-template-columns:40px 120px 1fr 150px 96px 96px">
    <span class="box" style="background:var(--st-${k})"></span>
    <span class="tk">--st-${k}</span>
    <span class="val" style="display:flex;align-items:center;gap:8px">
      ${glyph(k === 'steered' ? 'steered' : k, { spin: k === 'running' })}
      <span>${STATUS_GLYPH[k]}</span>
    </span>
    <span>${chip(k === 'steered' ? 'steered' : k, null, { spin: k === 'running' })}</span>
    <span class="hexv">${hex(LIGHT[`st-${k}`])}</span>
    <span class="hexv">${hex(DARK[`st-${k}`])}</span>
  </div>`).join('\n')}
  <div class="sw" style="grid-template-columns:40px 120px 1fr 150px 96px 96px">
    <span class="box" style="background:var(--text-3)"></span>
    <span class="tk">unknown</span>
    <span class="val" style="display:flex;align-items:center;gap:8px">${glyph('unknown')}
      <span>neutral info circle — <b>never</b> a success check (parity #56)</span></span>
    <span>${chip('unknown')}</span>
    <span class="hexv">${hex(LIGHT['text-3'])}</span>
    <span class="hexv">${hex(DARK['text-3'])}</span>
  </div>
  <div class="sw" style="grid-template-columns:40px 120px 1fr 150px 96px 96px">
    <span class="box" style="background:var(--text-3);opacity:.45"></span>
    <span class="tk">orphaned</span>
    <span class="val" style="display:flex;align-items:center;gap:8px">
      <span class="g u orphan">${ic('orphaned')}</span>
      <span>agent left queued/running inside a dead run (§6.4 step 8, parity #58)</span></span>
    <span><span class="chip x" style="opacity:.7">${ic('orphaned')}orphaned</span></span>
    <span class="hexv dim">inherits</span><span class="hexv dim">inherits</span>
  </div>
</div>`;
}

function adapterBlock() {
  return `<div class="swatches">
  <div class="sw head" style="grid-template-columns:56px 120px 1fr 96px 96px">
    <span class="lbl">badge</span><span class="lbl">adapter</span><span class="lbl">hue</span>
    <span class="lbl" style="text-align:right">light</span><span class="lbl" style="text-align:right">dark</span>
  </div>
${ADAPTER_ORDER.map((k) => `  <div class="sw" style="grid-template-columns:56px 120px 1fr 96px 96px">
    <span style="display:flex;align-items:center;gap:8px">${adapter(k)}
      <span class="box" style="width:16px;height:16px;background:var(--ad-${k})"></span></span>
    <span class="tk">${k}</span>
    <span class="val">monogram <b>${ADAPTER_MONO[k]}</b> · ${k === 'mock' || k === 'unknown' ? 'neutral (ink 62%)' : `oklch H ${THEMES.light.adapters[k][2]}`} · 16×16 · 9px/600</span>
    <span class="hexv">${hex(LIGHT[`ad-${k}`])}</span>
    <span class="hexv">${hex(DARK[`ad-${k}`])}</span>
  </div>`).join('\n')}
</div>`;
}

function wellBlock() {
  return `<div class="well" style="margin-top:12px">
  <div class="well-h">${ic('terminal', '14')}<span class="cmd">npm test -- --grep "auth"</span>
    <span class="right"><span class="a8">fixed dark in both themes</span></span></div>
  <div class="well-b"><span class="a8">$</span> node scripts/test.mjs
<span class="a2">✔</span> auth: rejects a wrong Host header <span class="a8">(4ms)</span>
<span class="a2">✔</span> auth: rejects a missing token <span class="a8">(2ms)</span>
<span class="a1">✖</span> auth: constant-time token compare <span class="a8">(1ms)</span>
  <span class="a3">expected</span> <span class="a6">timingSafeEqual</span>, <span class="a3">got</span> <span class="a6">===</span>
<span class="a11 abold">warning</span> 1 test failed, 143 passed
<span class="abg">near-white on near-white from the tool</span> <span class="a8">← §9.8 forces a legible fg whenever SGR 48 lands</span></div>
  <div class="well-f">${ic('close', '12')}<span class="ec">exit code 1</span>
    <span class="a8">— rendered only because the adapter reported one (§2.5; never fabricated from isError)</span></div>
</div>
<div class="glyph-grid" style="grid-template-columns:repeat(8,1fr);margin-top:12px">
${Array.from({ length: 16 }, (_, i) => `  <div class="gl" style="background:var(--well)">
    <span class="box" style="width:100%;height:18px;border-radius:2px;border-color:transparent;background:var(--ansi-${i})"></span>
    <span class="nm" style="color:var(--well-text)">${i} ${WELL.names[i]}</span>
    <span class="nm" style="color:var(--ansi-8)">${r2(PAIRS.find((p) => p.label.startsWith(`ANSI ${i} `)).light)}:1</span>
  </div>`).join('\n')}
</div>`;
}

function contrastTable() {
  const row = (p) => {
    const v = p.role === 'decor' ? 'exempt' : p.pass ? 'pass' : 'FAIL';
    const cls = p.role === 'decor' ? 'exempt' : p.pass ? 'ok' : 'bad';
    return `    <tr><th scope="row">${esc(p.label)}</th>
      <td class="req">${p.role === 'decor' ? 'decorative' : p.role === 'ui' ? 'UI ≥3:1' : 'text ≥4.5:1'}</td>
      <td class="num">${r2(p.light)}</td><td class="num">${r2(p.dark)}</td>
      <td class="verdict ${cls}">${v}</td></tr>`;
  };
  return `<table class="ctable">
  <thead><tr><th>pair (fg on bg)</th><th>requirement</th><th style="text-align:right">light</th>
    <th style="text-align:right">dark</th><th>verdict</th></tr></thead>
  <tbody>
${PAIRS.map(row).join('\n')}
  </tbody>
</table>`;
}

const MOTION = [
  ['120ms', 'hover / press', 'row background, button fill, icon color'],
  ['160ms', 'disclosure', 'step groups, phase tree, reasoning blocks — the closing body is retained for the transition (parity #94)'],
  ['200ms', 'panel slide', 'transcript split, rails, log-lane drawer'],
  ['300ms', 'state pulse', 'a one-shot accent-8% background pulse on a row whose state just changed'],
];

export function pageTokens() {
  const body = `
<div class="doc">
  <div class="frame-head" style="margin-bottom:0">
    <h2 style="font-size:24px;border:0;padding:0">flowition viewer — design system</h2>
    <span class="w">tokens.html · DESIGN §3.1–§3.6</span>
  </div>
  <p class="lead">Every color below is computed from the OKLCH anchors in
  <code>lib/tokens.mjs</code>; every ratio is computed by <code>lib/color.mjs</code> at
  generate time, not typed by hand. <b>${PAIRS.length} pairs checked, ${FAILING.length} failing.</b>
  The light theme in DESIGN §3.2 did <b>not</b> pass — seven tokens were darkened and the
  mix space changed from <code>oklch</code> to <code>oklab</code>. Both changes are listed
  in the comps README.</p>
  <p class="lead"><b>Fonts are not loaded.</b> No <code>@font-face</code>, no
  <code>&lt;link&gt;</code>, no network request of any kind. The stacks name IBM Plex Sans
  and JetBrains Mono first and fall back to the system UI and mono faces, so these files
  render identically offline. Judge layout, hierarchy, density and color here; the vendored
  faces shift metrics by ~1–2% and change nothing structural.</p>

  <section>
    <h2>1 · Type scale <span class="src">§3.1 — 11 / 12 / 13 / 14 / 16 / 20 / 24 · weights 400·500·600 only</span></h2>
    <div class="type-spec">
${TYPE_ROWS.map(([k, spec, use]) => `      <div class="ts"><span class="k">${k}<br><span class="dim">${use}</span></span><span>${spec}</span></div>`).join('\n')}
    </div>
    <p class="lead"><code>font-feature-settings: 'tnum'</code> is on <code>body</code>, so every
    numeric column aligns without per-cell opt-in. Numbers and identifiers are always mono;
    labels are never mono. That single split is what makes the tables read as instrument
    readouts rather than a web page.</p>
  </section>

  <section>
    <h2>2 · Neutrals and the anchor technique <span class="src">§3.2</span></h2>
    <p class="lead">Two anchors per theme (<code>--canvas</code>, <code>--ink</code>) plus one
    <code>--accent</code>; every surface is a <code>color-mix()</code> of them. Swatches below
    render live in the current theme; the two right columns are the computed sRGB in both.</p>
    ${swatchTable(NEUTRALS.map(([name, value]) => ({ name, value })))}
  </section>

  <section>
    <h2>3 · State semantics <span class="src">§3.2 — the only saturated colors in the resting UI</span></h2>
    <p class="lead">Nine states, nine glyphs. State is always carried by glyph + text, never by
    color alone (§3.6). <code>steered</code> is an <b>annotation</b> on an agent, never a state
    transition — the fold must not let it overwrite <code>running</code> (§6.4 step 3).</p>
    ${statusBlock()}
  </section>

  <section>
    <h2>4 · Adapter monograms <span class="src">§3.2 / parity #57 — never a vendor brand mark</span></h2>
    <p class="lead">Low-tint badge, hue-colored monogram, 1px edge at hue 26%. Kept quiet on
    purpose: adapter identity is <b>not</b> state, so it must not compete with the state colors
    for attention. Cluster form (deduped, max 4 + <code>+n</code>) is what the run table shows.</p>
    ${adapterBlock()}
    <div class="duo" style="grid-template-columns:1fr 1fr">
      <div><div class="duo-tag"><span class="lbl">cluster, 4 + overflow</span></div>
        <span class="ad-cluster">${adapter('claude')}${adapter('codex')}${adapter('amp')}${adapter('droid')}<span class="more">+1</span></span></div>
      <div><div class="duo-tag"><span class="lbl">inline with a model, as the agents table renders it</span></div>
        <span style="display:flex;align-items:center;gap:6px;font:400 11px/1 var(--mono)">${adapter('claude')} opus-5 <span class="dim">· xhigh</span></span></div>
    </div>
  </section>

  <section>
    <h2>5 · Terminal well <span class="src">§3.2 — fixed dark in both themes, decision final</span></h2>
    <p class="lead">A terminal is a terminal. One well surface and one 16-color palette tuned
    for it means 256-color and truecolor passthrough is safe without a per-theme contrast
    rewrite. Toggle the theme — the well does not move.</p>
    ${wellBlock()}
  </section>

  <section>
    <h2>6 · Spacing &amp; density <span class="src">§3.3 — 4px base</span></h2>
    <div class="space-scale">
${[4, 8, 12, 16, 20, 24, 32, 48].map((n) => `      <div class="u"><i style="width:${n}px"></i><span>${n}</span></div>`).join('\n')}
    </div>
    <div class="duo" style="margin-top:16px">
      <div>
        <div class="duo-tag"><span class="lbl">row heights</span></div>
        <div style="display:grid;gap:6px;font:400 12px/1 var(--mono);color:var(--text-2)">
          <div style="display:flex;align-items:center;gap:12px"><i style="display:block;width:120px;height:44px;background:var(--surface);border:1px solid var(--hairline);border-radius:2px"></i>44px run list row</div>
          <div style="display:flex;align-items:center;gap:12px"><i style="display:block;width:120px;height:32px;background:var(--surface);border:1px solid var(--hairline);border-radius:2px"></i>32px agent table row / gantt lane</div>
          <div style="display:flex;align-items:center;gap:12px"><i style="display:block;width:120px;height:12px;background:var(--surface);border:1px solid var(--hairline);border-radius:2px"></i>12px transcript gutter</div>
        </div>
      </div>
      <div>
        <div class="duo-tag"><span class="lbl">elevation is border + shadow, never tint</span></div>
        <div style="display:flex;gap:16px;align-items:flex-start">
          <div class="card" style="padding:12px;font-size:12px;width:150px">flat card<br><span class="dim micro">hairline only</span></div>
          <div class="card raised" style="padding:12px;font-size:12px;width:150px">raised<br><span class="dim micro">hairline + shadow</span></div>
        </div>
        <div class="duo-tag" style="margin-top:16px"><span class="lbl">radii — 2px and 3px, nothing else</span></div>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="btn">quiet</span><span class="btn primary">${ic('send', '12')}Send</span>
          <span class="btn danger">${ic('trash', '12')}Delete</span>
          <span class="btn demo-focus">:focus-visible</span>
        </div>
        <p class="lead" style="font-size:11px">§3.7: exactly one accent-filled action per screen
        region. Cancel / Resume / Delete are quiet outlines; Delete is additionally red-text.</p>
      </div>
    </div>
  </section>

  <section>
    <h2>7 · Iconography <span class="src">§3.5 — one hand-authored sprite, ${GLYPH_NAMES.length} glyphs, 1.5px stroke, 16px grid</span></h2>
    <div class="glyph-grid">
${GLYPH_NAMES.map((n) => `      <div class="gl">${ic(n, '20', n === 'running' ? 'ic-spin' : '')}<span class="nm">${n}</span></div>`).join('\n')}
    </div>
  </section>

  <section>
    <h2>8 · Motion <span class="src">§3.4 — cubic-bezier(0.2, 0, 0, 1)</span></h2>
    <div class="motion-grid">
${MOTION.map(([d, u, w]) => `      <div class="mo"><div class="d">${d}</div><div class="u2">${u}</div><div class="w">${w}</div></div>`).join('\n')}
    </div>
    <p class="lead">The running spinner is the <b>only</b> looping animation in the product. Live
    token counters tick without animation — the numbers simply change, because a value that
    animates cannot be read while it moves. <code>prefers-reduced-motion: reduce</code> kills
    every transition and stops the spinner, which then reads as the static partial circle it
    already is. <code>prefers-contrast: more</code> promotes <code>--hairline</code> to ink 25%.</p>
    <div class="duo">
      <div><div class="duo-tag"><span class="lbl">state-change pulse (300ms, accent 8%)</span></div>
        <div class="rt-row pulse-demo" style="border:1px solid var(--hairline);border-radius:2px;grid-template-columns:18px 1fr auto">
          ${glyph('done')}<span class="rt-name"><span class="nm">survey:client</span></span>${chip('done')}</div></div>
      <div><div class="duo-tag"><span class="lbl">the easing curve</span></div>
        <svg class="ease-curve" width="180" height="72" viewBox="0 0 180 72" aria-label="cubic-bezier(0.2, 0, 0, 1)">
          <rect x=".5" y=".5" width="179" height="71" fill="none" stroke="var(--hairline)"/>
          <path d="M0 72 C36 72 180 0 180 0" fill="none" stroke="var(--accent)" stroke-width="1.5"/>
        </svg></div>
    </div>
  </section>

  <section>
    <h2>9 · Contrast gate <span class="src">§3.6 — WCAG 2.2 AA · computed, not asserted</span></h2>
    <p class="lead">Text ≥ 4.5:1 against its own surface; UI components and glyph strokes
    ≥ 3:1. Both themes. <b>${PAIRS.length} pairs, ${FAILING.length} failing.</b> ANSI 0 is the
    single exemption and carries its reason: it is a background/rule color, never body text,
    and §9.8 forces a legible foreground whenever a tool applies it via SGR 48.</p>
    ${contrastTable()}
  </section>
</div>`;

  return page({
    title: 'design system',
    file: 'tokens.html',
    sections: '§3.1–§3.6',
    note: `${PAIRS.length} contrast pairs · ${FAILING.length} failing`,
    body,
  });
}
