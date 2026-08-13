// The design system's single source of truth (DESIGN §3.2 color, §3.1 type, §3.3 space,
// §3.4 motion) — ported from docs/frontend/comps/lib/tokens.mjs, which the operator
// approved at the W8a design gate.
//
// `src/ui/tokens.css` is EMITTED from `tokenCss()` by `scripts/emit-tokens.mjs` and pinned
// byte-identical by `tokens.test.ts`, so the stylesheet a browser loads and the values the
// §3.6 contrast gate checks cannot drift apart. Change a token here, run `npm run tokens`.
//
// Every value that deviates from §3.2's table carries a `// §3:` comment naming the spec
// value it replaces; comps/README.md "Deviations" (D1–D9) carries the argument for each,
// and all nine were ruled to STAND.

import { contrast, css, mix, type Oklch } from './color.js'

const c = (L: number, C: number, H: number): Oklch => [L, C, H]

type ThemeName = 'light' | 'dark'

interface ThemeDef {
  canvas: Oklch
  ink: Oklch
  accent: Oklch
  pct: {
    surface: number; raised: number; hairline: number; hairlineStrong: number
    border: number; selected: number; tint: number; adTint: number
    text2: number; text3: number; queued: number; cancelled: number
  }
  status: Record<'running' | 'done' | 'cached' | 'failed' | 'stale' | 'blocked', Oklch>
  adapters: Record<'claude' | 'codex' | 'amp' | 'droid' | 'opencode' | 'pi' | 'cursor', Oklch>
  shadow: string
}

// ---------------------------------------------------------------------------
// Anchors and the per-theme mix percentages (the two-anchor technique,
// DESIGN §3.2): move --canvas and every surface follows.
// ---------------------------------------------------------------------------
export const THEMES: Record<ThemeName, ThemeDef> = {
  light: {
    canvas: c(0.975, 0.004, 95),
    ink: c(0.21, 0.015, 255),
    accent: c(0.50, 0.15, 255), // §3: 0.55 — fails 4.5:1 on --surface-raised (3.97). D2
    pct: {
      surface: 3, raised: 6, hairline: 12, hairlineStrong: 25, border: 52,
      selected: 10, tint: 12, adTint: 14,
      text2: 74, text3: 62, queued: 62, cancelled: 74,
    },
    status: {
      running: c(0.50, 0.16, 250), // §3: 0.58 — 3.73 on --surface. D3
      done: c(0.49, 0.14, 150),    // §3: 0.58 — 3.50
      cached: c(0.48, 0.11, 190),  // §3: 0.60 — 3.22
      failed: c(0.52, 0.20, 25),   // §3: 0.55 — 4.37 on --surface-raised
      stale: c(0.50, 0.15, 75),    // §3: 0.66 — 2.77 (worst offender)
      blocked: c(0.52, 0.17, 300), // §3: 0.56 — 4.37
    },
    adapters: {
      claude: c(0.50, 0.13, 40),    // §3: 0.62. D5
      codex: c(0.47, 0.11, 220),    // §3: 0.60
      amp: c(0.49, 0.12, 85),       // §3: 0.68 — 2.39 as a 9px monogram
      droid: c(0.47, 0.13, 130),    // §3: 0.64
      opencode: c(0.50, 0.13, 295), // §3: 0.58
      pi: c(0.50, 0.13, 350),       // §3: 0.60
      cursor: c(0.47, 0.11, 180),   // post-§3 adapter — gated like the rest
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
      running: c(0.70, 0.14, 250), // §3 verbatim — the dark theme passes §3.6 as specified
      done: c(0.70, 0.13, 150),
      cached: c(0.72, 0.10, 190),
      failed: c(0.66, 0.19, 25),
      stale: c(0.76, 0.14, 75),
      blocked: c(0.70, 0.15, 300),
    },
    adapters: {
      claude: c(0.72, 0.12, 40),    // §3 verbatim
      codex: c(0.72, 0.10, 220),
      amp: c(0.78, 0.11, 85),
      droid: c(0.74, 0.12, 130),
      opencode: c(0.70, 0.12, 295),
      pi: c(0.72, 0.12, 350),
      cursor: c(0.72, 0.10, 180),
    },
    shadow:
      '0 1px 1px oklch(0.05 0 0 / 0.5), 0 8px 20px -10px oklch(0.05 0 0 / 0.7)',
  },
}

