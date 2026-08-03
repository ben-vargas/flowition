/**
 * Collapsed step labels (DESIGN §9.6).
 *
 * Shell tokenization is character-scanned and redirect-aware. A write in ANY segment
 * disqualifies the whole command from exploration.
 */

import type { FileAction, ToolItem } from './types.js'

type BreakToken = '&&' | '||' | '|' | ';' | '\n'
interface Token { value: string; quoted: boolean; redirect: boolean }
type ShellToken = Token | { break: BreakToken }

const SEARCH = new Set(['ag', 'grep', 'rg'])
const READ = new Set(['bat', 'cat', 'less', 'more', 'nl'])
const SEARCH_FLAGS_WITH_VALUE = new Set([
  '-A', '-B', '-C', '-e', '-f', '-g', '-m', '--after-context', '--before-context',
  '--context', '--glob', '--max-count', '--type', '--type-add',
])
const FIND_FLAGS_WITH_VALUE = new Set([
  '-exec', '-execdir', '-group', '-iname', '-maxdepth', '-mindepth', '-name', '-newer',
  '-path', '-perm', '-size', '-type', '-user',
])

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 13
}

function redirectAt(command: string, at: number): { value: string; end: number } | null {
  let i = at
  while (i < command.length) {
    const code = command.charCodeAt(i)
    if (code < 48 || code > 57) break
    i++
  }
  const startOperator = i
  if (command[i] !== '>' && command[i] !== '<') return null
  const op = command[i]!
  i++
  if (command[i] === op || (op === '>' && command[i] === '|')) i++
  if (command[i] === '&') {
    i++
    while (i < command.length) {
      const code = command.charCodeAt(i)
      if (code < 48 || code > 57) break
      i++
    }
  }
  return { value: command.slice(at, i), end: i > startOperator ? i : at + 1 }
}

export function tokenizeShell(command: string): ShellToken[] {
  const out: ShellToken[] = []
  let value = ''
  let quoted = false
  let quote = ''
  const flush = () => {
    if (!value) return
    out.push({ value, quoted, redirect: false })
    value = ''
    quoted = false
  }

  for (let i = 0; i < command.length;) {
    const c = command[i]!
    if (quote) {
      if (c === quote) { quote = ''; quoted = true; i++; continue }
      if (c === '\\' && quote === '"' && i + 1 < command.length) {
        value += command[i + 1]; i += 2; continue
      }
      value += c
      i++
      continue
    }
    if (c === "'" || c === '"') { quote = c; i++; continue }
    if (c === '\\' && i + 1 < command.length) { value += command[i + 1]; i += 2; continue }
    if (isSpace(command.charCodeAt(i))) { flush(); i++; continue }
    if (c === '\n') { flush(); out.push({ break: '\n' }); i++; continue }
    if (c === ';') { flush(); out.push({ break: ';' }); i++; continue }
    if ((c === '&' && command[i + 1] === '&') || (c === '|' && command[i + 1] === '|')) {
      flush()
      out.push({ break: command.slice(i, i + 2) as BreakToken })
      i += 2
      continue
    }
    if (c === '|') { flush(); out.push({ break: '|' }); i++; continue }
    const redirect = redirectAt(command, i)
    if (redirect) {
      flush()
      out.push({ value: redirect.value, quoted: false, redirect: true })
      i = redirect.end
      continue
    }
    value += c
    i++
  }
  flush()
  return out
}

function segments(tokens: ShellToken[]): Token[][] {
  const out: Token[][] = []
  let segment: Token[] = []
  for (const token of tokens) {
    if ('break' in token) {
      if (segment.length) out.push(segment)
      segment = []
    } else {
      segment.push(token)
    }
  }
  if (segment.length) out.push(segment)
  return out
}

function assignment(value: string): boolean {
  const eq = value.indexOf('=')
  if (eq <= 0) return false
  const first = value.charCodeAt(0)
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95)) return false
  for (let i = 1; i < eq; i++) {
    const code = value.charCodeAt(i)
    if (!((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95)) return false
  }
  return true
}

function baseExecutable(value: string): string {
  let start = value.length
  while (start > 0 && value.charCodeAt(start - 1) !== 47 && value.charCodeAt(start - 1) !== 92) start--
  return value.slice(start).toLowerCase()
}

