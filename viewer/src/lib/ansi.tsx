/**
 * Incremental, regex-free ANSI SGR tokenizer (DESIGN §9.8 / §16.4).
 *
 * Untrusted terminal output is touched only by the character scanner below. CSI/OSC and
 * unknown controls are consumed and dropped; printable neighbors survive verbatim.
 */

import { memo, useRef } from 'react'
import type { CSSProperties } from 'react'

const ESC = 27
const BEL = 7
const MAX_PARAMS = 64

const PALETTE = [
  '#111318', '#df5a60', '#43b581', '#d6a84b', '#5b8def', '#b47bd8', '#45a9b0', '#d8dbe2',
  '#6f7582', '#ff7378', '#62cf9a', '#f0c75e', '#78a6ff', '#d39aef', '#67c8cf', '#ffffff',
] as const

export interface AnsiStyle {
  bold: boolean
  dim: boolean
  italic: boolean
  underline: boolean
  foreground: string | null
  background: string | null
  backgroundRgb: readonly [number, number, number] | null
}

export interface AnsiRun {
  text: string
  style: AnsiStyle
}

type Mode = 'text' | 'escape' | 'escape-intermediate' | 'csi' | 'osc' | 'osc-escape'

export interface AnsiState {
  style: AnsiStyle
  mode: Mode
  params: string
  paramsOverflow: boolean
}

export interface AnsiParseResult {
  runs: AnsiRun[]
  state: AnsiState
}

export function initialAnsiState(): AnsiState {
  return {
    style: {
      bold: false, dim: false, italic: false, underline: false,
      foreground: null, background: null, backgroundRgb: null,
    },
    mode: 'text',
    params: '',
    paramsOverflow: false,
  }
}

function cloneStyle(style: AnsiStyle): AnsiStyle {
  return { ...style, backgroundRgb: style.backgroundRgb ? [...style.backgroundRgb] as [number, number, number] : null }
}

function pushRun(runs: AnsiRun[], text: string, style: AnsiStyle) {
  if (!text) return
  const last = runs[runs.length - 1]
  if (last && sameStyle(last.style, style)) last.text += text
  else runs.push({ text, style: cloneStyle(style) })
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return a.bold === b.bold && a.dim === b.dim && a.italic === b.italic
    && a.underline === b.underline && a.foreground === b.foreground
    && a.background === b.background
}

function parseParams(value: string): number[] | null {
  if (!value) return [0]
  const out: number[] = []
  let number = 0
  let digits = 0
  for (let i = 0; i <= value.length; i++) {
    const code = i < value.length ? value.charCodeAt(i) : 59
    if (code >= 48 && code <= 57) {
      number = Math.min(1_000_000, number * 10 + code - 48)
      digits++
      continue
    }
    if (code !== 59) return null
    out.push(digits ? number : 0)
    number = 0
    digits = 0
  }
  return out
}

function paletteColor(index: number): { css: string; rgb: [number, number, number] } {
  const n = Math.max(0, Math.min(255, index))
  if (n < 16) return { css: `var(--ansi-${n})`, rgb: hexRgb(PALETTE[n]!) }
  if (n >= 232) {
    const v = 8 + (n - 232) * 10
    return { css: `rgb(${v} ${v} ${v})`, rgb: [v, v, v] }
  }
  const c = n - 16
  const levels = [0, 95, 135, 175, 215, 255]
  const r = levels[Math.floor(c / 36)]!
  const g = levels[Math.floor((c % 36) / 6)]!
  const b = levels[c % 6]!
  return { css: `rgb(${r} ${g} ${b})`, rgb: [r, g, b] }
}

function hexRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

function applyExtended(style: AnsiStyle, params: number[], at: number, background: boolean): number {
  const mode = params[at + 1]
  let color: { css: string; rgb: [number, number, number] } | null = null
  let consumed = 0
  if (mode === 5 && Number.isFinite(params[at + 2])) {
    color = paletteColor(params[at + 2]!)
    consumed = 2
  } else if (
    mode === 2
    && Number.isFinite(params[at + 2])
    && Number.isFinite(params[at + 3])
    && Number.isFinite(params[at + 4])
  ) {
    const rgb: [number, number, number] = [
      clampByte(params[at + 2]!), clampByte(params[at + 3]!), clampByte(params[at + 4]!),
    ]
    color = { css: `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`, rgb }
    consumed = 4
  }
  if (color) {
    if (background) {
      style.background = color.css
      style.backgroundRgb = color.rgb
    } else {
      style.foreground = color.css
    }
  }
  return consumed
}

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.floor(value)))

function applySgr(style: AnsiStyle, raw: string) {
  const params = parseParams(raw)
  if (!params) return
  for (let i = 0; i < params.length; i++) {
    const code = params[i]!
    if (code === 0) Object.assign(style, initialAnsiState().style)
    else if (code === 1) style.bold = true
    else if (code === 2) style.dim = true
    else if (code === 3) style.italic = true
    else if (code === 4) style.underline = true
    else if (code === 22) { style.bold = false; style.dim = false }
    else if (code === 23) style.italic = false
    else if (code === 24) style.underline = false
    else if (code >= 30 && code <= 37) style.foreground = `var(--ansi-${code - 30})`
    else if (code === 39) style.foreground = null
    else if (code >= 40 && code <= 47) {
      const color = paletteColor(code - 40)
      style.background = color.css
      style.backgroundRgb = color.rgb
    } else if (code === 49) { style.background = null; style.backgroundRgb = null }
    else if (code >= 90 && code <= 97) style.foreground = `var(--ansi-${code - 90 + 8})`
    else if (code >= 100 && code <= 107) {
      const color = paletteColor(code - 100 + 8)
      style.background = color.css
      style.backgroundRgb = color.rgb
    } else if (code === 38 || code === 48) {
      i += applyExtended(style, params, i, code === 48)
    }
  }
}

