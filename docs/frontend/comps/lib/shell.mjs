import { CSS } from './css.mjs';
import { SPRITE, ic } from './sprite.mjs';

export { ic };

/**
 * The page wrapper. Self-contained: inline <style>, inline SVG sprite, no <link>,
 * no external request, no font file.
 *
 * The ONLY script is the theme toggle: a single attribute swap on <html>, which the
 * unit brief explicitly permits. The shipped viewer does this with the external,
 * render-blocking /boot-theme.js instead (DESIGN §9.9) because its CSP forbids inline
 * script — do not copy the inline handler into the app.
 */
export function page({ title, file, sections, note, body, notes = [], viewports = '1440px' }) {
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1440">
<title>flowition viewer — ${title}</title>
<style>${CSS}</style>
</head>
<body>
${SPRITE}
<div class="chrome">
  <b>${file}</b>
  <span class="sep">│</span><span>reference comp · W8a design gate</span>
  <span class="sep">│</span><span>DESIGN ${sections}</span>
  <span class="sep">│</span><span>${viewports}</span>
  <div class="chrome-right">
    ${note ? `<span>${note}</span><span class="sep">│</span>` : ''}
    <div class="seg" role="group" aria-label="Theme">
      <button class="on-l" onclick="document.documentElement.dataset.theme='light'">${ic('sun', '12')}light</button>
      <button class="on-d" onclick="document.documentElement.dataset.theme='dark'">${ic('moon', '12')}dark</button>
    </div>
  </div>
</div>
${body}
${notes.length ? `<div class="frame-wrap"><div class="notes">
  <div class="lbl" style="margin-bottom:8px">Annotations — what to rule on</div>
  <ol>
${notes.map((n) => `    <li>${n}</li>`).join('\n')}
  </ol>
</div></div>` : ''}
</body>
</html>
`;
}

/**
 * A comp frame with a caption. 1440px by default; pass `cls: 'w800'` for §3.7's second
 * required viewport (the `.w800` rules in css.mjs mirror the app's <900px media query,
 * which a fixed-width box inside a 1440px page cannot trigger on its own).
 */
export const frame = (label, width, inner, cls = '') => `<div class="frame-wrap">
  <div class="frame-head"><h2>${label}</h2><span class="w">${width}</span></div>
  <div class="frame${cls ? ` ${cls}` : ''}">${inner}</div>
</div>`;

/** Numbered annotation marker, absolutely positioned inside a .frame. */
export const mk = (n, css) => `<span class="mk" style="${css}">${n}</span>`;

/** Product top bar (shared by all three screen comps). */
export const topbar = (current, extra = '') => `<div class="topbar">
  <div class="brand"><span class="wm">flo<i>w</i>ition</span><span class="v">viewer 0.2.0</span></div>
  <nav class="nav" aria-label="Primary">
    <a href="#/" ${current === 'home' ? 'aria-current="page"' : ''}>Runs</a>
    <a href="#/run/r_2f91c4a8" ${current === 'run' ? 'aria-current="page"' : ''}>Cockpit</a>
  </nav>
  <div class="topbar-right">
    ${extra}
    <span class="ro-chip">${ic('cancel', '12')}read-only</span>
    <button class="btn ghost" aria-label="Command palette">${ic('search', '12')}<kbd>⌘K</kbd></button>
    <button class="icb" aria-label="Keyboard shortcuts">${ic('keyboard')}</button>
  </div>
</div>`;

/** Status chip. `s` is the one-letter class from css.mjs (.chip.q/.r/.d/…). */
const CHIP = {
  queued: ['q', 'queued', 'queued'],
  running: ['r', 'running', 'running'],
  done: ['d', 'done', 'done'],
  cached: ['c', 'cached', 'cached'],
  failed: ['f', 'failed', 'failed'],
  cancelled: ['x', 'cancelled', 'cancelled'],
  stale: ['s', 'stale', 'stale'],
  blocked: ['b', 'blocked', 'blocked'],
  steered: ['st', 'steered', 'steered'],
  unknown: ['q', 'unknown', 'unknown'],
  completed: ['d', 'done', 'completed'],
  interrupted: ['x', 'cancelled', 'interrupted'],
  starting: ['q', 'queued', 'starting'],
};
export function chip(state, label, { spin = false } = {}) {
  const [cls, glyph, text] = CHIP[state] ?? CHIP.unknown;
  return `<span class="chip ${cls}">${ic(glyph, '', spin ? 'ic-spin' : '')}${label ?? text}</span>`;
}
/** Glyph-only status mark, with a visually-hidden label (§3.6 — never color alone). */
export function glyph(state, { spin = false, orphan = false } = {}) {
  const [cls, g, text] = CHIP[state] ?? CHIP.unknown;
  return `<span class="g ${cls}${orphan ? ' orphan' : ''}">${ic(g, '', spin ? 'ic-spin' : '')}<span class="vh">${orphan ? `orphaned (${text})` : text}</span></span>`;
}

const MONO = {
  claude: 'CL', codex: 'CX', amp: 'AM', droid: 'DR',
  opencode: 'OC', pi: 'π', mock: 'MK', unknown: '·',
};
export const adapter = (name) =>
  `<span class="ad ad-${name}" title="${name}">${MONO[name] ?? '·'}<span class="vh">adapter ${name}</span></span>`;
export const cluster = (names, more = 0) =>
  `<span class="ad-cluster">${names.map(adapter).join('')}${more ? `<span class="more">+${more}</span>` : ''}</span>`;
