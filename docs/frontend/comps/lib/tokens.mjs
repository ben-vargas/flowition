// The design system's single source of truth for these comps.
//
// Realizes DESIGN §3.2 (color), §3.1 (type), §3.3 (space), §3.4 (motion).
// Every value that deviates from §3.2's table carries a `// §3:` comment naming the
// spec value it replaces; the README's Deviations section explains each one.

import { contrast, hex, css, mix, r2 } from './color.mjs';

const c = (L, C, H) => [L, C, H];

// ---------------------------------------------------------------------------
// Anchors and the per-theme mix percentages (the two-anchor technique,
// DESIGN §3.2: move the canvas and every surface follows).
// ---------------------------------------------------------------------------
export const THEMES = {
  light: {
    canvas: c(0.975, 0.004, 95),
    ink: c(0.21, 0.015, 255),
    accent: c(0.50, 0.15, 255), // §3: 0.55 — fails 4.5:1 on --surface-raised (3.97)
    pct: {
      surface: 3, raised: 6, hairline: 12, hairlineStrong: 25, border: 52,
      selected: 10, tint: 12, adTint: 14,
      text2: 74, text3: 62, queued: 62, cancelled: 74,
    },
    status: {
      running: c(0.50, 0.16, 250), // §3: 0.58 — 3.73 on --surface
      done:    c(0.49, 0.14, 150), // §3: 0.58 — 3.50
      cached:  c(0.48, 0.11, 190), // §3: 0.60 — 3.22
      failed:  c(0.52, 0.20, 25),  // §3: 0.55 — 4.37 on --surface-raised
      stale:   c(0.50, 0.15, 75),  // §3: 0.66 — 2.77 (worst offender)
      blocked: c(0.52, 0.17, 300), // §3: 0.56 — 4.37
    },
    adapters: {
      claude:   c(0.50, 0.13, 40),  // §3: 0.62
      codex:    c(0.47, 0.11, 220), // §3: 0.60
      amp:      c(0.49, 0.12, 85),  // §3: 0.68 — 2.39 as a 9px monogram
      droid:    c(0.47, 0.13, 130), // §3: 0.64
      opencode: c(0.50, 0.13, 295), // §3: 0.58
      pi:       c(0.50, 0.13, 350), // §3: 0.60
    },
    shadow:
      '0 1px 1px oklch(0.21 0.015 255 / 0.05), 0 6px 16px -8px oklch(0.21 0.015 255 / 0.14)',
  },
  dark: {
    canvas: c(0.165, 0.012, 255), // §3 verbatim
    ink: c(0.93, 0.006, 95),      // §3 verbatim
    accent: c(0.72, 0.13, 255),   // §3 verbatim
    pct: {
      surface: 4, raised: 7, hairline: 14, hairlineStrong: 25, border: 46,
      selected: 14, tint: 16, adTint: 16,
      text2: 74, text3: 62, queued: 62, cancelled: 74,
    },
    status: {
      running: c(0.70, 0.14, 250), // §3 verbatim
      done:    c(0.70, 0.13, 150), // §3 verbatim
      cached:  c(0.72, 0.10, 190), // §3 verbatim
      failed:  c(0.66, 0.19, 25),  // §3 verbatim
      stale:   c(0.76, 0.14, 75),  // §3 verbatim
      blocked: c(0.70, 0.15, 300), // §3 verbatim
    },
    adapters: {
      claude:   c(0.72, 0.12, 40),  // §3 verbatim
      codex:    c(0.72, 0.10, 220), // §3 verbatim
      amp:      c(0.78, 0.11, 85),  // §3 verbatim
      droid:    c(0.74, 0.12, 130), // §3 verbatim
      opencode: c(0.70, 0.12, 295), // §3 verbatim
      pi:       c(0.72, 0.12, 350), // §3 verbatim
    },
    shadow:
      '0 1px 1px oklch(0.05 0 0 / 0.5), 0 8px 20px -10px oklch(0.05 0 0 / 0.7)',
  },
};

// The terminal well is theme-invariant (DESIGN §3.2, "Decision final").
export const WELL = {
  bg: c(0.19, 0.01, 255),
  text: c(0.90, 0.005, 95),
  ansi: {
    0: c(0.34, 0.012, 255), 1: c(0.68, 0.17, 25), 2: c(0.76, 0.15, 145),
    3: c(0.84, 0.13, 90), 4: c(0.72, 0.13, 255), 5: c(0.72, 0.15, 315),
    6: c(0.80, 0.10, 200), 7: c(0.90, 0.005, 95),
    8: c(0.62, 0.012, 255), 9: c(0.76, 0.16, 25), 10: c(0.85, 0.14, 145),
    11: c(0.90, 0.12, 92), 12: c(0.80, 0.11, 255), 13: c(0.80, 0.13, 315),
    14: c(0.88, 0.09, 200), 15: c(0.98, 0.002, 95),
  },
  names: ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'bright black', 'bright red', 'bright green', 'bright yellow',
    'bright blue', 'bright magenta', 'bright cyan', 'bright white'],
};