/**
 * Parse one suffix. State carries SGR and partial-control mode, never unbounded input.
 * OSC content is discarded as it arrives, so a missing terminator retains zero bytes.
 */
export function parseAnsiChunk(input: string, previous = initialAnsiState()): AnsiParseResult {
  const state: AnsiState = {
    style: cloneStyle(previous.style),
    mode: previous.mode,
    params: previous.params.slice(0, MAX_PARAMS),
    paramsOverflow: previous.paramsOverflow,
  }
  const runs: AnsiRun[] = []
  let printable = ''
  const flush = () => { pushRun(runs, printable, state.style); printable = '' }

  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (state.mode === 'text') {
      if (code === ESC) { flush(); state.mode = 'escape'; continue }
      // Preserve printable text plus the layout controls terminal wells support. DEL and
      // the C1 range are controls too, so unknown ones are stripped along with C0.
      if (
        code === 9 || code === 10 || code === 13
        || (code >= 32 && code !== 127 && (code < 128 || code > 159))
      ) printable += input[i]
      continue
    }
    if (state.mode === 'escape') {
      if (code === 91) {
        state.mode = 'csi'; state.params = ''; state.paramsOverflow = false
      } else if (code === 93) {
        state.mode = 'osc'
      } else if (code === 80 || code === 88 || code === 94 || code === 95) {
        // DCS, SOS, PM and APC are string controls. Discard payload bytes as they
        // arrive and accept BEL or ST as a terminator, just as for OSC.
        state.mode = 'osc'
      } else if (code >= 32 && code <= 47) {
        // ECMA-48 escape sequences may contain one or more intermediate bytes
        // before their final byte. Keep no payload; consume the entire sequence.
        state.mode = 'escape-intermediate'
      } else if (code === ESC) {
        state.mode = 'escape'
      } else {
        state.mode = 'text'
      }
      continue
    }
    if (state.mode === 'escape-intermediate') {
      if (code === ESC) state.mode = 'escape'
      else if (code >= 48 && code <= 126) state.mode = 'text'
      else if (code > 126) state.mode = 'text'
      continue
    }
    if (state.mode === 'osc') {
      if (code === BEL) state.mode = 'text'
      else if (code === ESC) state.mode = 'osc-escape'
      continue
    }
    if (state.mode === 'osc-escape') {
      if (code === 92) state.mode = 'text'
      else if (code !== ESC) state.mode = 'osc'
      continue
    }
    // CSI: final bytes are 0x40..0x7e. Only `m` is interpreted; every other CSI drops.
    if (code >= 64 && code <= 126) {
      if (code === 109 && !state.paramsOverflow) applySgr(state.style, state.params)
      state.mode = 'text'
      state.params = ''
      state.paramsOverflow = false
      continue
    }
    if (!state.paramsOverflow && state.params.length < MAX_PARAMS) state.params += input[i]
    else state.paramsOverflow = true
  }
  flush()
  return { runs, state }
}

function channel(value: number): number {
  const c = value / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(rgb: readonly [number, number, number]): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2])
}

function contrast(a: number, b: number): number {
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

/** Backgrounds force the higher-contrast of the well's fixed dark/light text tokens. */
export function ansiCss(style: AnsiStyle): CSSProperties {
  const css: CSSProperties = {}
  if (style.bold) css.fontWeight = 600
  if (style.dim) css.opacity = 0.72
  if (style.italic) css.fontStyle = 'italic'
  if (style.underline) css.textDecoration = 'underline'
  if (style.background) {
    css.backgroundColor = style.background
    const lum = style.backgroundRgb ? luminance(style.backgroundRgb) : 0
    const dark = luminance([17, 19, 24])
    const light = luminance([232, 235, 240])
    css.color = contrast(lum, light) >= contrast(lum, dark)
      ? 'var(--well-text)'
      : 'var(--well)'
  } else if (style.foreground) {
    css.color = style.foreground
  }
  return css
}

export interface IncrementalAnsi {
  input: string
  runs: AnsiRun[]
  state: AnsiState
}

export function updateAnsi(previous: IncrementalAnsi | null, input: string): IncrementalAnsi {
  if (!previous || !input.startsWith(previous.input)) {
    const parsed = parseAnsiChunk(input)
    return { input, runs: parsed.runs, state: parsed.state }
  }
  const parsed = parseAnsiChunk(input.slice(previous.input.length), previous.state)
  const runs = previous.runs.map((run) => ({ text: run.text, style: cloneStyle(run.style) }))
  for (const run of parsed.runs) pushRun(runs, run.text, run.style)
  return { input, runs, state: parsed.state }
}

export const Ansi = memo(function Ansi({ text, className }: { text: string; className?: string }) {
  const cache = useRef<IncrementalAnsi | null>(null)
  cache.current = updateAnsi(cache.current, text)
  return (
    <span className={className}>
      {cache.current.runs.map((run, index) => (
        <span key={index} style={ansiCss(run.style)}>{run.text}</span>
      ))}
    </span>
  )
})
