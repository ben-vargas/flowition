// DESIGN §3.5: one hand-authored SVG sprite, 1.5px stroke on a 16px grid, no icon
// library. Ported from docs/frontend/comps/lib/sprite.mjs.
//
// §3.5 estimates "~24" glyphs; the real count is 43, and the operator ruled at the W8a
// gate that ALL 43 stay (deviation D9). The extra 19 are load-bearing:
//   • 11 status marks, not 9 — the nine §3.2 states plus `unknown` (parity #56 needs a
//     neutral info circle that is NOT a success check) and `orphaned` (§6.4 step 8 /
//     parity #58 needs a distinct mark for an agent stranded in a dead run).
//   • 4 file-action glyphs — created/edited/deleted/renamed, required by §2.5.1 #79.
//   • `chevdown` as its own symbol — a rotated `chevron` would inherit the disclosure
//     transition and animate when it must not.
//   • terminal, tool, reasoning, clock, drag, bolt — transcript card headers, the wait
//     column, resize handles, the budget badge.
//
// DEVIATION from §9.2, which lists `public/icons.svg`: the sprite is rendered INTO the
// document by <IconSprite/> rather than fetched as an external file.
// `<use href="/icons.svg#id">` is an external resource load, and the §7.1.4 CSP is
// `default-src 'none'` with no directive that admits it — Chrome and Firefox block
// external <use> under that policy. Same-document `<use href="#i-name">` needs no
// directive at all. One source of truth, one fewer request, and it cannot be broken by a
// later CSP tightening.

/**
 * A glyph is a list of SVG child elements. Keeping this as data rather than JSX is what
 * lets `icons.test.ts` assert the 43-glyph inventory and id uniqueness without rendering.
 */
export type GlyphPart =
  | { t: 'path'; d: string; opacity?: number }
  | { t: 'circle'; cx: number; cy: number; r: number; dash?: string; opacity?: number }
  | { t: 'rect'; x: number; y: number; w: number; h: number; rx: number }

const p = (d: string, opacity?: number): GlyphPart =>
  opacity === undefined ? { t: 'path', d } : { t: 'path', d, opacity }
const circ = (
  cx: number, cy: number, r: number, extra?: { dash?: string; opacity?: number },
): GlyphPart => ({ t: 'circle', cx, cy, r, ...extra })
const rect = (x: number, y: number, w: number, h: number, rx: number): GlyphPart =>
  ({ t: 'rect', x, y, w, h, rx })

