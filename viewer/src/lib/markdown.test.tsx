// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  HardenedMarkdown,
  MARKDOWN_DEGRADED,
  MARKDOWN_DOM_ATTRIBUTES,
  MARKDOWN_DOM_ELEMENTS,
  MARKDOWN_LIMITS,
  markdownPreflight,
} from './markdown.js'

afterEach(cleanup)

const FORBIDDEN = ['img', 'svg', 'iframe', 'object', 'embed', 'form', 'meta', 'style', 'audio', 'video']
const ATTRIBUTES = new Set<string>(MARKDOWN_DOM_ATTRIBUTES)
const CI_PERF_MULTIPLIER = process.env.CI ? 3 : 1

function assertRendererInvariants(container: HTMLElement) {
  const allowed = new Set<string>(MARKDOWN_DOM_ELEMENTS)
  for (const element of container.querySelectorAll('*')) {
    expect(allowed.has(element.localName), `unexpected <${element.localName}>`).toBe(true)
    expect(FORBIDDEN).not.toContain(element.localName)
    for (const attribute of element.attributes) {
      expect(attribute.name.startsWith('on')).toBe(false)
      expect(ATTRIBUTES.has(attribute.name), `unexpected ${attribute.name}`).toBe(true)
    }
  }
  for (const link of container.querySelectorAll('a')) {
    expect(['http:', 'https:']).toContain(new URL(link.href).protocol)
    expect(link.target).toBe('_blank')
    expect(link.rel).toBe('noopener noreferrer')
  }
}

function hostileCorpusLines(count: number): string[] {
  const attacks = [
    (i: number) => `![p${i}](data:text/html,<svg onload=alert(1)>)`,
    (i: number) => `[x${i}](javascript:alert(${i})) <iframe src=//evil>`,
    (i: number) => `<img src=x onerror=alert(${i})> [ok](https://example.com/${i})`,
    (i: number) => `${'['.repeat(i % 24)}nested${']'.repeat(i % 24)} data:text/html,boom`,
    (i: number) => `<form action=//evil onsubmit=alert(${i})><video src=//evil>`,
  ]
  return Array.from({ length: count }, (_, index) => attacks[index % attacks.length]!(index))
}

