/**
 * Transcript wire records → renderable timeline items (DESIGN §9.6).
 *
 * Pairing is id-first. Only an id-less result may use the old-run positional stack, and
 * that row is labelled approximate. An id-bearing orphan is surfaced independently.
 */

import type {
  AttemptSegment,
  FileAction,
  FileChange,
  SourceRecord,
  TimelineBase,
  TimelineItem,
  ToolItem,
  ToolResult,
  TranscriptProjection,
  TranscriptRecord,
} from './types.js'

export const OLD_ATTEMPT_SENTINEL = '— resumed run: new attempt below —'

const SHELL_TOOLS = new Set([
  'bash', 'command', 'commandexecution', 'exec', 'execute', 'shell', 'sh', 'terminal', 'zsh',
])
const FILE_TOOLS = new Set([
  'applypatch', 'apply_patch', 'createfile', 'edit', 'filechange', 'multiedit',
  'patch', 'str_replace_editor', 'write', 'writefile',
])
const KNOWN_SHELLS = new Set([
  'ash', 'bash', 'dash', 'fish', 'ksh', 'pwsh', 'sh', 'zsh',
])

const string = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : value == null ? fallback : safeJson(value)

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const opaqueId = (value: unknown): string | null =>
  typeof value === 'string' && value ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : null

function safeJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? String(value) } catch { return String(value) }
}

function parseInput(value: unknown): unknown {
  if (typeof value !== 'string') return value ?? ''
  const trimmed = value.trim()
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value
  try { return JSON.parse(trimmed) as unknown } catch { return value }
}

function base(source: SourceRecord, attempt: number, suffix = ''): TimelineBase {
  return {
    id: `${source.o}${suffix}`,
    t: finite(source.rec.t),
    o: source.o,
    attempt,
  }
}

function basename(path: string): string {
  let end = path.length
  while (end > 0 && path.charCodeAt(end - 1) === 47) end--
  let start = end
  while (start > 0 && path.charCodeAt(start - 1) !== 47 && path.charCodeAt(start - 1) !== 92) start--
  return path.slice(start, end)
}

function normalizedTool(name: string): string {
  let out = ''
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i)
    if ((code >= 48 && code <= 57) || (code >= 97 && code <= 122)) out += name[i]
    else if (code >= 65 && code <= 90) out += String.fromCharCode(code + 32)
  }
  return out
}

function argvCommand(argv: unknown[]): string | null {
  if (!argv.length) return null
  const executable = typeof argv[0] === 'string' ? basename(argv[0]).toLowerCase() : ''
  if (
    argv.length >= 3
    && KNOWN_SHELLS.has(executable)
    && (argv[1] === '-lc' || argv[1] === '-c')
    && typeof argv[2] === 'string'
  ) return argv[2]
  return argv.map((part) => typeof part === 'string' ? part : safeJson(part)).join(' ')
}

export function extractCommand(input: unknown): string | null {
  const parsed = parseInput(input)
  if (Array.isArray(parsed)) return argvCommand(parsed)
  if (parsed && typeof parsed === 'object') {
    const record = parsed as Record<string, unknown>
    for (const key of ['command', 'cmd', 'script']) {
      if (typeof record[key] === 'string') return record[key] as string
    }
    for (const key of ['argv', 'args']) {
      if (Array.isArray(record[key])) return argvCommand(record[key] as unknown[])
    }
  }
  return typeof parsed === 'string' ? parsed : safeJson(parsed)
}

function actionFrom(value: unknown, hasMove: boolean, diff: string | null): FileAction {
  if (hasMove) {
    const stats = diffStats(diff)
    return stats.additions || stats.deletions ? 'edited' : 'renamed'
  }
  const raw = String(value ?? '').toLowerCase()
  if (raw.includes('creat') || raw === 'add' || raw === 'new') return 'created'
  if (raw.includes('delet') || raw.includes('remov')) return 'deleted'
  if (raw.includes('renam') || raw.includes('move')) return 'renamed'
  return 'edited'
}

export function diffStats(
  diff: string | null,
  action?: FileAction,
): { additions: number; deletions: number } {
  if (!diff) return { additions: 0, deletions: 0 }
  let additions = 0
  let deletions = 0
  let contentLines = 0
  let patchShaped = false
  let start = 0
  for (let i = 0; i <= diff.length; i++) {
    if (i !== diff.length && diff.charCodeAt(i) !== 10) continue
    const line = diff.slice(start, i)
    start = i + 1
    if (line.startsWith('+++') || line.startsWith('---')) { patchShaped = true; continue }
    if (line.startsWith('@@') || line.startsWith('diff ')) { patchShaped = true; continue }
    if (line.trim()) contentLines++
    if (line[0] === '+') additions++
    else if (line[0] === '-') deletions++
    if (line[0] === '+' || line[0] === '-') patchShaped = true
  }
  if (!patchShaped && action === 'created') additions = contentLines
  if (!patchShaped && action === 'deleted') deletions = contentLines
  return { additions, deletions }
}