export const STATUS_ORDER = ['queued', 'running', 'done', 'cached', 'failed',
  'cancelled', 'stale', 'blocked', 'steered'];
export const STATUS_GLYPH = {
  queued: 'dashed circle', running: 'spinning dashed circle',
  done: 'check circle', cached: 'replay arrow-circle', failed: 'x circle',
  cancelled: 'slashed circle', stale: 'alert triangle',
  blocked: 'question circle', steered: 'envelope tick',
};
export const ADAPTER_ORDER = ['claude', 'codex', 'amp', 'droid', 'opencode', 'pi',
  'mock', 'unknown'];
export const ADAPTER_MONO = {
  claude: 'CL', codex: 'CX', amp: 'AM', droid: 'DR',
  opencode: 'OC', pi: 'π', mock: 'MK', unknown: '·',
};

/** Resolve one theme's raw defs into concrete OKLCH triples per token name. */
export function resolve(name) {
  const t = THEMES[name];
  const { canvas, ink, accent, pct } = t;
  const T = {
    canvas, ink, accent,
    'on-accent': canvas,
    surface: mix(ink, canvas, pct.surface),
    'surface-raised': mix(ink, canvas, pct.raised),
    'surface-selected': mix(accent, canvas, pct.selected),
    hairline: mix(ink, canvas, pct.hairline),
    'hairline-strong': mix(ink, canvas, pct.hairlineStrong),
    border: mix(ink, canvas, pct.border),
    text: ink,
    'text-2': mix(ink, canvas, pct.text2),
    'text-3': mix(ink, canvas, pct.text3),
  };
  // Status: two of the nine are neutral by spec; they are ink-ramp steps, not hues.
  T['st-queued'] = mix(ink, canvas, pct.queued);        // §3: ink 45%/55% (2.83/4.17)
  T['st-cancelled'] = mix(ink, canvas, pct.cancelled);  // §3: ink 50%/55% (3.29/4.17)
  for (const [k, v] of Object.entries(t.status)) T[`st-${k}`] = v;
  T['st-steered'] = T['st-blocked']; // §3: "violet (annotation, never a state)"
  for (const k of STATUS_ORDER) T[`st-${k}-tint`] = mix(T[`st-${k}`], canvas, pct.tint);
  // Adapters: mock/unknown are neutral (§3 says ink 40%; raised to the text-3 step so
  // the 9px monogram clears 4.5:1 on its own badge tint).
  for (const [k, v] of Object.entries(t.adapters)) T[`ad-${k}`] = v;
  T['ad-mock'] = T['text-3'];
  T['ad-unknown'] = T['text-3'];
  for (const k of ADAPTER_ORDER) T[`ad-${k}-tint`] = mix(T[`ad-${k}`], canvas, pct.adTint);
  return T;
}

export const LIGHT = resolve('light');
export const DARK = resolve('dark');
export const TOK = { light: LIGHT, dark: DARK };

// ---------------------------------------------------------------------------
// CSS emission. Derived tokens emit as live color-mix() so the anchor technique
// stays real in the comp: change --canvas and every surface follows.
// ---------------------------------------------------------------------------
function themeBlock(name) {
  const t = THEMES[name];
  const { pct } = t;
  const M = (a, p, b = '--canvas') =>
    `color-mix(in oklab, var(${a}) ${p}%, var(${b}))`;
  const lines = [
    `  --canvas: ${css(t.canvas)};`,
    `  --ink: ${css(t.ink)};`,
    `  --accent: ${css(t.accent)};`,
    `  --tint: ${pct.tint}%;`,
    `  --ad-tint: ${pct.adTint}%;`,
    '',
    `  --surface: ${M('--ink', pct.surface)};`,
    `  --surface-raised: ${M('--ink', pct.raised)};`,
    `  --surface-selected: ${M('--accent', pct.selected)};`,
    `  --hairline: ${M('--ink', pct.hairline)};`,
    `  --hairline-strong: ${M('--ink', pct.hairlineStrong)};`,
    `  --border: ${M('--ink', pct.border)};`,
    '',
    `  --text: var(--ink);`,
    `  --text-2: ${M('--ink', pct.text2)};`,
    `  --text-3: ${M('--ink', pct.text3)};`,
    `  --on-accent: var(--canvas);`,
    '',
    `  --st-queued: ${M('--ink', pct.queued)};`,
    `  --st-cancelled: ${M('--ink', pct.cancelled)};`,
  ];
  for (const [k, v] of Object.entries(t.status)) lines.push(`  --st-${k}: ${css(v)};`);
  lines.push('  --st-steered: var(--st-blocked);', '');
  for (const k of STATUS_ORDER) {
    lines.push(`  --st-${k}-tint: color-mix(in oklab, var(--st-${k}) var(--tint), var(--canvas));`);
  }
  lines.push('');
  for (const [k, v] of Object.entries(t.adapters)) lines.push(`  --ad-${k}: ${css(v)};`);
  lines.push('  --ad-mock: var(--text-3);', '  --ad-unknown: var(--text-3);');
  for (const k of ADAPTER_ORDER) {
    lines.push(`  --ad-${k}-tint: color-mix(in oklab, var(--ad-${k}) var(--ad-tint), var(--canvas));`);
  }
  lines.push('', `  --shadow-raised: ${t.shadow};`);
  lines.push(`  color-scheme: ${name};`);
  return `[data-theme="${name}"] {\n${lines.join('\n')}\n}`;
}