/** The terminal well is theme-invariant (DESIGN §3.2, "Decision final"). */
export const WELL = {
  bg: c(0.19, 0.01, 255),
  text: c(0.90, 0.005, 95),
  ansi: {
    0: c(0.34, 0.012, 255), 1: c(0.68, 0.17, 25), 2: c(0.76, 0.15, 145),
    3: c(0.84, 0.13, 90), 4: c(0.72, 0.13, 255), 5: c(0.72, 0.15, 315),
    6: c(0.80, 0.10, 200), 7: c(0.90, 0.005, 95),
    // D8: §3.2's L 0.56 for bright black was 3.97 on the well. Bright black is
    // conventionally dim TEXT, so it is gated like text.
    8: c(0.62, 0.012, 255), 9: c(0.76, 0.16, 25), 10: c(0.85, 0.14, 145),
    11: c(0.90, 0.12, 92), 12: c(0.80, 0.11, 255), 13: c(0.80, 0.13, 315),
    14: c(0.88, 0.09, 200), 15: c(0.98, 0.002, 95),
  } as Record<number, Oklch>,
  names: ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
    'bright black', 'bright red', 'bright green', 'bright yellow',
    'bright blue', 'bright magenta', 'bright cyan', 'bright white'],
} as const

/** The nine §3.2 states. `steered` is an ANNOTATION, never a state (§6.4). */
export const STATUS_ORDER = ['queued', 'running', 'done', 'cached', 'failed',
  'cancelled', 'stale', 'blocked', 'steered'] as const
export type StatusName = typeof STATUS_ORDER[number]

export const ADAPTER_ORDER = ['claude', 'codex', 'amp', 'droid', 'opencode', 'pi',
  'cursor', 'mock', 'unknown'] as const
export type AdapterName = typeof ADAPTER_ORDER[number]

/** §3.2: two-letter monogram badges. NEVER a vendor's brand mark (parity #57). */
export const ADAPTER_MONO: Record<string, string> = {
  claude: 'CL', codex: 'CX', amp: 'AM', droid: 'DR',
  opencode: 'OC', pi: 'π', cursor: 'CS', mock: 'MK', unknown: '·',
}

/** Resolve one theme's raw defs into concrete OKLCH triples per token name. */
export function resolve(name: ThemeName): Record<string, Oklch> {
  const t = THEMES[name]
  const { canvas, ink, accent, pct } = t
  const T: Record<string, Oklch> = {
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
  }
  // D4: §3.2 gives queued ink 45%/55% and cancelled ink 50%/55%. As LABEL TEXT those are
  // 2.83/3.29 (light) and 4.17 (dark) — below 4.5:1. They become the --text-3 and --text-2
  // ramp steps in both themes; the two states stay distinguishable by GLYPH (dashed vs
  // slashed circle), which §3.6 requires anyway — state is never carried by color alone.
  T['st-queued'] = mix(ink, canvas, pct.queued)
  T['st-cancelled'] = mix(ink, canvas, pct.cancelled)
  for (const [k, v] of Object.entries(t.status)) T[`st-${k}`] = v
  T['st-steered'] = T['st-blocked'] as Oklch // §3: "violet (annotation, never a state)"
  for (const k of STATUS_ORDER) T[`st-${k}-tint`] = mix(T[`st-${k}`] as Oklch, canvas, pct.tint)
  for (const [k, v] of Object.entries(t.adapters)) T[`ad-${k}`] = v
  // D6: §3.2 says ink 40% for mock/unknown; as 9px text on its own tint that is 2.6:1.
  T['ad-mock'] = T['text-3'] as Oklch
  T['ad-unknown'] = T['text-3'] as Oklch
  for (const k of ADAPTER_ORDER) T[`ad-${k}-tint`] = mix(T[`ad-${k}`] as Oklch, canvas, pct.adTint)
  return T
}