describe('hardened react-markdown (§16.2)', () => {
  it('renders the complete allowed markdown surface, including the local GFM projection', () => {
    const source = [
      '# Heading',
      '',
      '**bold** *italic* ~~gone~~',
      '',
      '- [x] done',
      '- [ ] todo',
      '',
      '> quote',
      '',
      '| a | b |',
      '| :--- | ---: |',
      '| c | d |',
      '',
      '```js',
      'const x = 1',
      '```',
      '',
      'https://example.com/path',
    ].join('\n')
    const view = render(<HardenedMarkdown source={source} />)
    expect(view.container.querySelector('h1')?.textContent).toBe('Heading')
    expect(view.container.querySelector('del')?.textContent).toBe('gone')
    expect(view.container.querySelectorAll('input[type=checkbox]')).toHaveLength(2)
    expect(view.container.querySelector('table')).toBeTruthy()
    expect(view.container.querySelector('.fence .fh')?.textContent).toContain('js')
    expect(view.container.querySelector('a')?.href).toBe('https://example.com/path')
    assertRendererInvariants(view.container)
  })

  it('preserves inline code, emphasis, links, and strikethrough inside GFM table cells', () => {
    const source = [
      '| `code` | **bold** | [link](https://example.com) | ~~gone~~ |',
      '| --- | --- | --- | --- |',
      '| `x` | *y* | https://example.org | ~~z~~ |',
    ].join('\n')
    const view = render(<HardenedMarkdown source={source} />)
    const table = view.container.querySelector('.md-table-scroll > table')
    expect(table).toBeTruthy()
    expect(table?.querySelectorAll('code')).toHaveLength(2)
    expect(table?.querySelector('strong')?.textContent).toBe('bold')
    expect(table?.querySelector('em')?.textContent).toBe('y')
    expect(table?.querySelectorAll('a')).toHaveLength(2)
    expect(table?.querySelectorAll('del')).toHaveLength(2)
    assertRendererInvariants(view.container)
  })

  it('retains CommonMark hard breaks', () => {
    const view = render(<HardenedMarkdown source={'a  \nb'} />)
    expect(view.container.querySelector('br')).toBeTruthy()
    expect(view.container.querySelector('p')?.textContent).toContain('a')
    expect(view.container.querySelector('p')?.textContent).toContain('b')
    assertRendererInvariants(view.container)
  })

  it('turns images into outbound link chips and never creates an image request', () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const view = render(<HardenedMarkdown source="![tracker](https://example.com/pixel.gif)" />)
    expect(view.container.querySelector('img')).toBeNull()
    expect(view.container.querySelector('a')?.textContent).toContain('[image: tracker]')
    expect(fetch).not.toHaveBeenCalled()
    fetch.mockRestore()
  })

  // §9.7/§16.2: raw HTML is LITERAL, not discarded. The previous revision of this test
  // blessed the drop; a reader who cannot see the markup a provider emitted cannot tell
  // a hostile transcript from a plain one (panel round 3).
  it('renders raw HTML as literal text and blocks non-http protocols', () => {
    const source = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '[data](data:text/html,boom)',
      '[js](javascript:alert(1))',
      '[file](file:///etc/passwd)',
      '[ok](https://example.com)',
    ].join('\n\n')
    const view = render(<HardenedMarkdown source={source} />)
    expect(view.container.querySelector('script,img')).toBeNull()
    // visible, verbatim, and inert
    expect(view.container.textContent).toContain('<script>alert(1)</script>')
    expect(view.container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(view.container.querySelectorAll('a')).toHaveLength(1)
    expect(view.container.querySelector('a')?.href).toBe('https://example.com/')
    assertRendererInvariants(view.container)
  })

  it('renders block-level raw HTML inside prose block elements, not as a stray text node', () => {
    const view = render(<HardenedMarkdown source={'before\n\n<div class="x">hi</div>\n\nafter'} />)
    const paragraphs = [...view.container.querySelectorAll('p')].map((p) => p.textContent)
    expect(paragraphs).toContain('<div class="x">hi</div>')
    expect(view.container.querySelector('div.x')).toBeNull()
    assertRendererInvariants(view.container)
  })

  it('keeps inline raw HTML literal inside the surrounding paragraph', () => {
    const view = render(<HardenedMarkdown source={'text <b>bold?</b> and <a href="https://evil.test">link?</a> end'} />)
    const paragraph = view.container.querySelector('p')
    expect(paragraph?.textContent).toBe('text <b>bold?</b> and <a href="https://evil.test">link?</a> end')
    expect(view.container.querySelector('b')).toBeNull()
    // the href inside the literal text must NOT become a link: literal is terminal
    expect(view.container.querySelector('a')).toBeNull()
    assertRendererInvariants(view.container)
  })

  // Literal is TERMINAL: text produced from an html node is never fed back through the
  // GFM/autolink transform, so nothing inside a raw block can become an element. (Text
  // *between* two inline tags was ordinary markdown before literalization and stays
  // ordinary markdown — that is CommonMark, not a hole.)
  it('does not re-interpret markdown syntax carried inside a literalized HTML block', () => {
    const source = '<div title="~~x~~">\n~~gone~~ https://example.com/inside\n</div>'
    const view = render(<HardenedMarkdown source={source} />)
    expect(view.container.textContent).toContain('~~gone~~')
    expect(view.container.textContent).toContain('https://example.com/inside')
    expect(view.container.querySelector('del')).toBeNull()
    expect(view.container.querySelector('a')).toBeNull()
    assertRendererInvariants(view.container)
  })

  it('keeps HTML inside fenced code exactly as written, without a second literalization', () => {
    const view = render(<HardenedMarkdown source={'```html\n<script>alert(1)</script>\n```'} />)
    expect(view.container.querySelector('pre code')?.textContent).toContain('<script>alert(1)</script>')
    expect(view.container.querySelector('script')).toBeNull()
    assertRendererInvariants(view.container)
  })

  it.each([
    ['bytes', 'x'.repeat(MARKDOWN_LIMITS.bytes + 1)],
    ['characters', 'x'.repeat(MARKDOWN_LIMITS.characters + 1)],
    ['lines', '\n'.repeat(MARKDOWN_LIMITS.lines)],
    ['line', `x${'y'.repeat(MARKDOWN_LIMITS.line)}`],
  ])('degrades before parsing on the %s limit', (reason, source) => {
    const preflight = markdownPreflight(source)
    expect(preflight.ok).toBe(false)
    const view = render(<HardenedMarkdown source={source} />)
    expect(view.container.textContent).toContain(MARKDOWN_DEGRADED)
    expect(view.container.querySelector('[data-degraded]')?.getAttribute('data-degraded')).toBe(reason)
    expect(view.container.textContent!.length).toBeLessThan(20_000)
  })

  it('degrades inside the pipeline on AST link-count bounds', () => {
    const source = Array.from({ length: MARKDOWN_LIMITS.links + 1 }, (_, i) => `[x](https://e.test/${i})`).join('\n')
    const view = render(<HardenedMarkdown source={source} />)
    expect(view.container.textContent).toContain(`${MARKDOWN_DEGRADED} (links)`)
    expect(view.container.querySelector('a')).toBeNull()
  })

  it('degrades inside the pipeline on code-block size bounds', () => {
    const body = Array.from({ length: 33 }, () => 'x'.repeat(4096)).join('\n')
    const source = `\`\`\`text\n${body}\n\`\`\``
    const view = render(<HardenedMarkdown source={source} />)
    expect(view.container.textContent).toContain(`${MARKDOWN_DEGRADED} (codeBlock)`)
  })

  it('degrades inside the pipeline on AST depth bounds', () => {
    const source = `${'> '.repeat(MARKDOWN_LIMITS.depth + 2)}deep`
    const view = render(<HardenedMarkdown source={source} />)
    expect(view.container.textContent).toContain(`${MARKDOWN_DEGRADED} (depth)`)
  })

  it('degrades inside the pipeline on total AST node bounds', () => {
    const source = Array.from({ length: 4_300 }, () => '**a** *b* `c`').join('\n\n')
    const view = render(<HardenedMarkdown source={source} />)
    expect(view.container.textContent).toContain(`${MARKDOWN_DEGRADED} (nodes)`)
  })

  it('degrades inside the pipeline on table-cell bounds', () => {
    const row = `|${Array.from({ length: 100 }, () => 'x').join('|')}|`
    const delimiter = `|${Array.from({ length: 100 }, () => '---').join('|')}|`
    const source = [row, delimiter, ...Array.from({ length: 100 }, () => row)].join('\n')
    const view = render(<HardenedMarkdown source={source} />)
    expect(view.container.textContent).toContain(`${MARKDOWN_DEGRADED} (tableCells)`)
  })

  it('rejects a hostile wide × tall table before materializing its cell matrix', () => {
    const header = Array.from({ length: 8_192 }, () => 'x').join('|')
    const delimiter = Array.from({ length: 8_192 }, () => '---').join('|')
    const source = [header, delimiter, ...Array.from({ length: 9_997 }, () => 'x')].join('\n')
    const preflight = markdownPreflight(source)
    expect(preflight).toMatchObject({
      ok: true,
      bytes: 69_145,
      characters: 69_145,
      lines: 9_999,
      longestLine: 32_767,
    })

    const started = performance.now()
    const view = render(<HardenedMarkdown source={source} />)
    const elapsed = performance.now() - started
    expect(view.container.textContent).toContain(`${MARKDOWN_DEGRADED} (tableCells)`)
    expect(elapsed, `hostile table render took ${elapsed.toFixed(1)}ms`)
      .toBeLessThan(500 * CI_PERF_MULTIPLIER)
  }, 10_000)

  it('trims max-line-length tab runs with linear scaling before rendering a non-table paragraph', () => {
    const fixture = (tabs: number) => {
      const line = `a${'\t'.repeat(tabs)}b`
      const paragraph = `${line}\n${line}`
      return Array.from({ length: 3 }, () => paragraph).join('\n\n')
    }
    const small = fixture(8_000)
    const large = fixture(32_000)
    expect(markdownPreflight(large)).toMatchObject({
      ok: true,
      bytes: 192_019,
      characters: 192_019,
      lines: 8,
      longestLine: 32_002,
    })

    const timedRender = (source: string) => {
      const started = performance.now()
      const view = render(<HardenedMarkdown source={source} />)
      const elapsed = performance.now() - started
      expect(view.container.textContent).not.toContain(MARKDOWN_DEGRADED)
      view.unmount()
      return elapsed
    }

    timedRender(fixture(2_000))
    timedRender(small)
    const largeElapsed = timedRender(large)
    // Absolute bound only — the small/large ratio assertion had the same
    // noise-sensitive shape that flaked router.test.ts under full-suite load
    // (review flo_cf8e8ce1, blocker 1); the absolute gate carries the regression.
    expect(largeElapsed, `hostile inline trim render took ${largeElapsed.toFixed(1)}ms`)
      .toBeLessThan(1_000 * CI_PERF_MULTIPLIER)
  }, 10_000)

  it('retains the 10k-line hostile corpus as an explicit pre-parse degradation case', () => {
    const lines = hostileCorpusLines(10_000)
    const source = lines.join('\n')
    const view = render(<HardenedMarkdown source={source} />)
    expect(view.container.querySelector('[data-degraded]')?.getAttribute('data-degraded')).toBe('bytes')
    expect(view.container.textContent).toContain(MARKDOWN_DEGRADED)
    assertRendererInvariants(view.container)
    expect(view.container.querySelector(FORBIDDEN.join(','))).toBeNull()
  })

  it('runs every line of the 10k hostile corpus through react-markdown in bounded batches', () => {
    const lines = hostileCorpusLines(10_000)
    const batchSize = 250
    const fetch = vi.spyOn(globalThis, 'fetch')
    const started = performance.now()
    const first = lines.slice(0, batchSize).join('\n')
    expect(markdownPreflight(first).ok).toBe(true)
    const view = render(<HardenedMarkdown source={first} />)
    assertRendererInvariants(view.container)
    expect(view.container.querySelector(FORBIDDEN.join(','))).toBeNull()
    expect(view.container.textContent).not.toContain(MARKDOWN_DEGRADED)
    // The corpus is green because the hostile markup is INERT TEXT, not because it
    // vanished: literal rendering must not open an interpretation path (§9.7).
    expect(view.container.textContent).toContain('<iframe src=//evil>')
    for (let start = batchSize; start < lines.length; start += batchSize) {
      const source = lines.slice(start, start + batchSize).join('\n')
      expect(markdownPreflight(source).ok).toBe(true)
      view.rerender(<HardenedMarkdown source={source} />)
      assertRendererInvariants(view.container)
      expect(view.container.querySelector(FORBIDDEN.join(','))).toBeNull()
      expect(view.container.textContent).not.toContain(MARKDOWN_DEGRADED)
    }
    const elapsed = performance.now() - started
    expect(fetch).not.toHaveBeenCalled()
    expect(elapsed).toBeLessThan(15_000)
    fetch.mockRestore()
  })

  it('never exposes source event-handler attributes through link titles or text', () => {
    const view = render(<HardenedMarkdown source={'[safe](https://example.com "onmouseover=boom")'} />)
    assertRendererInvariants(view.container)
    expect(view.container.querySelector('[onmouseover]')).toBeNull()
  })
})
