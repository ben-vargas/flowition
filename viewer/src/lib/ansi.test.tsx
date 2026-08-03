// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  Ansi,
  ansiCss,
  initialAnsiState,
  parseAnsiChunk,
  updateAnsi,
} from './ansi.js'

afterEach(cleanup)

describe('ANSI SGR character scanner (§16.4)', () => {
  it('emits structured spans and never HTML strings', () => {
    const view = render(<Ansi text={'plain \u001b[31mred\u001b[0m end'} />)
    expect(view.container.querySelectorAll('span span')).toHaveLength(3)
    expect(view.container.textContent).toBe('plain red end')
    expect(view.container.textContent).not.toContain('\u001b')
  })

  it('carries SGR state across appended chunks and parses only the suffix', () => {
    const first = updateAnsi(null, '\u001b[32mgreen')
    const second = updateAnsi(first, '\u001b[32mgreen still\u001b[0m done')
    expect(second.runs.map((run) => run.text).join('')).toBe('green still done')
    expect(second.runs[0]!.style.foreground).toBe('var(--ansi-2)')
    expect(second.runs.at(-1)!.style.foreground).toBeNull()
  })

  it('rebuilds after a non-append change', () => {
    const first = updateAnsi(null, '\u001b[31mred')
    const second = updateAnsi(first, 'replacement')
    expect(second.runs).toHaveLength(1)
    expect(second.runs[0]!.text).toBe('replacement')
    expect(second.runs[0]!.style.foreground).toBeNull()
  })

  it('strips unknown CSI, cursor, OSC, multi-byte escapes, string controls, C0, DEL, and C1 controls', () => {
    const input = [
      'a', '\u001b[2J', 'b', '\u001b[999z', 'c',
      '\u001b]8;;https://evil.example\u0007', 'd', '\u001b]8;;\u001b\\',
      '\u001bc', 'e',
      '\u001b(B', 'f', '\u001b)0', 'g', '\u001b#8', 'h',
      '\u001bPtmux;payload\u0007', 'i', '\u001bPkitty;payload\u001b\\', 'j',
      '\u0001', 'k', '\u007f', 'l', '\u009b', 'm',
    ].join('')
    const parsed = parseAnsiChunk(input)
    expect(parsed.runs.map((run) => run.text).join('')).toBe('abcdefghijklm')
  })

  it('discards OSC incrementally across chunks without retaining its payload', () => {
    const first = parseAnsiChunk('before\u001b]0;' + 'x'.repeat(100_000))
    expect(first.runs.map((run) => run.text).join('')).toBe('before')
    expect(first.state.mode).toBe('osc')
    expect(first.state.params).toHaveLength(0)
    const second = parseAnsiChunk('\u0007after', first.state)
    expect(second.runs.map((run) => run.text).join('')).toBe('after')
  })

  it('bounds malformed CSI carry and preserves printable text after its final byte', () => {
    const first = parseAnsiChunk('\u001b[' + '1;'.repeat(1000))
    expect(first.state.params.length).toBeLessThanOrEqual(64)
    expect(first.state.paramsOverflow).toBe(true)
    const second = parseAnsiChunk('mvisible', first.state)
    expect(second.runs.map((run) => run.text).join('')).toBe('visible')
    expect(second.state.style).toEqual(initialAnsiState().style)
  })

  it('supports 16-color, 256-color and truecolor foreground/background SGR', () => {
    const parsed = parseAnsiChunk(
      '\u001b[91ma\u001b[38;5;196mb\u001b[38;2;1;2;3mc'
      + '\u001b[48;5;231md\u001b[48;2;250;250;250me',
    )
    expect(parsed.runs[0]!.style.foreground).toBe('var(--ansi-9)')
    expect(parsed.runs[1]!.style.foreground).toContain('rgb(')
    expect(parsed.runs[2]!.style.foreground).toBe('rgb(1 2 3)')
    expect(parsed.runs[3]!.style.background).toBeTruthy()
    expect(parsed.runs[4]!.style.background).toBe('rgb(250 250 250)')
  })

  it('forces the higher-contrast well token whenever a background is active', () => {
    const light = parseAnsiChunk('\u001b[48;2;250;250;250mX').runs[0]!.style
    const dark = parseAnsiChunk('\u001b[48;2;2;2;2mX').runs[0]!.style
    expect(ansiCss(light).color).toBe('var(--well)')
    expect(ansiCss(dark).color).toBe('var(--well-text)')
  })

  it('stays linear on a hostile million-character control stream', () => {
    const input = ('x\u001b[9999999999999999999999999999999999999z').repeat(25_000)
    const started = performance.now()
    const result = parseAnsiChunk(input)
    const elapsed = performance.now() - started
    expect(result.runs.map((run) => run.text).join('').length).toBe(25_000)
    expect(elapsed).toBeLessThan(1_000)
  })
})
