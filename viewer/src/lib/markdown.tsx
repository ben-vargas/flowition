/**
 * Hardened markdown rendering for hostile provider output (DESIGN §9.7 / §16.2).
 *
 * There are two independent gates:
 *  - byte/character/line limits run before react-markdown parses anything;
 *  - the remark transformer bounds the parsed tree before hast or React elements exist.
 *
 * The transformer also implements the small GFM surface the product promises (tables,
 * task items, strikethrough and bare http(s) autolinks). Keeping that code here avoids a
 * second direct runtime dependency: §16 says react-markdown is W10's ONLY new one.
 */

import {
  Children,
  cloneElement,
  isValidElement,
  memo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from 'react'
import ReactMarkdown, { type Components, type UrlTransform } from 'react-markdown'

import { ScrollFadePre } from '../ui/ScrollFade.js'

export const MARKDOWN_LIMITS = Object.freeze({
  bytes: 256 * 1024,
  characters: 200_000,
  lines: 10_000,
  line: 32_768,
  nodes: 25_000,
  depth: 64,
  links: 2_000,
  tableCells: 10_000,
  codeBlock: 128 * 1024,
  plaintext: 16_000,
})

export const MARKDOWN_DEGRADED = '[markdown degraded: safety limit exceeded]'

/** Actual tags our components may put in the DOM. The fuzz suite walks this list. */
export const MARKDOWN_DOM_ELEMENTS = Object.freeze([
  'a', 'blockquote', 'br', 'button', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'hr', 'input', 'li', 'ol', 'p', 'pre', 'span', 'strong', 'table',
  'tbody', 'td', 'th', 'thead', 'tr', 'ul',
] as const)

/** Attributes emitted by our narrowed components and mdast table alignment. */
export const MARKDOWN_DOM_ATTRIBUTES = Object.freeze([
  'checked', 'class', 'data-degraded', 'disabled', 'href', 'rel', 'style', 'target', 'type',
] as const)

/** Tags react-markdown itself may lower from mdast. Custom component children are separate. */
export const MARKDOWN_ALLOWED_ELEMENTS = Object.freeze([
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
  'input', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead',
  'tr', 'ul',
] as const)

type MdNode = {
  type?: string
  value?: string
  url?: string
  alt?: string
  checked?: boolean | null
  align?: (string | null)[]
  children?: MdNode[]
  data?: Record<string, unknown>
}

type LimitReason =
  | 'bytes' | 'characters' | 'lines' | 'line'
  | 'nodes' | 'depth' | 'links' | 'tableCells' | 'codeBlock'

export interface MarkdownPreflight {
  ok: boolean
  reason: LimitReason | null
  bytes: number
  characters: number
  lines: number
  longestLine: number
}

/** Single pass over the input. `TextEncoder` is the byte-domain authority. */
export function markdownPreflight(source: string): MarkdownPreflight {
  const characters = source.length
  const bytes = new TextEncoder().encode(source).byteLength
  let lines = 1
  let longestLine = 0
  let currentLine = 0
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      lines++
      if (currentLine > longestLine) longestLine = currentLine
      currentLine = 0
    } else {
      currentLine++
    }
  }
  if (currentLine > longestLine) longestLine = currentLine

  const reason: LimitReason | null =
    bytes > MARKDOWN_LIMITS.bytes ? 'bytes'
      : characters > MARKDOWN_LIMITS.characters ? 'characters'
        : lines > MARKDOWN_LIMITS.lines ? 'lines'
          : longestLine > MARKDOWN_LIMITS.line ? 'line'
            : null
  return { ok: reason == null, reason, bytes, characters, lines, longestLine }
}

function boundedPlaintext(source: string): string {
  return source.length <= MARKDOWN_LIMITS.plaintext
    ? source
    : `${source.slice(0, MARKDOWN_LIMITS.plaintext)}\n[plaintext truncated]`
}

