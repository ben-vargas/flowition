// Adapter contract:
//   name, protocol            — protocol selects the stream parser
//   bin()                     — executable (overridable via FLOWITION_<NAME>_BIN)
//   caps: {
//     steer: 'live' | 'turn' | 'none'   — live: inject user messages on stdin mid-run;
//                                         turn: deliver queued mail via a session-resume follow-up turn
//     resume: boolean                   — provider session can be continued across processes/runs
//     schema: 'native' | 'native-file' | 'prompt'
//     selfSession: boolean              — flowition assigns the session id up front (pi)
//     acceptsModel: boolean
//   }
//   validateSpec(spec)?       — optional; return an error string to reject a spec at agent() time
//   build({spec, prompt, mode, sessionId, scratch}) -> {argv, stdin, keepOpen, tempFiles}
//   userMessage(text)         — stdin line for live steering (claude-stream protocol)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import mock from './mock.js'

const env = (n) => process.env[`FLOWITION_${n.toUpperCase()}_BIN`]

const claudeUserMessage = (text) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })

// amp, codex, opencode, and cursor have no system/append-system flag (verified) —
// spec.system would be silently discarded. Prepend it to the prompt of the
// FIRST turn of a fresh session as a delimited preamble; resume turns (schema
// correction, queued-mail follow-ups, cross-run session continuation) carry it
// in the session already and must not repeat it.
const systemPreamble = (spec, prompt, mode) =>
  spec.system && mode === 'fresh' ? '[system instructions]\n' + spec.system + '\n[task]\n' + prompt : prompt

const claude = {
  name: 'claude',
  protocol: 'claude-stream',
  bin: () => env('claude') || 'claude',
  caps: { steer: 'live', resume: true, schema: 'native', selfSession: false, acceptsModel: true },
  mapEffort: (e) => ({ none: 'low', minimal: 'low' }[e] ?? e),
  build({ spec, prompt, mode, sessionId }) {
    const argv = ['-p', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json', '--dangerously-skip-permissions']
    if (mode === 'resume') argv.push('--resume', sessionId)
    if (spec.model) argv.push('--model', spec.model)
    if (spec.effort) argv.push('--effort', this.mapEffort(spec.effort))
    if (spec.system) argv.push('--append-system-prompt', spec.system)
    if (spec.schema && this.caps.schema === 'native') argv.push('--json-schema', JSON.stringify(spec.schema))
    return { argv, stdin: claudeUserMessage(prompt) + '\n', keepOpen: true, tempFiles: [] }
  },
  userMessage: claudeUserMessage,
}

// amp has no model flag — `-m` selects an *agent mode*, which bundles model,
// system prompt, and tool selection. Builtins: low/medium/high/ultra. Custom modes
// are amp plugins (~/.config/amp/plugins/*.ts); amp's plugin sync stamps each file
// with `// @amp-agent-mode {"key":...,"label":...}` header annotations, which we
// parse (with a registerAgentMode() source scan as fallback for hand-written ones).
const AMP_BUILTIN_MODES = ['low', 'medium', 'high', 'ultra']
const REGEX_PREFIX = new Set('{,([:=&|!?;+-*%<>~^')
const REGEX_WORDS = new Set(['return', 'case', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'do', 'else', 'yield', 'await'])
let ampModesCache = null

export function ampPluginsDir() {
  return process.env.FLOWITION_AMP_PLUGINS_DIR || path.join(os.homedir(), '.config', 'amp', 'plugins')
}

function objectLiteral(src, start) {
  const open = src.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  let quote = null
  let escaped = false
  let lineComment = false
  let blockComment = false
  let previous = null
  let lastWord = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (lineComment) {
      if (c === '\n') lineComment = false
      continue
    }
    if (blockComment) {
      if (c === '*' && next === '/') { blockComment = false; i++ }
      continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === quote) quote = null
      continue
    }
    if (c === '/' && next === '/') { lineComment = true; i++; continue }
    if (c === '/' && next === '*') { blockComment = true; i++; continue }
    if (c === "'" || c === '"' || c === '`') { quote = c; previous = c; lastWord = null; continue }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++
      lastWord = src.slice(i, j)
      previous = src[j - 1]
      i = j - 1
      continue
    }
    if (c === '/' && (REGEX_PREFIX.has(previous) || REGEX_WORDS.has(lastWord))) {
      let inClass = false
      let regexEscaped = false
      let closed = false
      let j = i + 1
      for (; j < src.length && src[j] !== '\n' && src[j] !== '\r'; j++) {
        const r = src[j]
        if (regexEscaped) { regexEscaped = false; continue }
        if (r === '\\') { regexEscaped = true; continue }
        if (r === '[') { inClass = true; continue }
        if (r === ']' && inClass) { inClass = false; continue }
        if (r === '/' && !inClass) { closed = true; break }
      }
      i = closed ? j : j - 1
      previous = '/'
      lastWord = null
      continue
    }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return src.slice(open, i + 1)
    if (!/\s/.test(c)) { previous = c; lastWord = null }
  }
  return null
}