export const LIGHT = resolve('light')
export const DARK = resolve('dark')
export const TOK: Record<ThemeName, Record<string, Oklch>> = { light: LIGHT, dark: DARK }

// ---------------------------------------------------------------------------
// CSS emission. Derived tokens emit as live color-mix() so the anchor technique stays
// real in the product: change --canvas at runtime and every surface follows.
// ---------------------------------------------------------------------------
function themeBlock(name: ThemeName): string {
  const t = THEMES[name]
  const { pct } = t
  const M = (a: string, p: number, b = '--canvas') =>
    `color-mix(in oklab, var(${a}) ${p}%, var(${b}))`
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
  ]
  for (const [k, v] of Object.entries(t.status)) lines.push(`  --st-${k}: ${css(v)};`)
  lines.push('  --st-steered: var(--st-blocked);', '')
  for (const k of STATUS_ORDER) {
    lines.push(`  --st-${k}-tint: color-mix(in oklab, var(--st-${k}) var(--tint), var(--canvas));`)
  }
  lines.push('')
  for (const [k, v] of Object.entries(t.adapters)) lines.push(`  --ad-${k}: ${css(v)};`)
  lines.push('  --ad-mock: var(--text-3);', '  --ad-unknown: var(--text-3);')
  for (const k of ADAPTER_ORDER) {
    lines.push(`  --ad-${k}-tint: color-mix(in oklab, var(--ad-${k}) var(--ad-tint), var(--canvas));`)
  }
  lines.push('', `  --shadow-raised: ${t.shadow};`)
  lines.push(`  color-scheme: ${name};`)
  return `[data-theme="${name}"] {\n${lines.join('\n')}\n}`
}

/** The full `:root` token block — emitted to `tokens.css` by `npm run tokens`. */
export function tokenCss(): string {
  const ansi = Object.entries(WELL.ansi)
    .map(([i, v]) => `  --ansi-${i}: ${css(v)};`)
    .join('\n')
  return [
    themeBlock('light'),
    themeBlock('dark'),
    // Terminal well: fixed in both themes (DESIGN §3.2, decision final).
    `:root {\n  --well: ${css(WELL.bg)};\n  --well-text: ${css(WELL.text)};\n${ansi}\n}`,
  ].join('\n\n')
}

// ---------------------------------------------------------------------------
// The §3.6 contrast gate — NORMATIVE per the W8a sign-off ruling 3. Every pair the spec
// states, computed in both themes against the GAMUT-CLIPPED sRGB a browser actually
// paints, so an out-of-gamut token cannot pass on paper and fail on screen.
//
//   role 'text'  -> 4.5:1 (WCAG 2.2 AA, 1.4.3)
//   role 'ui'    -> 3:1   (1.4.11 non-text contrast)
//   role 'decor' -> exempt, and the exemption must carry a stated reason
// ---------------------------------------------------------------------------
export interface Pair {
  label: string
  role: 'text' | 'ui' | 'decor'
  note?: string
  light: number
  dark: number
  need: number
  pass: boolean
}