function degradedTree(root: MdNode, source: string, reason: LimitReason) {
  root.children = [{
    type: 'paragraph',
    children: [{
      type: 'text',
      value: `${MARKDOWN_DEGRADED} (${reason})\n${boundedPlaintext(source)}`,
    }],
  }]
}

/**
 * Iterative bounds: hostile nesting never consumes the JS call stack. Run before and
 * after our GFM expansion so both the parser's tree and the produced tree are bounded.
 */
export function inspectMarkdownTree(root: MdNode): LimitReason | null {
  const stack: { node: MdNode; depth: number }[] = [{ node: root, depth: 0 }]
  let nodes = 0
  let links = 0
  let tableCells = 0

  while (stack.length) {
    const current = stack.pop()!
    nodes++
    if (nodes > MARKDOWN_LIMITS.nodes) return 'nodes'
    if (current.depth > MARKDOWN_LIMITS.depth) return 'depth'
    if (current.node.type === 'link' || current.node.type === 'image') {
      links++
      if (links > MARKDOWN_LIMITS.links) return 'links'
    }
    if (current.node.type === 'tableCell') {
      tableCells++
      if (tableCells > MARKDOWN_LIMITS.tableCells) return 'tableCells'
    }
    if (current.node.type === 'code') {
      const size = new TextEncoder().encode(current.node.value ?? '').byteLength
      if (size > MARKDOWN_LIMITS.codeBlock) return 'codeBlock'
    }
    const children = current.node.children
    if (!children) continue
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i]!, depth: current.depth + 1 })
    }
  }
  return null
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

/** Character-scanned bare URL boundary; deliberately no pattern backtracking. */
function bareUrlEnd(value: string, from: number): number {
  let i = from
  while (i < value.length) {
    const c = value.charCodeAt(i)
    if (c <= 32 || c === 60 || c === 62 || c === 34 || c === 39) break
    i++
  }
  while (i > from) {
    const c = value.charCodeAt(i - 1)
    if (c === 46 || c === 44 || c === 59 || c === 58 || c === 33 || c === 63 || c === 41) i--
    else break
  }
  return i
}

function transformInlineText(value: string): MdNode[] {
  const output: MdNode[] = []
  let plain = ''
  const flush = () => {
    if (plain) output.push({ type: 'text', value: plain })
    plain = ''
  }

  for (let i = 0; i < value.length;) {
    if (value[i] === '~' && value[i + 1] === '~') {
      let end = i + 2
      while (end + 1 < value.length && !(value[end] === '~' && value[end + 1] === '~')) end++
      if (end + 1 < value.length && end > i + 2) {
        flush()
        output.push({
          type: 'delete',
          children: [{ type: 'text', value: value.slice(i + 2, end) }],
        })
        i = end + 2
        continue
      }
    }
    const http = value.startsWith('http://', i) || value.startsWith('https://', i)
    if (http) {
      const end = bareUrlEnd(value, i)
      const url = safeHttpUrl(value.slice(i, end))
      if (url) {
        flush()
        output.push({ type: 'link', url, children: [{ type: 'text', value: value.slice(i, end) }] })
        i = end
        continue
      }
    }
    plain += value[i]
    i++
  }
  flush()
  return output
}

function splitInlineLines(children: readonly MdNode[]): MdNode[][] {
  const lines: MdNode[][] = [[]]
  for (const child of children) {
    if (child.type !== 'text' || typeof child.value !== 'string' || !child.value.includes('\n')) {
      lines[lines.length - 1]!.push(child)
      continue
    }
    const parts = child.value.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (parts[i]) lines[lines.length - 1]!.push({ ...child, value: parts[i] })
      if (i < parts.length - 1) lines.push([])
    }
  }
  return lines
}

function trimCell(nodes: MdNode[]): MdNode[] {
  const out = [...nodes]
  const first = out[0]
  if (first?.type === 'text' && typeof first.value === 'string') {
    let start = 0
    while (start < first.value.length) {
      const code = first.value.charCodeAt(start)
      if (code !== 32 && code !== 9) break
      start++
    }
    if (start) first.value = first.value.slice(start)
    if (!first.value) out.shift()
  }
  const last = out[out.length - 1]
  if (last?.type === 'text' && typeof last.value === 'string') {
    let end = last.value.length
    while (end > 0) {
      const code = last.value.charCodeAt(end - 1)
      if (code !== 32 && code !== 9) break
      end--
    }
    if (end < last.value.length) last.value = last.value.slice(0, end)
    if (!last.value) out.pop()
  }
  return out
}