function prefixedLines(value: unknown, prefix: '+' | '-'): string {
  const text = string(value)
  if (!text) return ''
  let out = ''
  let start = 0
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text.charCodeAt(i) !== 10) continue
    out += `${prefix}${text.slice(start, i)}\n`
    start = i + 1
  }
  return out.endsWith('\n') ? out.slice(0, -1) : out
}

export function synthesizeDiff(input: Record<string, unknown>, action: FileAction): string | null {
  for (const key of ['diff', 'patch']) if (typeof input[key] === 'string' && input[key]) return input[key] as string
  const oldText = input.old_string ?? input.oldText ?? input.before
  const newText = input.new_string ?? input.newText ?? input.after
  if (oldText != null || newText != null) {
    return [prefixedLines(oldText, '-'), prefixedLines(newText, '+')].filter(Boolean).join('\n')
  }
  const content = input.content ?? input.text
  if (content != null && (action === 'created' || action === 'edited')) return prefixedLines(content, '+')
  return null
}

function oneFile(raw: Record<string, unknown>, fallback: Record<string, unknown>): FileChange {
  const path = string(
    raw.path ?? raw.file_path ?? raw.filePath
      ?? fallback.path ?? fallback.file_path ?? fallback.filePath,
    '(unknown path)',
  )
  const movePathValue = raw.movePath ?? raw.move_path ?? raw.new_path ?? fallback.movePath ?? fallback.move_path
  const movePath = typeof movePathValue === 'string' && movePathValue ? movePathValue : null
  let diff = typeof (raw.diff ?? raw.patch) === 'string' ? string(raw.diff ?? raw.patch) : null
  const tentative = actionFrom(raw.action ?? raw.kind ?? fallback.action ?? fallback.kind, movePath != null, diff)
  if (!diff) diff = synthesizeDiff({ ...fallback, ...raw }, tentative)
  const action = actionFrom(raw.action ?? raw.kind ?? fallback.action ?? fallback.kind, movePath != null, diff)
  const stats = diffStats(diff, action)
  return { action, path, movePath, diff, ...stats }
}

export function buildFileChanges(input: unknown): FileChange[] {
  const parsed = parseInput(input)
  if (Array.isArray(parsed)) {
    return parsed.filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object')
      .map((v) => oneFile(v, {}))
  }
  if (!parsed || typeof parsed !== 'object') return []
  const record = parsed as Record<string, unknown>
  const changes = record.changes
  if (Array.isArray(changes)) {
    return changes
      .filter((v): v is Record<string, unknown> => Boolean(v) && typeof v === 'object')
      .map((v) => oneFile(v, record))
  }
  return [oneFile(record, {})]
}

function toolItem(source: SourceRecord, attempt: number): ToolItem {
  const rec = source.rec
  const name = string(rec.name, 'tool')
  const normalized = normalizedTool(name)
  const input = parseInput(rec.input)
  const card = SHELL_TOOLS.has(normalized)
    ? 'terminal'
    : FILE_TOOLS.has(normalized) ? 'file' : 'generic'
  return {
    ...base(source, attempt),
    kind: 'tool',
    card,
    name,
    input,
    inputText: typeof rec.input === 'string' ? rec.input : safeJson(rec.input ?? ''),
    toolId: opaqueId(rec.id),
    result: null,
    approximate: false,
    command: card === 'terminal' ? extractCommand(rec.input) : null,
    files: card === 'file' ? buildFileChanges(rec.input) : [],
  }
}

function resultOf(rec: TranscriptRecord): ToolResult {
  return {
    text: string(rec.output),
    isError: rec.isError === true,
    t: finite(rec.t),
    exitCode: Number.isInteger(rec.exitCode) ? rec.exitCode as number : null,
  }
}

function coalesce(items: TimelineItem[], next: TimelineItem): boolean {
  const prior = items[items.length - 1]
  if (!prior || prior.attempt !== next.attempt || prior.kind !== next.kind) return false
  if (prior.kind === 'text' && next.kind === 'text') {
    prior.text += next.text
    prior.o = next.o
    return true
  }
  if (prior.kind === 'reasoning' && next.kind === 'reasoning') {
    prior.text += next.text
    prior.o = next.o
    return true
  }
  if (prior.kind === 'raw' && next.kind === 'raw') {
    prior.lines.push(...next.lines)
    prior.o = next.o
    return true
  }
  return false
}

function closeSegment(
  attempts: AttemptSegment[],
  n: number,
  approximate: boolean,
  firstOffset: number,
  lastOffset: number,
) {
  if (lastOffset < firstOffset) return
  attempts.push({ n, approximate, firstOffset, lastOffset })
}