export const GLYPH_PATHS = {
  // ---- §3.2 status vocabulary ------------------------------------------------
  queued: [circ(8, 8, 6, { dash: '2.2 2.3' })],
  running: [circ(8, 8, 6, { opacity: 0.28 }), p('M14 8a6 6 0 0 0-6-6')],
  done: [circ(8, 8, 6), p('m5.2 8.3 2 2 3.6-4.3')],
  cached: [p('M13.9 8.4A5.9 5.9 0 1 1 12 3.6'), p('M14 2.3v3.4h-3.4')],
  failed: [circ(8, 8, 6), p('m5.9 5.9 4.2 4.2m0-4.2-4.2 4.2')],
  cancelled: [circ(8, 8, 6), p('M4.2 11.8 11.8 4.2')],
  stale: [
    p('M8.9 2.6l5.5 9.6a1 1 0 0 1-.9 1.5H2.5a1 1 0 0 1-.9-1.5l5.5-9.6a1 1 0 0 1 1.8 0Z'),
    p('M8 6.4v3'), p('M8 11.5h.01'),
  ],
  blocked: [circ(8, 8, 6), p('M6.2 6.2A1.8 1.8 0 1 1 8 8.4v.9'), p('M8 11.4h.01')],
  steered: [p('M1.6 4h9v6.6h-9z'), p('m1.6 4.4 4.5 3.2L10.6 4.4'), p('m10.7 11.8 1.5 1.5 2.4-3.2')],
  unknown: [circ(8, 8, 6), p('M8 7.2v3.6'), p('M8 4.9h.01')],
  orphaned: [circ(8, 8, 6, { dash: '1.4 2.2' }), p('M8 5.2v3.4'), p('M8 10.9h.01')],

  // ---- §3.5 utility set ------------------------------------------------------
  chevron: [p('m5.6 3.4 5 4.6-5 4.6')],
  chevdown: [p('m3.4 5.6 4.6 5 4.6-5')],
  copy: [
    rect(5.6, 5.6, 7.4, 7.4, 1),
    p('M10.4 5.6V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v5.4a1 1 0 0 0 1 1h1.6'),
  ],
  check: [p('m3 8.6 3.4 3.4L13 4.6')],
  close: [p('M4 4l8 8M12 4l-8 8')],
  search: [circ(7, 7, 4.3), p('m10.2 10.2 3.5 3.5')],
  send: [p('M2.6 8h10.8'), p('m9.2 3.8 4.2 4.2-4.2 4.2')],
  cancel: [circ(8, 8, 6), p('M5.6 8h4.8')],
  resume: [circ(8, 8, 6), p('m6.5 5.3 4.2 2.7-4.2 2.7z')],
  trash: [
    p('M3.2 5.2h9.6'),
    p('M6.2 5.2V3.8a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v1.4'),
    p('m4.6 5.2.6 7.6a1 1 0 0 0 1 .9h3.6a1 1 0 0 0 1-.9l.6-7.6'),
  ],
  external: [
    p('M9.6 3h3.4v3.4'), p('m13 3-5.2 5.2'),
    p('M11.4 9.6v2.6a1 1 0 0 1-1 1H3.8a1 1 0 0 1-1-1V5.6a1 1 0 0 1 1-1h2.6'),
  ],
  mail: [rect(1.8, 4, 12.4, 8, 1), p('m1.9 4.6 6.1 4.2 6.1-4.2')],
  filter: [p('M2.4 4.2h11.2'), p('M4.6 8h6.8'), p('M6.8 11.8h2.4')],
  columns: [rect(2.6, 3.2, 10.8, 9.6, 1), p('M6.2 3.2v9.6M9.8 3.2v9.6')],
  gantt: [p('M2.4 4.6h5.6M4.8 8h7.2M2.4 11.4h4.4')],
  tree: [
    p('M2.8 3.2v8.4a1 1 0 0 0 1 1h1.8'), p('M2.8 7.6h2.8'),
    rect(6.4, 2.2, 7, 2.6, 0.6), rect(6.4, 6.3, 7, 2.6, 0.6), rect(6.4, 10.4, 7, 2.6, 0.6),
  ],
  table: [rect(2.6, 3.4, 10.8, 9.2, 1), p('M2.6 6.5h10.8M2.6 9.6h10.8M6.4 3.4v9.2')],
  keyboard: [
    rect(1.6, 4.4, 12.8, 7.2, 1.2),
    p('M4.2 7h.01M6.4 7h.01M8.6 7h.01M10.8 7h.01M4.6 9.3h6.8'),
  ],
  sun: [
    circ(8, 8, 3.1),
    p('M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2'),
  ],
  moon: [p('M13.2 9.9A5.7 5.7 0 0 1 6.1 2.8a5.9 5.9 0 1 0 7.1 7.1Z')],
  clock: [circ(8, 8, 6), p('M8 4.6V8l2.4 1.5')],
  terminal: [rect(1.8, 2.8, 12.4, 10.4, 1), p('m4.6 6.4 2 1.8-2 1.8M8.6 10.4h3')],
  tool: [p('M6 3.4 2.8 8 6 12.6M10 3.4 13.2 8 10 12.6')],
  reasoning: [circ(4.6, 8, 1.1), circ(8, 8, 1.1), circ(11.4, 8, 1.1)],
  filenew: [
    p('M4 2.4h4.4L11.8 5.8v7.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1Z'),
    p('M8.2 2.6v3.4h3.4'), p('M6.6 10.2h3.2M8.2 8.6v3.2'),
  ],
  fileedit: [
    p('M11.4 8.6v4.4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1h4'),
    p('m9.2 7.4 4-4 1.3 1.3-4 4-1.9.6z'),
  ],
  filedel: [
    p('M4 2.4h4.4l3.4 3.4v7.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1Z'),
    p('M8.2 2.6v3.4h3.4'), p('m6.6 9 3.2 3.2m0-3.2L6.6 12.2'),
  ],
  filemove: [
    p('M4 2.4h4.4l3.4 3.4v7.2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.4a1 1 0 0 1 1-1Z'),
    p('M8.2 2.6v3.4h3.4'), p('M6 10.6h4M8.4 9.2l1.4 1.4-1.4 1.4'),
  ],
  plus: [p('M8 3.6v8.8M3.6 8h8.8')],
  minus: [p('M3.6 8h8.8')],
  drag: [p('M6.4 3.4v9.2M9.6 3.4v9.2')],
  bolt: [p('M8.8 1.8 3.6 9.2h3.6l-.8 5 5.2-7.4H8l.8-5Z')],
} satisfies Record<string, GlyphPart[]>

export type GlyphName = keyof typeof GLYPH_PATHS
export const GLYPH_NAMES = Object.keys(GLYPH_PATHS) as GlyphName[]

/**
 * §3.2's nine states plus the two the recon judgments force. The tuple is
 * `[css class, sprite glyph, screen-reader text]`.
 *
 * One table serves `AgentState`, `RunState` (§6.2) and the two annotations, so the run
 * table, the rail and the agent views cannot drift apart. An UNKNOWN state maps to the
 * neutral info circle and NEVER to a success check (parity #56) — pinned by a test.
 */
export const STATE_LOOK: Record<string, readonly [string, GlyphName, string]> = {
  // AgentState
  queued: ['q', 'queued', 'queued'],
  running: ['r', 'running', 'running'],
  done: ['d', 'done', 'done'],
  cached: ['c', 'cached', 'cached'],
  failed: ['f', 'failed', 'failed'],
  cancelled: ['x', 'cancelled', 'cancelled'],
  // annotations that render as marks (§3.2: steered is never a state)
  blocked: ['b', 'blocked', 'blocked'],
  steered: ['st', 'steered', 'steered'],
  orphaned: ['u', 'orphaned', 'orphaned'],
  // RunState
  starting: ['q', 'queued', 'starting'],
  completed: ['d', 'done', 'completed'],
  interrupted: ['x', 'cancelled', 'interrupted'],
  stale: ['s', 'stale', 'stale'],
  'corrupt-result': ['u', 'unknown', 'corrupt result'],
  unknown: ['u', 'unknown', 'unknown'],
}

/** Unknown / future states degrade to the neutral info circle (§6.5, parity #56). */
export const lookUpState = (state: string): readonly [string, GlyphName, string] =>
  STATE_LOOK[state] ?? (['u', 'unknown', state || 'unknown'] as const)

/** The `running` mark spins; nothing else does (§3.4). */
export const spins = (state: string): boolean => state === 'running'