/**
 * Split only pipe characters that remained plain mdast text. Pipes inside inline code or
 * link/emphasis nodes are already structural and stay in that cell. Escaped pipes survive
 * as text. The inline nodes themselves are retained, so table recognition never flattens
 * code, emphasis, links, or strikethrough into plaintext.
 */
function splitInlineTableRow(line: readonly MdNode[]): MdNode[][] {
  const cells: MdNode[][] = [[]]
  let escaped = false
  for (const child of line) {
    if (child.type !== 'text' || typeof child.value !== 'string') {
      cells[cells.length - 1]!.push(child)
      escaped = false
      continue
    }
    let text = ''
    const flush = () => {
      if (text) cells[cells.length - 1]!.push({ ...child, value: text })
      text = ''
    }
    for (const c of child.value) {
      if (escaped) {
        text += c
        escaped = false
      } else if (c === '\\') {
        escaped = true
      } else if (c === '|') {
        flush()
        cells.push([])
      } else {
        text += c
      }
    }
    if (escaped) text += '\\'
    flush()
  }
  if (cells.length > 1 && trimCell(cells[0]!).length === 0) cells.shift()
  if (cells.length > 1 && trimCell(cells[cells.length - 1]!).length === 0) cells.pop()
  return cells.map(trimCell)
}

function inlinePlainText(nodes: readonly MdNode[]): string | null {
  let value = ''
  for (const node of nodes) {
    if (node.type !== 'text' || typeof node.value !== 'string') return null
    value += node.value
  }
  return value
}

function tableDelimiter(cell: string): string | null | false {
  let start = 0
  let end = cell.length
  while (start < end && (cell[start] === ' ' || cell[start] === '\t')) start++
  while (end > start && (cell[end - 1] === ' ' || cell[end - 1] === '\t')) end--
  let left = false
  let right = false
  if (cell[start] === ':') { left = true; start++ }
  if (cell[end - 1] === ':') { right = true; end-- }
  if (end - start < 3) return false
  for (let i = start; i < end; i++) if (cell[i] !== '-') return false
  return left && right ? 'center' : left ? 'left' : right ? 'right' : null
}

type TableResult = MdNode | 'tableCells' | null

function tableFromParagraph(node: MdNode, usedTableCells: number): TableResult {
  if (node.type !== 'paragraph' || !node.children?.length) return null
  const lines = splitInlineLines(node.children)
  if (lines.length < 2) return null
  const headers = splitInlineTableRow(lines[0]!)
  const delimiterNodes = splitInlineTableRow(lines[1]!)
  const delimiters = delimiterNodes.map(inlinePlainText)
  if (delimiters.some((value) => value == null)) return null
  if (!headers.length || headers.length !== delimiters.length) return null
  const align: (string | null)[] = []
  for (const delimiter of delimiters) {
    const parsed = tableDelimiter(delimiter!)
    if (parsed === false) return null
    align.push(parsed)
  }
  // The rectangular expansion below pads every short data row to the header width.
  // Reject the product before constructing any row/cell nodes: inspecting the finished
  // tree is too late for hostile wide × tall tables (§16.2's in-pipeline bound).
  const tableCells = headers.length * (lines.length - 1)
  if (tableCells > MARKDOWN_LIMITS.tableCells - usedTableCells) return 'tableCells'
  const rows = [headers, ...lines.slice(2).map(splitInlineTableRow)]
  return {
    type: 'table',
    align,
    children: rows.map((row) => ({
      type: 'tableRow',
      children: headers.map((_, index) => ({
        type: 'tableCell',
        children: row[index] ?? [],
      })),
    })),
  }
}