function inferInitialAttempt(records: readonly SourceRecord[], hinted: number): number {
  let oldBoundaries = 0
  for (const source of records) {
    const rec = source.rec
    if (rec.kind === 'attempt' && Number.isInteger(rec.n)) {
      // A structured attempt marker opens N, so retained records before it are N-1.
      return Math.max(1, (rec.n as number) - 1)
    }
    if (rec.kind === 'meta' && Number.isInteger(rec.attempt)) {
      return Math.max(1, rec.attempt as number)
    }
    if (rec.kind === 'status' && rec.text === OLD_ATTEMPT_SENTINEL) oldBoundaries++
  }
  // Old runs have no numbered markers. Count backwards from the snapshot's total.
  return Math.max(1, hinted - oldBoundaries)
}

export function toItems(
  records: readonly SourceRecord[],
  options: { initialAttempt?: number } = {},
): TranscriptProjection {
  const items: TimelineItem[] = []
  const attempts: AttemptSegment[] = []
  const byId = new Map<string, ToolItem>()
  const stack: ToolItem[] = []
  let attempt = inferInitialAttempt(records, Math.max(1, options.initialAttempt ?? 1))
  let approximateAttempt = false
  let firstOffset = records[0]?.o ?? 0
  let lastOffset = firstOffset

  const beginAttempt = (source: SourceRecord, n: number, approximate: boolean) => {
    closeSegment(attempts, attempt, approximateAttempt, firstOffset, lastOffset)
    // A result may not reach backward across an execution-attempt boundary.
    byId.clear()
    stack.length = 0
    attempt = Math.max(1, n)
    approximateAttempt = approximate
    firstOffset = source.o
    lastOffset = source.o
    items.push({ ...base(source, attempt, ':attempt'), kind: 'attempt', approximate })
  }

  for (const source of records) {
    const rec = source.rec
    const kind = typeof rec.kind === 'string' ? rec.kind : 'unknown'
    lastOffset = source.o

    if (kind === 'attempt') {
      beginAttempt(source, Number.isInteger(rec.n) ? rec.n as number : attempt + 1, false)
      continue
    }
    if (kind === 'status' && rec.text === OLD_ATTEMPT_SENTINEL) {
      // New runs write a structured marker immediately before this compatibility line.
      if (items[items.length - 1]?.kind !== 'attempt') {
        beginAttempt(source, attempt + 1, true)
      }
      continue
    }
    if (kind === 'meta') {
      const declared = Number.isInteger(rec.attempt) ? rec.attempt as number : attempt
      if (declared !== attempt) {
        if (items.length) beginAttempt(source, declared, false)
        else {
          attempt = Math.max(1, declared)
          firstOffset = source.o
        }
      }
      const text = string(rec.prompt)
      const next: TimelineItem = {
        ...base(source, attempt),
        kind: 'prompt',
        text,
        truncated: text.includes('… [+') && text.endsWith(' chars]'),
      }
      items.push(next)
      continue
    }
    if (kind === 'text' || kind === 'reasoning') {
      const next = {
        ...base(source, attempt),
        kind,
        text: string(rec.text),
      } as TimelineItem
      if (!coalesce(items, next)) items.push(next)
      continue
    }
    if (kind === 'tool') {
      const tool = toolItem(source, attempt)
      items.push(tool)
      stack.push(tool)
      if (tool.toolId) byId.set(tool.toolId, tool)
      continue
    }
    if (kind === 'tool-result') {
      const id = opaqueId(rec.toolUseId)
      let tool: ToolItem | undefined
      let approximate = false
      if (id) {
        tool = byId.get(id)
        if (tool) byId.delete(id)
      } else {
        while (stack.length && stack[stack.length - 1]!.result) stack.pop()
        tool = stack.pop()
        approximate = Boolean(tool)
      }
      if (tool && !tool.result) {
        tool.result = resultOf(rec)
        tool.approximate = approximate
      } else {
        items.push({
          ...base(source, attempt, ':orphan'),
          kind: 'orphan-result',
          name: string(rec.name, 'tool result'),
          result: resultOf(rec),
          toolUseId: id,
        })
      }
      continue
    }
    if (kind === 'mail-in' || kind === 'mail-out') {
      items.push({
        ...base(source, attempt),
        kind: 'mail',
        direction: kind === 'mail-in' ? 'in' : 'out',
        text: string(rec.text),
        origin: typeof rec.origin === 'string' ? rec.origin : null,
        delivery: typeof rec.delivery === 'string' ? rec.delivery : null,
      })
      continue
    }
    if (kind === 'status') {
      items.push({ ...base(source, attempt), kind: 'status', text: string(rec.text) })
      continue
    }
    if (kind === 'raw') {
      const next: TimelineItem = { ...base(source, attempt), kind: 'raw', lines: [string(rec.text)] }
      if (!coalesce(items, next)) items.push(next)
      continue
    }
    items.push({ ...base(source, attempt), kind: 'unknown', value: rec })
  }

  closeSegment(attempts, attempt, approximateAttempt, firstOffset, lastOffset)
  if (!attempts.length) attempts.push({ n: 1, approximate: false, firstOffset: 0, lastOffset: 0 })
  return { items, attempts }
}