function fdDup(value: string): boolean {
  const amp = value.indexOf('&')
  if (amp < 0) return false
  for (let i = amp + 1; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 48 || code > 57) return false
  }
  return amp + 1 < value.length
}

function writeRedirect(tokens: Token[], at: number): boolean {
  const token = tokens[at]!
  if (!token.redirect || !token.value.includes('>') || fdDup(token.value)) return false
  let target = ''
  const opEnd = token.value.lastIndexOf('>') + 1
  if (opEnd < token.value.length && token.value[opEnd] !== '&') target = token.value.slice(opEnd)
  else target = tokens[at + 1]?.value ?? ''
  return Boolean(target && target !== '/dev/null')
}

function collectPositionals(tokens: Token[], from: number, flagsWithValue = new Set<string>()): string[] {
  const out: string[] = []
  for (let i = from; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.redirect) {
      if (!fdDup(token.value) && token.value.endsWith('>')) i++
      continue
    }
    if (!token.quoted && token.value.startsWith('-')) {
      if (flagsWithValue.has(token.value)) i++
      continue
    }
    out.push(token.value)
  }
  return out
}

interface Exploration {
  kind: 'read' | 'search' | 'list'
  path: string | null
  query?: string | null
}

function classifySegment(segment: Token[]): { write: boolean; exploration: Exploration | null } {
  let commandAt = 0
  while (commandAt < segment.length && assignment(segment[commandAt]!.value)) commandAt++
  if (commandAt >= segment.length) return { write: false, exploration: null }
  const command = baseExecutable(segment[commandAt]!.value)
  let write = command === 'tee'
  if (command === 'sed') {
    for (let i = commandAt + 1; i < segment.length; i++) {
      const v = segment[i]!.value
      if (v === '-i' || v.startsWith('-i') || v === '--in-place' || v.startsWith('--in-place=')) write = true
    }
  }
  for (let i = commandAt + 1; i < segment.length; i++) if (writeRedirect(segment, i)) write = true
  if (write) return { write: true, exploration: null }

  if (SEARCH.has(command)) {
    const pos = collectPositionals(segment, commandAt + 1, SEARCH_FLAGS_WITH_VALUE)
    return { write: false, exploration: { kind: 'search', query: pos[0] ?? null, path: pos.at(-1) ?? null } }
  }
  if (command === 'find') {
    const pos = collectPositionals(segment, commandAt + 1, FIND_FLAGS_WITH_VALUE)
    return { write: false, exploration: { kind: 'search', query: null, path: pos[0] ?? '.' } }
  }
  if (command === 'ls') {
    const pos = collectPositionals(segment, commandAt + 1)
    return { write: false, exploration: { kind: 'list', path: pos[0] ?? '.' } }
  }
  if (READ.has(command)) {
    const pos = collectPositionals(segment, commandAt + 1)
    return { write: false, exploration: { kind: 'read', path: pos.at(-1) ?? null } }
  }
  if (command === 'head' || command === 'tail') {
    const pos = collectPositionals(segment, commandAt + 1, new Set(['-n', '-c', '--lines', '--bytes']))
    return { write: false, exploration: { kind: 'read', path: pos.at(-1) ?? null } }
  }
  if (command === 'sed') {
    const pos = collectPositionals(segment, commandAt + 1)
    const hasPrint = segment.some((token) => token.value === '-n' || token.value === '--quiet' || token.value === '--silent')
    if (hasPrint) return { write: false, exploration: { kind: 'read', path: pos.at(-1) ?? null } }
  }
  return { write: false, exploration: null }
}

export function classifyCommand(command: string): { write: boolean; explorations: Exploration[] } {
  const classified = segments(tokenizeShell(command)).map(classifySegment)
  const write = classified.some((entry) => entry.write)
  return {
    write,
    explorations: write ? [] : classified.flatMap((entry) => entry.exploration ? [entry.exploration] : []),
  }
}

function parsedObject(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === 'object' && !Array.isArray(input)) return input as Record<string, unknown>
  return null
}