function firstText(node: MdNode): MdNode | null {
  const stack = [...(node.children ?? [])].reverse()
  while (stack.length) {
    const current = stack.pop()!
    if (current.type === 'text') return current
    if (current.children) for (let i = current.children.length - 1; i >= 0; i--) stack.push(current.children[i]!)
  }
  return null
}

function applyGfm(root: MdNode): LimitReason | null {
  const stack: MdNode[] = [root]
  let tableCells = 0
  while (stack.length) {
    const node = stack.pop()!
    if (node.type === 'image') {
      node.type = 'link'
      node.children = [{ type: 'text', value: `[image: ${node.alt || 'image'}]` }]
      delete node.alt
    }
    if (node.type === 'listItem') {
      const text = firstText(node)
      const value = text?.value ?? ''
      if (
        value.length >= 3 && value[0] === '[' && value[2] === ']'
        && (value[1] === ' ' || value[1] === 'x' || value[1] === 'X')
      ) {
        node.checked = value[1] !== ' '
        text!.value = value[3] === ' ' ? value.slice(4) : value.slice(3)
      }
    }
    if (node.children) {
      // A URL inside an already-structural link is its label, not another autolink.
      // Reprocessing it would nest `link → link → …` forever on a bare URL.
      const transformText = node.type !== 'link' && node.type !== 'code' && node.type !== 'inlineCode'
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]!
        const table = tableFromParagraph(child, tableCells)
        if (table === 'tableCells') return table
        if (table) {
          tableCells += (table.children ?? []).reduce(
            (count, row) => count + (row.children?.length ?? 0),
            0,
          )
          node.children[i] = table
          stack.push(table)
          continue
        }
        if (transformText && child.type === 'text' && child.value) {
          const transformed = transformInlineText(child.value)
          if (transformed.length !== 1 || transformed[0]?.type !== 'text' || transformed[0].value !== child.value) {
            node.children.splice(i, 1, ...transformed)
            i += transformed.length - 1
            for (let j = transformed.length - 1; j >= 0; j--) stack.push(transformed[j]!)
            continue
          }
        }
        stack.push(child)
      }
    }
  }
  return null
}

/** mdast parents whose children must be block content, so a bare text child is invalid. */
const BLOCK_PARENTS = new Set(['root', 'blockquote', 'listItem', 'footnoteDefinition'])

/**
 * §9.7/§16.2: raw HTML renders as LITERAL TEXT — the reader sees exactly the markup the
 * provider emitted, never a silent hole where it used to be. remark parses raw HTML into
 * mdast `html` nodes (the same node type for block and inline); each becomes the text it
 * was written as. Nothing here interprets anything: a text node is terminal in mdast, and
 * React escapes it on the way to the DOM.
 *
 * Runs AFTER applyGfm deliberately. The produced text is never fed back through the
 * autolink/strikethrough transform or table recognition, so literalizing cannot
 * manufacture an interpretation path — `<a href="https://evil.test">` stays a run of
 * characters rather than becoming a link. (Table recognition already rejected any row
 * containing an `html` node, since a delimiter row must be plain text, so running after
 * it changes no table outcome either.)
 */
export function literalizeHtml(root: MdNode): void {
  const stack: MdNode[] = [root]
  while (stack.length) {
    const node = stack.pop()!
    const children = node.children
    if (!children) continue
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!
      if (child.type === 'html') {
        const text: MdNode = { type: 'text', value: child.value ?? '' }
        // In block position the text needs a block wrapper: a bare text child of
        // root/blockquote/listItem lowers to a stray text node outside any paragraph,
        // which the prose styles never reach.
        children[i] = BLOCK_PARENTS.has(node.type ?? '') ? { type: 'paragraph', children: [text] } : text
        continue
      }
      stack.push(child)
    }
  }
}