function pairs(): Omit<Pair, 'need' | 'pass'>[] {
  const out: Omit<Pair, 'need' | 'pass'>[] = []
  const add = (
    label: string, role: Pair['role'], fg: string | Oklch, bg: string | Oklch, note?: string,
  ) => {
    const pick = (theme: Record<string, Oklch>, v: string | Oklch) =>
      typeof v === 'string' ? (theme[v] as Oklch) : v
    const entry: Omit<Pair, 'need' | 'pass'> = {
      label, role,
      light: contrast(pick(LIGHT, fg), pick(LIGHT, bg)),
      dark: contrast(pick(DARK, fg), pick(DARK, bg)),
    }
    if (note) entry.note = note
    out.push(entry)
  }
  add('--text on --canvas', 'text', 'text', 'canvas')
  add('--text on --surface', 'text', 'text', 'surface')
  add('--text on --surface-raised', 'text', 'text', 'surface-raised')
  add('--text on --surface-selected', 'text', 'text', 'surface-selected')
  add('--text-2 on --surface', 'text', 'text-2', 'surface')
  add('--text-2 on --surface-raised', 'text', 'text-2', 'surface-raised')
  add('--text-3 on --canvas', 'text', 'text-3', 'canvas')
  add('--text-3 on --surface-raised', 'text', 'text-3', 'surface-raised')
  add('--accent link on --canvas', 'text', 'accent', 'canvas')
  add('--accent link on --surface-raised', 'text', 'accent', 'surface-raised')
  add('--on-accent on --accent (primary button)', 'text', 'on-accent', 'accent')
  add('--accent focus ring on --canvas', 'ui', 'accent', 'canvas')
  add('--accent focus ring on --surface-raised', 'ui', 'accent', 'surface-raised')
  add('--border (input edge) on --surface', 'ui', 'border', 'surface')
  add('--border (input edge) on --canvas', 'ui', 'border', 'canvas')
  for (const k of STATUS_ORDER) add(`--st-${k} label on --surface`, 'text', `st-${k}`, 'surface')
  for (const k of STATUS_ORDER) add(`--st-${k} label on --st-${k}-tint (chip)`, 'text', `st-${k}`, `st-${k}-tint`)
  for (const k of STATUS_ORDER) add(`--st-${k} glyph stroke on --canvas`, 'ui', `st-${k}`, 'canvas')
  for (const k of ADAPTER_ORDER) add(`adapter ${k} monogram on --ad-${k}-tint`, 'text', `ad-${k}`, `ad-${k}-tint`)
  add('budget gauge fill (--accent) on track (--hairline)', 'ui', 'accent', 'hairline')
  add('gauge overshoot hatch (--st-failed) on track', 'ui', 'st-failed', 'hairline')
  add('gantt queue-wait hatch (--text-3) on lane (--surface)', 'ui', 'text-3', 'surface')
  add('saturation strip fill (--accent) on --surface', 'ui', 'accent', 'surface')
  // §2.1 Q4's per-agent token bar (round 5, B3). The bar shipped as --accent at
  // `opacity: 0.55` over the same --hairline track, which paints ~2.14:1 light / 2.83:1
  // dark — a §3.6 failure the gate could not see, because a gate over TOKENS is blind to a
  // stylesheet that composites one. The fill is a whole token again, and this pair is why
  // it has to stay one; `contrast.test.ts` reads `cockpit.css` and fails on any `opacity`
  // in the fill rule, so the painted colour and the checked colour cannot part company.
  add('agents token-bar fill (--accent) on track (--hairline)', 'ui', 'accent', 'hairline')
  add('well default text on --well', 'text', WELL.text, WELL.bg)
  for (let i = 0; i < 16; i++) {
    add(`ANSI ${i} ${WELL.names[i]} on --well`, i === 0 ? 'decor' : 'text',
      WELL.ansi[i] as Oklch, WELL.bg,
      i === 0
        ? 'ANSI 0 is conventionally a background/rule color, never body text; §9.8 forces a legible foreground whenever SGR 48 applies it as a background.'
        : undefined)
  }
  return out
}

export const PAIRS: Pair[] = pairs().map((p) => {
  const need = p.role === 'text' ? 4.5 : p.role === 'ui' ? 3 : 0
  return { ...p, need, pass: p.light >= need && p.dark >= need }
})

/** Non-exempt pairs that miss their threshold. Must always be empty (ruling 3). */
export const FAILING: Pair[] = PAIRS.filter((p) => p.role !== 'decor' && !p.pass)