export function tokenCss() {
  const ansi = Object.entries(WELL.ansi)
    .map(([i, v]) => `  --ansi-${i}: ${css(v)};`)
    .join('\n');
  return [
    themeBlock('light'),
    themeBlock('dark'),
    // Terminal well: fixed in both themes (DESIGN §3.2, decision final).
    `:root {\n  --well: ${css(WELL.bg)};\n  --well-text: ${css(WELL.text)};\n${ansi}\n}`,
  ].join('\n\n');
}

// ---------------------------------------------------------------------------
// The §3.6 contrast gate. Every pair the spec states, computed in both themes.
// role 'text' -> 4.5:1 (WCAG 2.2 AA, 1.4.3)
// role 'ui'   -> 3:1   (1.4.11 non-text contrast)
// role 'decor'-> exempt, with a stated reason
// ---------------------------------------------------------------------------
function pairs() {
  const out = [];
  const add = (label, role, fg, bg, note) => out.push({
    label, role, note,
    light: contrast(LIGHT[fg] ?? fg, LIGHT[bg] ?? bg),
    dark: contrast(DARK[fg] ?? fg, DARK[bg] ?? bg),
  });
  add('--text on --canvas', 'text', 'text', 'canvas');
  add('--text on --surface', 'text', 'text', 'surface');
  add('--text on --surface-raised', 'text', 'text', 'surface-raised');
  add('--text on --surface-selected', 'text', 'text', 'surface-selected');
  add('--text-2 on --surface', 'text', 'text-2', 'surface');
  add('--text-2 on --surface-raised', 'text', 'text-2', 'surface-raised');
  add('--text-3 on --canvas', 'text', 'text-3', 'canvas');
  add('--text-3 on --surface-raised', 'text', 'text-3', 'surface-raised');
  add('--accent link on --canvas', 'text', 'accent', 'canvas');
  add('--accent link on --surface-raised', 'text', 'accent', 'surface-raised');
  add('--on-accent on --accent (primary button)', 'text', 'on-accent', 'accent');
  add('--accent focus ring on --canvas', 'ui', 'accent', 'canvas');
  add('--accent focus ring on --surface-raised', 'ui', 'accent', 'surface-raised');
  add('--border (input edge) on --surface', 'ui', 'border', 'surface');
  add('--border (input edge) on --canvas', 'ui', 'border', 'canvas');
  for (const k of STATUS_ORDER) add(`--st-${k} label on --surface`, 'text', `st-${k}`, 'surface');
  for (const k of STATUS_ORDER) add(`--st-${k} label on --st-${k}-tint (chip)`, 'text', `st-${k}`, `st-${k}-tint`);
  for (const k of STATUS_ORDER) add(`--st-${k} glyph stroke on --canvas`, 'ui', `st-${k}`, 'canvas');
  for (const k of ADAPTER_ORDER) add(`adapter ${k} monogram on --ad-${k}-tint`, 'text', `ad-${k}`, `ad-${k}-tint`);
  add('budget gauge fill (--accent) on track (--hairline)', 'ui', 'accent', 'hairline');
  add('gauge overshoot hatch (--st-failed) on track', 'ui', 'st-failed', 'hairline');
  add('gantt queue-wait hatch (--text-3) on lane (--surface)', 'ui', 'text-3', 'surface');
  add('saturation strip fill (--accent) on --surface', 'ui', 'accent', 'surface');
  add('well default text on --well', 'text', WELL.text, WELL.bg);
  for (let i = 0; i < 16; i++) {
    add(`ANSI ${i} ${WELL.names[i]} on --well`, i === 0 ? 'decor' : 'text',
      WELL.ansi[i], WELL.bg,
      i === 0 ? 'ANSI 0 is conventionally a background/rule color, never body text; §9.8 forces a legible foreground whenever SGR 48 applies it as a background.' : undefined);
  }
  return out;
}

export const PAIRS = pairs().map((p) => {
  const need = p.role === 'text' ? 4.5 : p.role === 'ui' ? 3 : 0;
  return { ...p, need, pass: p.light >= need && p.dark >= need };
});

export const FAILING = PAIRS.filter((p) => p.role !== 'decor' && !p.pass);

export { hex, css, contrast, mix, r2 };