/** A react-markdown plugin factory. It closes over source only for bounded degradation. */
export function hardenedMarkdownPlugin(source: string) {
  return function hardeningPlugin() {
    return function transform(root: MdNode) {
      const before = inspectMarkdownTree(root)
      if (before) { degradedTree(root, source, before); return }
      const during = applyGfm(root)
      if (during) { degradedTree(root, source, during); return }
      literalizeHtml(root)
      // The literalized tree is what the bounds must hold for: the paragraph wrappers
      // above are new nodes, so this final inspection is the one that counts.
      const after = inspectMarkdownTree(root)
      if (after) degradedTree(root, source, after)
    }
  }
}

export const markdownUrlTransform: UrlTransform = (url) => safeHttpUrl(url) ?? ''

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="md-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        })
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

function languageName(className: unknown): string {
  if (typeof className !== 'string') return 'text'
  const prefix = 'language-'
  const at = className.indexOf(prefix)
  if (at < 0) return 'text'
  let out = ''
  for (let i = at + prefix.length; i < className.length && out.length < 32; i++) {
    const code = className.charCodeAt(i)
    const safe = (code >= 48 && code <= 57) || (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122) || code === 43 || code === 45 || code === 95
    if (!safe) break
    out += className[i]
  }
  return out || 'text'
}

function codeText(node: ReactNode): string {
  const child = Children.toArray(node)[0]
  if (!isValidElement(child)) return ''
  const text = String((child.props as { children?: ReactNode }).children ?? '')
  return text.endsWith('\n') ? text.slice(0, -1) : text
}

const components: Components = {
  a({ href, children }) {
    const safe = safeHttpUrl(href)
    return safe
      ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a>
      : <span className="md-link-blocked">{children}</span>
  },
  pre({ children }) {
    const child = Children.toArray(children)[0]
    const language = isValidElement(child)
      ? languageName((child.props as { className?: string }).className)
      : 'text'
    const text = codeText(children)
    return (
      <div className="fence">
        <div className="fh"><span>{language}</span><CopyButton value={text} /></div>
        <ScrollFadePre surface="surface">
          {isValidElement(child) ? cloneElement(child as ReactElement) : child}
        </ScrollFadePre>
      </div>
    )
  },
  code({ className, children }) {
    return <code className={typeof className === 'string' ? className : undefined}>{children}</code>
  },
  table({ children }) {
    return <div className="md-table-scroll"><table>{children}</table></div>
  },
  input({ checked }) {
    return <input type="checkbox" checked={Boolean(checked)} disabled />
  },
  ul({ children, className }) {
    return <ul className={className === 'contains-task-list' ? className : undefined}>{children}</ul>
  },
  li({ children, className }) {
    return <li className={className === 'task-list-item' ? className : undefined}>{children}</li>
  },
}

export interface MarkdownProps extends ComponentPropsWithoutRef<'div'> {
  source: string
}

export const HardenedMarkdown = memo(function HardenedMarkdown({ source, className, ...props }: MarkdownProps) {
  const preflight = markdownPreflight(source)
  const classes = ['prose', className].filter(Boolean).join(' ')
  if (!preflight.ok) {
    return (
      <div {...props} className={`${classes} markdown-degraded`} data-degraded={preflight.reason}>
        <p>{MARKDOWN_DEGRADED} ({preflight.reason})</p>
        <pre>{boundedPlaintext(source)}</pre>
      </div>
    )
  }
  return (
    <div {...props} className={classes}>
      <ReactMarkdown
        allowedElements={[...MARKDOWN_ALLOWED_ELEMENTS]}
        // literalizeHtml has already rewritten every `html` mdast node into text, so
        // no `raw` hast node should reach this stage at all. skipHtml stays as the
        // residual guarantee that one CANNOT be interpreted if a future remark/mdast
        // version invents a path we do not walk: it is a mechanical property of the
        // renderer, independent of react-markdown's own default for raw nodes. The
        // literal rendering the contract promises is delivered by our bounded remark
        // stage above, and the tests assert it there and in the DOM.
        skipHtml
        unwrapDisallowed
        urlTransform={markdownUrlTransform}
        remarkPlugins={[hardenedMarkdownPlugin(source)]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  )
})