function staticString(match) {
  if (!match) return undefined
  if (match[1] === '`' && /(^|[^\\])(?:\\\\)*\$\{/.test(match[2])) return undefined
  return match[2]
}

export function discoverAmpModes() {
  if (ampModesCache) return ampModesCache
  const modes = AMP_BUILTIN_MODES.map((key) => ({ key, label: key, builtin: true }))
  const add = (key, label, plugin) => {
    if (key && !modes.some((m) => m.key === key)) modes.push({ key, label: label || key, plugin })
  }
  let files = []
  try { files = fs.readdirSync(ampPluginsDir()).filter((f) => /\.(ts|js|mjs)$/.test(f)) } catch { /* no plugins dir */ }
  for (const f of files) {
    let src
    try { src = fs.readFileSync(path.join(ampPluginsDir(), f), 'utf8') } catch { continue }
    for (const m of src.matchAll(/@amp-agent-mode\s+(\{.*?\})/g)) {
      try { const a = JSON.parse(m[1]); add(a.key, a.label, f) } catch { /* malformed annotation */ }
    }
    for (const m of src.matchAll(/registerAgentMode\s*\(\s*\{/g)) {
      const body = objectLiteral(src, m.index)
      const key = staticString(body?.match(/(?:^|[,{])\s*(?:key|['"]key['"])\s*:\s*(['"`])((?:\\.|(?!\1).)*?)\1/s))
      const label = staticString(body?.match(/(?:^|[,{])\s*(?:label|['"]label['"])\s*:\s*(['"`])((?:\\.|(?!\1).)*?)\1/s))
      add(key, label, f)
    }
  }
  ampModesCache = modes
  return modes
}

export function resolveAmpMode(want) {
  const modes = discoverAmpModes()
  const w = String(want).toLowerCase()
  const hit = modes.find((m) => m.key.toLowerCase() === w) ?? modes.find((m) => m.label.toLowerCase() === w)
  if (!hit) {
    const list = modes.map((m) => (m.key === m.label ? m.key : `${m.key} ("${m.label}")`)).join(', ')
    throw new Error(`unknown amp mode "${want}"; available: ${list}`)
  }
  return hit.key
}

// effort → builtin mode. A closed table: an out-of-vocabulary effort must be
// rejected at agent() time (validateSpec below) — mapEffort returning undefined
// would put undefined into argv and surface as a confusing spawn error.
const AMP_EFFORT_MODES = { none: 'low', minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'ultra', max: 'ultra' }

const amp = {
  name: 'amp',
  protocol: 'claude-stream-eof',
  bin: () => env('amp') || 'amp',
  // `model` is accepted as an alias for `mode` (both resolve against discovered modes)
  caps: { steer: 'live', resume: true, schema: 'prompt', selfSession: false, acceptsModel: true },
  // Object.hasOwn keeps the table closed: `in` (or a bare index) walks the
  // prototype chain, so effort names like "toString"/"constructor" would pass
  // validation and put a function into argv (ERR_INVALID_ARG_TYPE at spawn).
  mapEffort: (e) => (Object.hasOwn(AMP_EFFORT_MODES, e) ? AMP_EFFORT_MODES[e] : undefined),
  validateSpec(spec) {
    const want = spec.mode ?? spec.model
    if (want != null) {
      try { resolveAmpMode(want); return null } catch (err) { return err.message }
    }
    // effort is only consulted when no mode/model is given (build's fallback)
    if (spec.effort != null && !Object.hasOwn(AMP_EFFORT_MODES, spec.effort)) {
      return `unknown effort "${spec.effort}" (amp maps effort to a builtin mode; accepted: ${Object.keys(AMP_EFFORT_MODES).join(', ')})`
    }
    return null
  },
  build({ spec, prompt, mode, sessionId }) {
    prompt = systemPreamble(spec, prompt, mode)
    const base = ['-x', '--stream-json', '--stream-json-input', '--no-notifications']
    const argv = mode === 'resume' ? ['threads', 'continue', sessionId, ...base] : [...base]
    const want = spec.mode ?? spec.model
    if (want != null) argv.push('-m', resolveAmpMode(want))
    else if (spec.effort) argv.push('-m', this.mapEffort(spec.effort))
    return { argv, stdin: claudeUserMessage(prompt) + '\n', keepOpen: true, tempFiles: [] }
  },
  userMessage: claudeUserMessage,
}

const droid = {
  name: 'droid',
  protocol: 'droid-jsonl',
  bin: () => env('droid') || 'droid',
  caps: { steer: 'turn', resume: true, schema: 'prompt', selfSession: false, acceptsModel: true },
  mapEffort: (e) => ({ none: 'low', minimal: 'low' }[e] ?? e),
  build({ spec, prompt, mode, sessionId, scratch }) {
    const argv = ['exec', '-o', 'stream-json', '--skip-permissions-unsafe']
    if (mode === 'resume') argv.push('-s', sessionId)
    if (spec.model) argv.push('-m', spec.model)
    if (spec.effort) argv.push('-r', this.mapEffort(spec.effort))
    if (spec.system) argv.push('--append-system-prompt', spec.system)
    if (spec.cwd) argv.push('--cwd', spec.cwd)
    const pf = path.join(scratch, `prompt-${Date.now()}-${Math.floor(Math.random() * 1e6)}.md`)
    fs.writeFileSync(pf, prompt, { mode: 0o600 })
    argv.push('-f', pf)
    return { argv, stdin: null, keepOpen: false, tempFiles: [pf] }
  },
}

const codex = {
  name: 'codex',
  protocol: 'codex-jsonl',
  bin: () => env('codex') || 'codex',
  caps: { steer: 'turn', resume: true, schema: 'native-file', selfSession: false, acceptsModel: true },
  mapEffort: (e) => ({ minimal: 'low' }[e] ?? e),
  build({ spec, prompt, mode, sessionId, scratch }) {
    prompt = systemPreamble(spec, prompt, mode)
    const argv = ['exec']
    const tempFiles = []
    if (mode === 'resume') argv.push('resume', sessionId)
    argv.push('--json', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox')
    if (spec.model) argv.push('-m', spec.model)
    if (spec.effort) argv.push('-c', `model_reasoning_effort=${JSON.stringify(this.mapEffort(spec.effort))}`)
    if (spec.schema && this.caps.schema === 'native-file') {
      const sf = path.join(scratch, `schema-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`)
      fs.writeFileSync(sf, JSON.stringify(spec.schema), { mode: 0o600 })
      argv.push('--output-schema', sf)
      tempFiles.push(sf)
    }
    argv.push('-') // read prompt from stdin
    return { argv, stdin: prompt, keepOpen: false, tempFiles }
  },
}

const opencode = {
  name: 'opencode',
  protocol: 'opencode-jsonl',
  bin: () => env('opencode') || 'opencode',
  caps: { steer: 'turn', resume: true, schema: 'prompt', selfSession: false, acceptsModel: true },
  // variants are provider-specific — pass through and let opencode validate
  mapEffort: (e) => ({ none: 'minimal' }[e] ?? e),
  build({ spec, prompt, mode, sessionId }) {
    prompt = systemPreamble(spec, prompt, mode)
    const argv = ['run', '--format', 'json', '--auto']
    if (mode === 'resume') argv.push('--session', sessionId)
    if (spec.model) argv.push('-m', spec.model)
    if (spec.effort) argv.push('--variant', this.mapEffort(spec.effort))
    return { argv, stdin: prompt, keepOpen: false, tempFiles: [] }
  },
}

const pi = {
  name: 'pi',
  protocol: 'pi-jsonl',
  bin: () => env('pi') || 'pi',
  caps: { steer: 'turn', resume: true, schema: 'prompt', selfSession: true, acceptsModel: true },
  mapEffort: (e) => ({ none: 'off' }[e] ?? e), // pi --thinking supports off..max natively
  build({ spec, prompt, sessionId }) {
    // fresh and resume are identical: flowition assigns the session id (--session-id creates if missing)
    const argv = ['--mode', 'json', '-p', '--session-id', sessionId]
    if (spec.model) argv.push('--model', spec.model)
    if (spec.effort) argv.push('--thinking', this.mapEffort(spec.effort))
    if (spec.system) argv.push('--append-system-prompt', spec.system)
    return { argv, stdin: prompt, keepOpen: false, tempFiles: [] }
  },
}

// cursor encodes reasoning effort INTO the model id (gpt-5.6-sol-xhigh,
// claude-opus-4-8[effort=high]) — there is no effort flag, so spec.effort is
// rejected at agent() time rather than silently dropped (mirroring amp's
// closed-vocabulary rejection).
const cursor = {
  name: 'cursor',
  protocol: 'cursor-jsonl',
  bin: () => env('cursor') || 'cursor-agent',
  caps: { steer: 'turn', resume: true, schema: 'prompt', selfSession: false, acceptsModel: true },
  validateSpec(spec) {
    if (spec.effort != null) {
      return `cursor has no effort flag — encode effort in the model id instead (e.g. model: 'gpt-5.6-sol-xhigh' or 'claude-opus-4-8[effort=high]'); \`cursor-agent --list-models\` lists ids`
    }
    return null
  },
  build({ spec, prompt, mode, sessionId }) {
    prompt = systemPreamble(spec, prompt, mode)
    const argv = ['-p']
    if (mode === 'resume') argv.push('--resume', sessionId)
    argv.push('--output-format', 'stream-json', '--force')
    if (spec.model) argv.push('--model', spec.model)
    return { argv, stdin: prompt, keepOpen: false, tempFiles: [] }
  },
}

const ADAPTERS = { claude, codex, amp, droid, opencode, pi, cursor, mock }

export function getAdapter(name) {
  const a = ADAPTERS[name]
  if (!a) throw new Error(`unknown adapter "${name}" (have: ${Object.keys(ADAPTERS).join(', ')})`)
  return a
}

export const listAdapters = () => Object.keys(ADAPTERS)