function structuredExploration(item: ToolItem): Exploration | null {
  const input = parsedObject(item.input)
  const name = item.name.toLowerCase()
  const path = input
    ? input.file_path ?? input.path ?? input.filePath ?? input.notebook_path
    : null
  if (name === 'read') return { kind: 'read', path: typeof path === 'string' ? path : null }
  if (name === 'grep') {
    const query = input?.pattern ?? input?.query ?? input?.regex
    return {
      kind: 'search',
      path: typeof (input?.path ?? input?.glob) === 'string' ? String(input?.path ?? input?.glob) : null,
      query: typeof query === 'string' ? query : null,
    }
  }
  if (name === 'glob' || name === 'ls') return { kind: 'list', path: typeof path === 'string' ? path : '.' }
  return null
}

function phraseCount(verb: string, count: number, singular: string, plural = `${singular}s`): string {
  return `${verb} ${count === 1 ? `1 ${singular}` : `${count} ${plural}`}`
}

function lowerFirst(value: string): string {
  return value ? value[0]!.toLowerCase() + value.slice(1) : value
}

const ACTIVE_FILE_ACTION: Record<FileAction, string> = {
  created: 'Creating',
  deleted: 'Deleting',
  edited: 'Editing',
  renamed: 'Renaming',
}

export function buildWorkSummaryLabel(items: readonly ToolItem[], active = false): string {
  let commands = 0
  let tools = 0
  let searches = 0
  let lists = 0
  const files = new Set<string>()
  const actions = new Map<FileAction, Set<string>>()
  const order: ('files' | 'searches' | 'lists')[] = []
  const seenOrder = new Set<string>()
  const addOrder = (kind: 'files' | 'searches' | 'lists') => {
    if (!seenOrder.has(kind)) { seenOrder.add(kind); order.push(kind) }
  }

  for (const item of items) {
    if (item.card === 'terminal') {
      commands++
      const classified = classifyCommand(item.command ?? item.inputText)
      for (const exploration of classified.explorations) {
        if (exploration.kind === 'read' && exploration.path) { files.add(exploration.path); addOrder('files') }
        else if (exploration.kind === 'search') { searches++; addOrder('searches') }
        else if (exploration.kind === 'list') { lists++; addOrder('lists') }
      }
      continue
    }
    if (item.card === 'file') {
      for (const change of item.files) {
        let set = actions.get(change.action)
        if (!set) actions.set(change.action, (set = new Set()))
        set.add(change.movePath ?? change.path)
      }
      continue
    }
    const exploration = structuredExploration(item)
    if (exploration?.kind === 'read' && exploration.path) { files.add(exploration.path); addOrder('files') }
    else if (exploration?.kind === 'search') { searches++; addOrder('searches') }
    else if (exploration?.kind === 'list') { lists++; addOrder('lists') }
    else tools++
  }

  const phrases: string[] = []
  if (commands) phrases.push(phraseCount(active ? 'Running' : 'Ran', commands, 'command'))
  for (const kind of order) {
    if (kind === 'files' && files.size) phrases.push(phraseCount(active ? 'Exploring' : 'Explored', files.size, 'file'))
    if (kind === 'searches' && searches) phrases.push(phraseCount(active ? 'Searching' : 'Searched', searches, 'time', 'times'))
    if (kind === 'lists' && lists) phrases.push(phraseCount(active ? 'Listing' : 'Listed', lists, 'directory', 'directories'))
  }
  if (tools) phrases.push(phraseCount(active ? 'Running' : 'Ran', tools, 'tool'))

  let changeCount = 0
  const changeKinds: FileAction[] = []
  for (const [action, set] of actions) {
    if (set.size) { changeCount += set.size; changeKinds.push(action) }
  }
  if (changeCount) {
    const verb = changeKinds.length === 1
      ? active
        ? ACTIVE_FILE_ACTION[changeKinds[0]!]
        : `${changeKinds[0]![0]!.toUpperCase()}${changeKinds[0]!.slice(1)}`
      : active ? 'Editing' : 'Edited'
    phrases.push(`${verb} ${changeCount === 1 ? '1 file' : `${changeCount} files`}`)
  }
  if (!phrases.length) return active ? 'Working' : 'Worked'
  return phrases.map((phrase, index) => index ? lowerFirst(phrase) : phrase).join(', ')
}
