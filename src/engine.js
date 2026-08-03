// The flowition engine. Loads a workflow module (export const meta + export default
// async (w) => {...}), executes it with the DSL toolkit, journals everything for
// resume, serves a control socket for steering/inspection, and returns the result.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { acquireRunLock as acquireLock, RunLockError } from './run-lock.js'
import { Journal } from './journal.js'
import { EventSink } from './events.js'
import { Semaphore } from './semaphore.js'
import { Transcript } from './transcript.js'
import { AgentJob, AgentError, DEFAULT_STALL_MS } from './agent-proc.js'
import { serveControl } from './control.js'
import { getAdapter } from './adapters/index.js'
import * as K from './keys.js'
import { sha256, canonical, ensureDir, runDir, shortId, truncate } from './util.js'

export class WorkflowError extends Error {}
// Per-item degradable failure — parallel()/pipeline() turn these into null.
export class AgentFailed extends Error {
  constructor(message, code) { super(message); this.code = code }
}

// Stamped on the run-start event (DESIGN §8 E3) so readers can decide which event
// fields a run's engine was capable of writing (§6.2 Caps) instead of guessing from
// field presence. Read once, best-effort — a missing package.json is not fatal.
const ENGINE_VERSION = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version ?? null } catch { return null }
})()

// Per-agent progress ceiling (E6). The agreed volume ceiling for events.jsonl:
// worst case ~24 lines/min/agent, and no other high-frequency event may be added.
const PROGRESS_MS = 2500

// The exclusive per-run lock lives in src/run-lock.js: it is the SAME protocol the
// launchers and retention use (DESIGN §7.3), and one shared implementation is the only
// way "exactly one side owns the run" can be true across processes. Refusals arrive as
// RunLockError and are re-thrown as WorkflowError with the same messages as before.
function acquireRunLock(dir, { resuming = false, runId = null } = {}) {
  try {
    return acquireLock(dir)
  } catch (err) {
    if (err instanceof RunLockError) throw new WorkflowError(err.message)
    // A resume whose run directory was renamed away (retention's move-to-trash) between
    // the existence check and the lock write: the lock is created with `wx` and never
    // creates its parent, so this is the "resume loses" branch — reported as such
    // instead of as a raw ENOENT from deep inside the lock protocol.
    if (resuming && err?.code === 'ENOENT') {
      throw new WorkflowError(`run ${runId ?? path.basename(dir)} disappeared while the resume was starting — it was deleted`)
    }
    throw err
  }
}

// Minimal ESM import scanner — a character lexer, not a regex, so comment and
// string/template CONTENTS are skipped (prompt text saying "import(x)" neither
// hashes nor flags anything) while real specifiers are found regardless of
// spacing (import{v}from'./d.js'). Rules: a string right after the `import` or
// `from` keyword is a specifier; inside `import(` — and the phase forms
// `import.source(` / `import.defer(`, while `import.meta` stays inert — a
// string followed by `)` or `,` is a specifier and ANYTHING else (identifier,
// `+`, backtick, …) marks the module dynamic. The identifier token `require`
// immediately followed by `(` is treated exactly like `import(`: local CJS
// chains (a hashed './helper.cjs' whose require('./dep.cjs') pulls in more
// local code) would otherwise escape the module graph — bare package names
// stay environment via moduleGraphHash's local-path filter, obj.require(x)
// stays clean via the dot rule, and the word require in strings stays inert.
// Runtime code construction is a
// scanner blind spot by construction — string contents are DELIBERATELY inert,
// so eval("import('./dep.mjs')") executes an import the scan cannot see — and
// therefore flags dynamic (loud resume refusal) in code position: the
// identifier tokens `eval` and `Function` each followed by `(` — bare
// Function('...') constructs the same function as new Function (ES 20.2.1.1),
// so no preceding `new` is required, and a user identifier literally named
// Function false-positives toward the loud refusal, the preferred direction.
// Property access (obj.eval(x), obj.Function(x)) stays clean via the
// dot-property rule below. A string scan that hits end-of-line/EOF without its closing
// quote only happens on a mis-lex (a real unterminated string is a syntax
// error — the module could never load), so that case flags dynamic. Regex
// literals are modeled with the expression-position heuristic (see NONEXPR
// and exprEnd) so their bodies — including quotes and braces — stay inert.
const isId = (c) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$'

// JS has FOUR line terminators (\n, \r, \u2028, \u2029): each ends a //
// comment and a regex-literal scan, so a CR-only file cannot hide code the
// scan treats as one line while Node sees several. Crossing one also
// matters to ASI (see the ++/-- handling below).
const isLineTerm = (c) => c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029'
const LINE_TERM = /[\n\r\u2028\u2029]/
// \u2026but a ' or " STRING only terminates at LF/CR: raw LS/PS inside a string
// literal are legal CONTENT since ES2019, so the string scans (outer and
// interpolation) must not treat them as end-of-line \u2014 only comments and regex
// literals end at all four, matching the grammar.
const isStrEol = (c) => c === '\n' || c === '\r'
const lineEnd = (src, from) => {
  for (let j = from; j < src.length; j++) if (isLineTerm(src[j])) return j
  return -1
}

// the COMPLETE reserved + contextual word list minus the operand keywords that
// genuinely end an expression (this, super, true, false, null). A `/` right
// after any word in this set starts a regex scan, where the universal swallow
// guard applies; after any word NOT in it, `/` is division — correct by
// grammar for ordinary identifiers, not a heuristic. Closing the surface this
// way (rounds 8-11 each patched one omitted keyword) means a contextual word
// used as a plain identifier before division (`of / 2`) mis-enters a regex
// scan and fails LOUD via the guard or EOL rule, never silent — deliberate
// trade. Residual silent surface: only future reserved words added to JS.
const NONEXPR = new Set(['await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for', 'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'new', 'of', 'package', 'private', 'protected', 'public', 'return', 'static', 'switch', 'throw', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'async', 'get', 'set'])

// a `(` right after one of these opens a condition head: the `)` that closes
// it is STATEMENT position, where `/` starts a regex, not division. Tracked
// with a paren stack so nested plain parens ((a+b)/2, f(x)/2) stay division.
// `for await (` needs one extra word of lookbehind — at its `(` the previous
// word is `await`, not `for`. Property access is excluded by the caller's
// dot tracking (`x.if(y)` opens a call paren, not a head).
const STMT_HEAD = new Set(['if', 'while', 'for', 'switch', 'catch'])
const stmtHead = (w, pw) => STMT_HEAD.has(w) || (w === 'await' && pw === 'for')

// Scan a regex literal starting at the `/` at src[start]: backslash escapes,
// `/` inside a [class] does not close, flags consumed after the closing `/`.
// Unclosed before EOL/EOF means the position was mis-judged (a real regex is
// single-line) — callers flag dynamic, same fail-safe as strings.
const scanRegex = (src, start) => {
  const n = src.length
  let j = start + 1
  let cls = false
  while (j < n && !isLineTerm(src[j])) {
    const r = src[j]
    if (r === '\\') { j += 2; continue }
    if (r === '[') cls = true
    else if (r === ']') cls = false
    else if (r === '/' && !cls) {
      j++
      while (j < n && isId(src[j])) j++
      return { end: j, closed: true }
    }
    j++
  }
  return { end: j, closed: false }
}

function scanImports(src) {
  const specifiers = []
  let dynamic = false
  const n = src.length
  let i = 0
  let prevWord = ''
  // one extra word of lookbehind, for `for await (` (see stmtHead). Stale
  // values are harmless: it is read only when prevWord === 'await', which only
  // the word branch can set — and that branch always refreshes it.
  let prevPrevWord = ''
  // last significant char was `.`: the next word is a property NAME (an
  // operand, never a keyword)
  let prevDot = false
  let importCall = false
  // `import . source (` / `import . defer (` phase sequences: importDot marks
  // the dot right after the `import` keyword, importPhase the recognized
  // property — only a `(` directly after it arms the same call handling as
  // `import(`. Any other property (`import.meta`, `import.meta.resolve`)
  // arms nothing and stays inert.
  let importDot = false
  let importPhase = false
  // a line terminator was crossed since the last significant token (a
  // multi-line /* */ comment counts, like the grammar): a ++/-- there is
  // PREFIX by construction — [no LineTerminator here] forbids postfix — so
  // it must land in non-expression position instead of staying transparent
  let nlBefore = false
  // expression-position tracking: `/` is division only after a token that can
  // end an expression (identifier operand, number, string/template, `]`, and
  // `)` unless it closes a statement-head condition); `++`/`--` leave the
  // state untouched — postfix keeps the operand's expression-end, prefix
  // keeps the non-expression position of whatever preceded it
  let exprEnd = false
  // true = statement-head paren (see STMT_HEAD)
  const parens = []
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') { const e = lineEnd(src, i); i = e === -1 ? n : e; continue }
    if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2)
      const end = e === -1 ? n : e + 2
      if (LINE_TERM.test(src.slice(i + 2, end))) nlBefore = true
      i = end
      continue
    }
    if (c === '/' && !exprEnd) {
      if (importCall) { dynamic = true; importCall = false }
      const rx = scanRegex(src, i)
      if (!rx.closed) dynamic = true
      // universal swallow guard: rounds 8-10 each found a new mis-judged entry
      // position whose phantom regex could eat a real import with no EOL
      // trigger, so EVERY scan whose body holds a quote or the `import` token
      // flags dynamic. Genuine quote-bearing regexes pay resume for the
      // guarantee (loud refusal; fresh runs unaffected) — deliberate trade.
      else if (/['"`]|\bimport\b/.test(src.slice(i + 1, rx.end))) dynamic = true
      exprEnd = rx.closed
      prevWord = ''
      prevDot = false
      importDot = false
      importPhase = false
      nlBefore = false
      i = rx.end
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      let value = ''
      let hadEscape = false
      while (j < n && src[j] !== c && !isStrEol(src[j])) {
        if (src[j] === '\\') { hadEscape = true; value += src[j + 1] ?? ''; j += 2 } else value += src[j++]
      }
      // no closing quote before EOL/EOF: only a mis-lex reaches here (see above)
      // — fail toward dynamic instead of trusting whatever the scan swallowed
      if (j >= n || src[j] !== c) {
        dynamic = true
        prevWord = ''
        prevDot = false
        importDot = false
        importPhase = false
        nlBefore = false
        importCall = false
        exprEnd = false
        i = j
        continue
      }
      j++
      let k = j
      while (k < n && /\s/.test(src[k])) k++
      // a specifier containing escapes is not decoded here — flag dynamic (loud
      // resume refusal) instead of hashing the wrong path
      if (importCall) {
        if (src[k] !== ')' && src[k] !== ',') dynamic = true
        else if (hadEscape) dynamic = true
        else specifiers.push(value)
      } else if (prevWord === 'from' || prevWord === 'import') {
        if (hadEscape) dynamic = true
        else specifiers.push(value)
      }
      prevWord = ''
      prevDot = false
      importDot = false
      importPhase = false
      nlBefore = false
      importCall = false
      exprEnd = true
      i = j
      continue
    }
    if (c === '`') {
      if (importCall) dynamic = true
      // Interpolations are executable code we don't fully lex — collect their
      // code and conservatively flag dynamic if it mentions import at all.
      // Quoted spans, comments, regex bodies, and nested templates inside an
      // interpolation are skipped escape-aware (their text is inert, and a '}'
      // inside them must not pop the brace counter early). A quoted span or
      // regex that hits EOL/EOF unterminated, or a template still open at EOF,
      // is a mis-lex of unloadable source — flag dynamic.
      let j = i + 1
      let expr = ''
      // stack: 't' = template text (outer or nested), number = interp brace depth
      const stack = ['t']
      let iExprEnd = false // same expression-position heuristic as the outer lexer
      let iPrevWord = '' // and the same statement-head paren tracking
      let iPrevPrevWord = '' // and for-await lookbehind
      let iPrevDot = false // and property-name dot tracking
      let iNlBefore = false // and the same ASI prefix-after-newline rule for ++/--
      const iParens = []
      while (j < n && stack.length) {
        const t = src[j]
        const top = stack[stack.length - 1]
        if (top === 't') {
          if (t === '\\') { j += 2; continue }
          if (t === '`') { stack.pop(); iExprEnd = true; iPrevWord = ''; iPrevDot = false; iNlBefore = false; j++; continue }
          if (t === '$' && src[j + 1] === '{') { stack.push(1); iExprEnd = false; iPrevWord = ''; iPrevDot = false; iNlBefore = false; j += 2; continue }
          j++
          continue
        }
        if (t === "'" || t === '"') {
          let k = j + 1
          while (k < n && src[k] !== t && !isStrEol(src[k])) k += src[k] === '\\' ? 2 : 1
          if (k >= n || src[k] !== t) { dynamic = true; j = k } else { iExprEnd = true; j = k + 1 }
          iPrevWord = ''
          iPrevDot = false
          iNlBefore = false
          continue
        }
        if (t === '`') { stack.push('t'); j++; continue }
        if (t === '/' && src[j + 1] === '/') { const e = lineEnd(src, j); j = e === -1 ? n : e; continue }
        if (t === '/' && src[j + 1] === '*') {
          const e = src.indexOf('*/', j + 2)
          const end = e === -1 ? n : e + 2
          if (LINE_TERM.test(src.slice(j + 2, end))) iNlBefore = true
          j = end
          continue
        }
        if (t === '/' && !iExprEnd) {
          const rx = scanRegex(src, j)
          if (!rx.closed) dynamic = true
          // universal swallow guard, same as the outer lexer
          else if (/['"`]|\bimport\b/.test(src.slice(j + 1, rx.end))) dynamic = true
          iExprEnd = rx.closed
          iPrevWord = ''
          iPrevDot = false
          iNlBefore = false
          j = rx.end
          continue
        }
        if (t === '\\') { j += 2; continue }
        if (isId(t)) {
          let k = j
          while (k < n && isId(src[k])) k++
          const word = src.slice(j, k)
          expr += word
          if (iPrevDot) { iPrevWord = ''; iExprEnd = true }
          else { iPrevPrevWord = iPrevWord; iPrevWord = word; iExprEnd = !NONEXPR.has(word) }
          iPrevDot = false
          iNlBefore = false
          j = k
          continue
        }
        if (/\s/.test(t)) { if (isLineTerm(t)) iNlBefore = true; expr += t; j++; continue }
        if ((t === '+' || t === '-') && src[j + 1] === t) {
          // prefix-after-newline, same as the outer lexer's ++/-- rule
          if (iNlBefore) iExprEnd = false
          iNlBefore = false
          expr += t + t
          iPrevWord = ''
          iPrevDot = false
          j += 2
          continue
        }
        if (t === '{') stack[stack.length - 1]++
        else if (t === '}' && --stack[stack.length - 1] === 0) { stack.pop(); j++; continue }
        // eval( / Function( — same runtime-code-construction rule as the
        // outer lexer (a dot-property eval/Function cleared iPrevWord above);
        // require( likewise: interpolations never extract specifiers, so any
        // require call inside one flags dynamic
        if (t === '(' && (iPrevWord === 'eval' || iPrevWord === 'Function' || iPrevWord === 'require')) dynamic = true
        if (t === '(') iParens.push(stmtHead(iPrevWord, iPrevPrevWord))
        expr += t
        iPrevWord = ''
        iPrevDot = t === '.'
        iNlBefore = false
        if (t === ')' && iParens.length && iParens.pop()) iExprEnd = false
        else iExprEnd = t === ')' || t === ']'
        j++
      }
      if (stack.length) dynamic = true
      // any import mention — import(), import.source(), import.defer() alike —
      // flags dynamic: interpolations never extract specifiers
      if (/\bimport\b/.test(expr)) dynamic = true
      prevWord = ''
      prevDot = false
      importDot = false
      importPhase = false
      nlBefore = false
      importCall = false
      exprEnd = true
      i = j
      continue
    }
    if (isId(c)) {
      if (importCall) { dynamic = true; importCall = false }
      let j = i
      while (j < n && isId(src[j])) j++
      const word = src.slice(i, j)
      // after `.` the word is a property NAME, not a keyword: obj.return / 2
      // is division, x.if(y) opens a call paren, obj.import(x) is not import()
      // — but `source`/`defer` right after the `import` keyword's dot is the
      // phase property, whose `(` behaves like import( (import.meta stays inert)
      if (prevDot) { importPhase = importDot && (word === 'source' || word === 'defer'); prevWord = ''; exprEnd = true }
      else { importPhase = false; prevPrevWord = prevWord; prevWord = word; exprEnd = !NONEXPR.has(word) }
      importDot = false
      prevDot = false
      nlBefore = false
      i = j
      continue
    }
    if (/\s/.test(c)) { if (isLineTerm(c)) nlBefore = true; i++; continue }
    if (c === '(' && (prevWord === 'import' || prevWord === 'require' || importPhase)) importCall = true
    else if (importCall) { dynamic = true; importCall = false }
    // runtime code construction: eval( / Function( can execute imports the
    // scan cannot see (their string arguments stay inert by design) — flag
    // dynamic. Bare Function('...') is the same constructor as new
    // Function(...) (ES 20.2.1.1), so no preceding `new` is required.
    // Property access (obj.eval(), obj.Function()) never reaches here: after
    // `.` the word branch cleared prevWord.
    if (c === '(' && (prevWord === 'eval' || prevWord === 'Function')) dynamic = true
    if (c === '(') parens.push(stmtHead(prevWord, prevPrevWord))
    importDot = c === '.' && prevWord === 'import'
    importPhase = false
    prevWord = ''
    prevDot = c === '.'
    // ++/-- are TRANSPARENT to expression state on one line: postfix follows an
    // operand (exprEnd already true — stays true, `a++ / 2` is division) while
    // prefix precedes one (exprEnd false — stays false, so `/` after `++/re/.x`
    // enters the guarded regex scan instead of silent division); consumed as one
    // token so `a+++b` degrades to `++` then `+`, like the grammar. Across a
    // line terminator the grammar GUARANTEES prefix ([no LineTerminator here]
    // forbids postfix), so the carried expression-end is dropped — ASI's
    // `a NEWLINE ++/re/` lexes a regex, never a phantom division
    if ((c === '+' || c === '-') && d === c) { if (nlBefore) exprEnd = false; nlBefore = false; i += 2; continue }
    nlBefore = false
    // an unbalanced `)` (empty stack: mid-snippet lex) keeps the old
    // division-position guess
    if (c === ')' && parens.length && parens.pop()) exprEnd = false
    else exprEnd = c === ')' || c === ']'
    i++
  }
  return { specifiers, dynamic }
}

// Node's module-resolution mode: by default the ESM loader canonicalizes
// symlinks, but under --preserve-symlinks it resolves specifiers LEXICALLY
// against the symlink path itself — hashing must follow the same rule or flowition
// validates a different file than Node loads. Node treats this as a BOOLEAN
// flag: the bare token or ANY --preserve-symlinks=<value> spelling ENABLES,
// and ANY --no-preserve-symlinks[=<value>] spelling NEGATES — the value is
// ignored on BOTH forms (=false, =0, and =junk still enable; --no-…=false
// still negates). Both are honored from the command line
// and NODE_OPTIONS, and NODE_OPTIONS may double-quote a token — so parse,
// don't string-match: NODE_OPTIONS is tokenized quote-aware, NODE_OPTIONS
// tokens apply before execArgv (command line wins, Node's own precedence),
// and within the combined list the last mention wins. Node also accepts '_'
// anywhere '-' appears in an option NAME (--preserve_symlinks and mixed
// spellings alias the dash form), so the name portion is normalized before
// matching — the value after '=' is untouched. The separate
// --preserve-symlinks-main / --no-preserve-symlinks-main flags only affect
// the main entry and never match, underscore spellings included.
// Exported for direct testing (process.execArgv is fixed at spawn).
export function preserveSymlinksFlag(execArgv, nodeOptions) {
  const tokens = []
  let cur = null
  let quoted = false
  for (const ch of nodeOptions ?? '') {
    if (ch === '"') { quoted = !quoted; cur ??= ''; continue }
    if (!quoted && /\s/.test(ch)) { if (cur !== null) tokens.push(cur); cur = null; continue }
    cur = (cur ?? '') + ch
  }
  if (cur !== null) tokens.push(cur)
  let enabled = false
  for (const tok of [...tokens, ...execArgv]) {
    const eq = tok.indexOf('=')
    const name = (eq === -1 ? tok : tok.slice(0, eq)).replaceAll('_', '-')
    if (name === '--preserve-symlinks') enabled = true
    else if (name === '--no-preserve-symlinks') enabled = false
  }
  return enabled
}
const PRESERVE_SYMLINKS = preserveSymlinksFlag(process.execArgv, process.env.NODE_OPTIONS)

// Hash the entry file plus every reachable local (relative or absolute path)
// static, literal-dynamic, or literal-require import — resuming against a
// changed dependency would silently fork history. Computed imports/requires
// cannot be hashed; they are flagged so resume refuses loudly instead of
// validating unsoundly.
function moduleGraphHash(entry) {
  const seen = new Map()
  let dynamic = false
  const visit = (lex) => {
    // Node canonicalizes symlinked ESM modules: a symlinked entry/dep loads its
    // nested deps relative to the TARGET directory. Hash the realpath, resolve
    // relative specifiers against ITS dirname, and dedup on it so a file reached
    // via two symlink routes hashes once. Lexical fallback when realpath throws
    // (nonexistent path lands in the unreadable entry below either way). Under
    // --preserve-symlinks Node itself resolves lexically — canonicalization is
    // skipped entirely so the hash tracks the files Node actually loads.
    let f = lex
    if (!PRESERVE_SYMLINKS) { try { f = fs.realpathSync(lex) } catch { /* keep lexical */ } }
    if (seen.has(f)) return
    let buf
    try { buf = fs.readFileSync(f) } catch { seen.set(f, 'unreadable'); return }
    // hash the RAW BYTES: utf8 decoding is lossy (every invalid sequence
    // collapses to U+FFFD), so two distinct binaries — wasm LEB128 payloads or
    // custom-section bytes — could decode to identical strings and let an
    // edited dep resume silently. Valid-UTF-8 files hash identically either
    // way, so journals recorded under the string hash still match.
    seen.set(f, sha256(buf))
    // .wasm deps (source-phase imports) are hashed like any other file but
    // never lexed for nested imports: their bytes are not JS, and a stray
    // quote byte would trip the unterminated-string fail-safe and spuriously
    // poison resume
    if (f.toLowerCase().endsWith('.wasm')) return
    const scan = scanImports(buf.toString('utf8'))
    if (scan.dynamic) dynamic = true
    for (const s of scan.specifiers) {
      // strip URL query/fragment (valid in ESM specifiers) before touching the fs
      const clean = s.split(/[?#]/)[0]
      if (clean.startsWith('file:')) {
        try { visit(fileURLToPath(clean)) } catch { dynamic = true }
        continue
      }
      if (!/^\.{0,2}\//.test(clean)) continue
      // Node URL-DECODES relative specifiers ('./dep%20x.js' loads 'dep x.js'):
      // resolving the encoded text would hash a nonexistent path as a stable
      // 'unreadable' and let the real dep change under a resume. (The file:
      // branch already decodes inside fileURLToPath.) A malformed
      // percent-sequence means Node itself would fail the import — flag
      // dynamic (loud) rather than guess at a path.
      let decoded
      try { decoded = decodeURIComponent(clean) } catch { dynamic = true; continue }
      visit(path.resolve(path.dirname(f), decoded))
    }
  }
  visit(entry)
  return {
    hash: sha256([...seen.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([f, h]) => f + ':' + h).join('\n')),
    dynamic,
  }
}

// Deterministic call-site identity for workflow-origin sends: the first stack
// frame OUTSIDE flowition's own src files — the position (file:line:column) of the
// workflow's sendTo()/handle-send call. Resume validation pins the workflow
// file and its import graph byte-for-byte (fileHash + graphHash), so the
// position is stable across replays; the module-load cache-buster query
// (?flowition=…) is stripped by the URL parse. Null when no frame resolves (direct
// API callers, exotic stacks) — the identity then degrades one legacy level
// (sender-without-callsite), duplicating rather than suppressing under
// uncertainty.
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url))
function wfCallsite() {
  for (const frame of (new Error().stack ?? '').split('\n').slice(1)) {
    // `at fn (<pos>)` and bare `at [async] <pos>` frame shapes; the paren form
    // is tried first so a function name can never bleed into the position
    const m = /\((.*?):(\d+):(\d+)\)\s*$/.exec(frame) ?? / at (?:async )?(.*?):(\d+):(\d+)\s*$/.exec(frame)
    if (!m) continue
    let file = m[1]
    if (file.startsWith('file://')) { try { file = fileURLToPath(new URL(file)) } catch { continue } }
    if (file.startsWith('node:') || file === SRC_DIR || file.startsWith(SRC_DIR + path.sep)) continue
    return file + ':' + m[2] + ':' + m[3]
  }
  return null
}

// A .js workflow in a CommonJS package scope is parsed as CJS and dies on its
// first `export`/`import` with a bare SyntaxError that names the token but not
// the cause — likelier than it sounds, since `npm init -y` next to a workflow
// (our own editor-autocomplete advice) writes "type": "commonjs". Diagnose only
// when the format really resolved to CommonJS: SyntaxError over an ESM-only
// token AND the nearest package.json does not declare "type": "module". Naming
// that package.json is the detail that makes the fix findable.
function cjsScopeHint(file, err) {
  if (!(err instanceof SyntaxError) || !/\b(?:export|import)\b/.test(String(err.message))) return ''
  if (path.extname(file) !== '.js') return ''
  const fix = 'workflow files are ES modules'
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    let pkg
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { pkg = null }
    if (pkg) {
      if (pkg.type === 'module') return ''
      const scope = pkg.type ? `sets "type": "${pkg.type}"` : 'has no "type" field'
      return ` — ${fix}, but ${path.join(dir, 'package.json')} ${scope}, so Node parsed this .js file as CommonJS; add "type": "module" to that package.json or rename the workflow to .mjs`
    }
    if (dir === path.dirname(dir)) return ` — ${fix}, but Node parsed this .js file as CommonJS; add "type": "module" to a package.json next to the workflow or rename it to .mjs`
  }
}

export async function runWorkflow(opts) {
  const file = path.resolve(opts.file)
  const defaults = { adapter: 'claude', ...opts.defaults }

  const runId = opts.resumeId ?? opts.runId ?? shortId('flo')
  // runDir() validates the id (no path separators, no leading dot) — surface a
  // crafted --run-id/resume id as a clean WorkflowError before any fs prep.
  let dir
  try { dir = runDir(runId) } catch (err) { throw new WorkflowError(err.message) }
  const scratch = path.join(dir, 'scratch')
  // A RESUME never creates anything under runs/<id> — not the run dir, not scratch —
  // before it owns the run (DESIGN §7.3.3). A recursive ensureDir here would resurrect
  // `runs/<id>` in the instant after retention has renamed it into the trash, so the
  // delete's rollback would find the name taken and fail: the real journal stranded in
  // trash, a stub at the original path. Requiring the directory to already exist makes
  // the delete's rename the only linearization point, exactly as run-lock.js documents.
  if (opts.resumeId) {
    let st = null
    try { st = fs.lstatSync(dir) } catch { /* gone or never existed */ }
    if (!st?.isDirectory()) throw new WorkflowError(`run ${runId} does not exist — nothing to resume`)
  } else {
    ensureDir(dir, 0o700)
  }
  // Run dirs made by older flowition versions (or a launcher racing an inherited umask) may
  // sit at 0755 — tighten best-effort at the ownership point, before the lock.
  try { fs.chmodSync(dir, 0o700) } catch { /* non-posix fs */ }
  // The lock comes before ANY journal read: even the strict loader's torn-tail
  // repair must never touch a journal another engine is actively writing. It is also
  // where a resume takes ownership — a lock write into a directory that moved fails
  // with ENOENT rather than recreating it, so the delete still wins that ordering.
  const runLock = acquireRunLock(dir, { resuming: Boolean(opts.resumeId), runId })
  // Ownership established: now the run's working directories may be (re)created.
  ensureDir(scratch, 0o700)
  try { fs.chmodSync(scratch, 0o700) } catch { /* non-posix fs */ }
  const releaseLock = () => runLock.release()
  let control = null

  try {
    const journal = new Journal(dir)
    const events = new EventSink(dir, { quiet: opts.quiet })

    const finalize = (outcome) => {
      // tmp+rename: a reader must never observe a truncated result.json (it would
      // classify a healthy run as corrupt-result, which is terminal to supervisors)
      const tmp = path.join(dir, `.result.json.${process.pid}.tmp`)
      fs.writeFileSync(tmp, JSON.stringify(outcome, null, 2))
      fs.renameSync(tmp, path.join(dir, 'result.json'))
      events.emit({ type: 'run', runId, state: outcome.status, error: outcome.error })
      return outcome
    }

    // Declared before the control server: its handlers close over these.
    const live = new Map() // index -> AgentJob
    const labels = new Map() // label -> index (live only)
    const pendingQuestions = new Map() // qid -> {question, resolve}
    const explicitKeys = new Set()
    // index -> the identity fields captured when the agent was admitted to the
    // queue (E1/E2), so emit sites without an ALS context — the control socket's
    // `steered` event, the progress timer — can still stamp phase/path.
    const agentInfo = new Map()
    // Run-scoped monotonic phase counter (E1). JS increments are atomic, so
    // concurrent branches can share it; identity is the index, titles repeat legally.
    let phaseCounter = 0
    const phaseByTitle = new Map() // title -> most recent phaseIndex (for `AgentOptions.phase`)
    const usedQids = new Set()
    const usageTotal = { input: 0, output: 0, cost: 0 }
    const inFlight = new Set()
    let agentCount = 0
    let aborted = false
    let finishing = false // lifecycle closing — no new agents may be admitted
    let nextIndex = 0
    const binPath = fileURLToPath(new URL('../bin/flowition.js', import.meta.url))
    const sockPath = path.join(dir, 'control.sock')

    function abortRun(reason) {
      if (aborted) return
      aborted = true
      events.emit({ type: 'log', source: 'engine', level: 'warn', message: `aborting run: ${reason}` })
      for (const job of live.values()) job.cancel()
      for (const q of pendingQuestions.values()) q.reject?.(new WorkflowError('run aborted'))
    }

    function findJob(sel) {
      if (live.has(Number(sel))) return live.get(Number(sel))
      if (labels.has(String(sel))) return live.get(labels.get(String(sel)))
      return null
    }

    // E8: the `steered` annotation for a send, stamped with the identity captured at
    // admission — neither the control socket nor sendTo() runs under the TARGET
    // agent's ALS context, so agentInfo is the only source of its phase.
    const emitSteered = (job, delivery, mailId) => {
      const info = agentInfo.get(job.index)
      events.emit({
        type: 'agent', index: job.index, label: job.label, adapter: job.adapter.name,
        state: 'steered', delivery, mailId: mailId ?? null,
        phase: info?.phase ?? null, phaseIndex: info?.phaseIndex ?? null,
      })
    }

    // `post` carries an agent index over the wire, where the CLI's env default arrives
    // as a STRING ("0") — coerce to a real integer index or null, so MailView.agent is
    // never a string that fails to join to an agent (E8).
    const toIndex = (v) => {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
      return Number.isInteger(n) ? n : null
    }

    // The control socket binds BEFORE any journal read or destructive prep: the
    // run lock is the first exclusivity gate, but its stale-reclaim path has
    // unavoidable micro-races with fs primitives — the socket's atomic bind (plus
    // live-probe refusal) is the arbiter that also protects the prep phase.
    control = serveControl(sockPath, (req) => {
      switch (req.cmd) {
        case 'status': {
          return {
            ok: true,
            runId,
            state: 'running',
            agents: [...live.values()].map((j) => ({ index: j.index, label: j.label, adapter: j.adapter.name, model: j.spec.model ?? null, lastTool: j.lastTool, lastOutputAt: j.lastOutputAt ?? null, queuedMail: j.mailQueue.length, sessionId: j.sessionId })),
            questions: [...pendingQuestions.entries()].map(([qid, q]) => ({ qid, question: q.question })),
            spentOutputTokens: usageTotal.output,
          }
        }
        case 'send': {
          const job = findJob(req.agent)
          if (!job) return { error: `no live agent "${req.agent}" (use \`flowition status\` for indices/labels)` }
          const out = {}
          const delivery = job.send(String(req.message), 'operator', null, null, out)
          emitSteered(job, delivery, out.mailId)
          events.emit({ type: 'mail', agent: job.index, dir: 'in', message: String(req.message), delivery, mailId: out.mailId ?? null })
          return { ok: true, delivery }
        }
        case 'answer': {
          const q = pendingQuestions.get(req.qid)
          if (!q) return { error: `no pending question "${req.qid}"` }
          pendingQuestions.delete(req.qid)
          journal.append({ type: 'answer', qid: req.qid, value: req.value })
          // E7: the value is already on disk in the journal — same sensitivity class.
          events.emit({ type: 'answer', qid: req.qid, value: req.value })
          q.resolve(req.value)
          return { ok: true }
        }
        case 'cancel': {
          if (req.agent != null) {
            const job = findJob(req.agent)
            if (!job) return { error: `no live agent "${req.agent}"` }
            job.cancel()
            return { ok: true, cancelled: job.index }
          }
          abortRun('cancel requested via control socket')
          return { ok: true, cancelled: 'run' }
        }
        case 'post': {
          // G14: the `mail-out` kind has been documented since the transcript was
          // written and never emitted — an agent's own progress reports were invisible
          // in its transcript. Written only while the sender is live; a post from a
          // settled (or unknown) agent still lands in the event stream.
          const agent = toIndex(req.agent)
          const message = String(req.message)
          const job = agent != null ? findJob(agent) : null
          if (job) job.transcript.write('mail-out', { text: message })
          events.emit({ type: 'mail', agent, dir: 'out', message })
          return { ok: true }
        }
        default:
          return { error: `unknown command "${req.cmd}"` }
      }
    })
    try {
      await control.ready
    } catch (err) {
      const contended = /already active/.test(String(err?.message))
      const msg = contended
        ? `run ${runId} is already active (its control socket is answering) — refusing concurrent execution`
        : `control socket unavailable: ${err.message}`
      // A fresh detached run dying here would otherwise leave no journal,
      // heartbeat, or result.json — supervisors would see "unknown" forever.
      // Contention and resume must write NOTHING: the run belongs to the live
      // engine / the prior attempt.
      if (!contended && !opts.resumeId && !journal.exists()) {
        journal.append({ type: 'end', status: 'failed', error: msg })
        finalize({ runId, status: 'failed', error: msg })
      }
      throw new WorkflowError(msg)
    }

    // The launcher stamped the detached-resume marker at SPAWN, but the marker's
    // 30s budget must cover preflight — whose heavy synchronous work (the
    // module-graph scan) starts here. Re-stamp its mtime now that the bind gate
    // proved this engine owns the run, so the budget runs from bind instead.
    if (opts.resumeId) {
      const bound = new Date()
      try { fs.utimesSync(path.join(dir, '.resuming'), bound, bound) } catch { /* no marker (attached resume) */ }
    }

    // Sweep leftover scratch files from
    // crashed turns BEFORE resume validation — scratch is per-turn temp state
    // never read on resume, and a refused resume must not strand it forever.
    let leftovers = []
    try { leftovers = fs.readdirSync(scratch) } catch { /* fine */ }
    for (const f of leftovers) { try { fs.unlinkSync(path.join(scratch, f)) } catch { /* leave it */ } }

    // A fresh run must never touch an existing run's journal — not even to record
    // its own failure (explicit --run-id reuse or a shortId collision would mix
    // epochs). Checked before anything can write.
    if (!opts.resumeId && journal.exists()) {
      throw new WorkflowError(`run ${runId} already has a journal — resume it with \`flowition resume ${runId}\` or pick a different --run-id`)
    }

    // Read the workflow source. A fresh (possibly detached) run must record a
    // terminal outcome even for an unreadable entry file; a resume precondition
    // failure must instead leave the existing run's state untouched.
    let source
    try { source = fs.readFileSync(file, 'utf8') } catch (err) {
      const msg = `cannot read workflow file ${file}: ${err.message}`
      if (!opts.resumeId) {
        journal.append({ type: 'end', status: 'failed', error: msg })
        finalize({ runId, status: 'failed', error: msg })
      }
      throw new WorkflowError(msg)
    }
    const fileHash = sha256(source)
    const graph = moduleGraphHash(file)
    const graphHash = graph.hash

    let prior = null
    if (opts.resumeId) {
      try { prior = Journal.load(dir, { repair: true }) } catch (err) {
        throw new WorkflowError(`cannot resume ${runId}: ${err.message}`)
      }
      if (!prior.meta) throw new WorkflowError(`no journal found for run ${runId}`)
      if (prior.meta.keyVersion !== K.KEY_VERSION) throw new WorkflowError(`cannot resume: run was recorded with resume-key version ${prior.meta.keyVersion}, this flowition uses ${K.KEY_VERSION} (results would not be found — start a fresh run)`)
      if (prior.meta.fileHash !== fileHash) throw new WorkflowError('cannot resume: the workflow file has changed since the original run (start a fresh run)')
      if (prior.meta.graphHash !== graphHash) throw new WorkflowError('cannot resume: a module imported by the workflow file has changed since the original run (start a fresh run)')
      if (graph.dynamic || prior.meta.graphDynamic) throw new WorkflowError('cannot resume: the module graph cannot be verified — the workflow (or a local dep) contains a computed dynamic import()/require(), an eval()/Function() construction, or a construct the import lexer flags conservatively (e.g. a quote-bearing regex; see the import-scanner notes under "Known limitations" in ARCHITECTURE.md) — make imports/requires static literals and avoid eval/Function to enable resume')
      if (canonical(prior.meta.args ?? null) !== canonical(opts.args ?? null)) throw new WorkflowError('cannot resume: --args differ from the original run')
      // Explicit null args and absent args are different workflow inputs even
      // though they canonicalize identically ('args' is present only for new-
      // format journals; legacy metas always wrote null).
      if ('graphDynamic' in prior.meta && ('args' in prior.meta) !== (opts.args !== undefined)) {
        throw new WorkflowError('cannot resume: --args presence differs from the original run (explicitly passing null is not the same as passing nothing)')
      }
      // Different defaults would derive different agent keys — every cached result
      // would miss and side-effecting agents would silently re-run.
      const norm = (d) => canonical(JSON.parse(JSON.stringify(d ?? null)))
      if (norm(prior.meta.defaults) !== norm(defaults)) throw new WorkflowError('cannot resume: defaults (adapter/model/effort/cwd) differ from the original run — omit the overrides or start a fresh run')
    }

    const concurrency = opts.concurrency ?? 8
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new WorkflowError('concurrency must be an integer >= 1')
    // The budget is part of the run, not the invocation: restore it on resume
    // unless explicitly overridden.
    const budgetTotal = opts.budgetTotal ?? prior?.meta.budgetTotal ?? null
    if (budgetTotal != null && (!Number.isInteger(budgetTotal) || budgetTotal < 0)) throw new WorkflowError('budget must be an integer >= 0')

    // This invocation now owns the run: clear stale terminal state (supervisors
    // must see the resumed run as live, not the previous attempt's outcome).
    // Kept AFTER the resume validations — a refused resume must not clear the
    // previous terminal result. The launcher's detached-resume marker is cleared
    // HERE, not after socket bind: until result.json is unlinked the marker must
    // keep readers from trusting the old terminal result (a CPU-blocked event
    // loop — e.g. the graph scan — can outlast their 300ms socket probe). A
    // refused/contended resume leaves the marker to age out (30s "starting").
    try { fs.unlinkSync(path.join(dir, '.resuming')) } catch { /* no handoff */ }
    try { fs.unlinkSync(path.join(dir, 'result.json')) } catch { /* none */ }

    const seed = prior?.meta.seed ?? crypto.randomBytes(8).toString('hex')
    const createdAt = prior?.meta.createdAt ?? Date.now()
    if (!prior) {
      journal.append({ type: 'meta', runId, workflowFile: file, fileHash, graphHash, graphDynamic: graph.dynamic, ...(opts.args !== undefined ? { args: opts.args } : {}), seed, createdAt, keyVersion: K.KEY_VERSION, defaults, budgetTotal })
    }
    if (prior?.repaired) events.emit({ type: 'log', source: 'engine', level: 'warn', message: 'journal had a torn final record (crash mid-write) — repaired' })

    const hb = setInterval(() => { try { fs.writeFileSync(path.join(dir, '.heartbeat'), String(Date.now())) } catch { /* dir gone */ } }, 5000)
    hb.unref?.()
    try { fs.writeFileSync(path.join(dir, '.heartbeat'), String(Date.now())) } catch { /* dir gone */ }

    // E6: throttled per-agent progress — one sweep per window over the LIVE jobs,
    // emitting only for agents whose REAL provider output moved since their last
    // emitted event. `outputRev` (agent-proc) counts only real output: turn start
    // initializes lastOutputAt without bumping it, so an agent that has emitted
    // nothing is skipped entirely and a SILENT AGENT PRODUCES NO PROGRESS EVENTS —
    // the empty `progressSeen` map must never treat the turn-start baseline as a
    // change. The timer never writes lastOutputAt: it reports the provider's own
    // last-output stamp, so an agent that has gone quiet still reads as quiet and
    // the client's stallMs warning stays honest.
    const progressSeen = new Map() // index -> last emitted output revision
    const progressTimer = setInterval(() => {
      for (const job of live.values()) {
        if (!job.outputRev) continue // admitted (or running) but the provider has said nothing
        if (progressSeen.get(job.index) === job.outputRev) continue
        progressSeen.set(job.index, job.outputRev)
        const snap = { tool: job.lastTool ?? null, outputTokens: job.usage.output, lastOutputAt: job.lastOutputAt }
        // telemetry must never take the run down (a full disk, a vanished dir)
        try { events.emit({ type: 'agent', state: 'progress', index: job.index, key: job.key, ...snap }) } catch { /* best effort */ }
      }
    }, PROGRESS_MS)
    progressTimer.unref?.()

    // Module loading is inside the run lifecycle: a syntax error or missing export
    // must still produce a terminal journal record and result.json.
    let fn, meta
    try {
      const mod = await import(pathToFileURL(file).href + '?flowition=' + Date.now())
      meta = mod.meta ?? {}
      fn = mod.default
      if (typeof fn !== 'function') throw new WorkflowError('workflow must `export default` an async function taking the toolkit')
    } catch (err) {
      const msg = String(err?.message ?? err) + cjsScopeHint(file, err)
      journal.append({ type: 'end', status: 'failed', error: msg })
      clearInterval(hb)
      clearInterval(progressTimer)
      finalize({ runId, status: 'failed', error: msg })
      throw err instanceof WorkflowError ? err : new WorkflowError(`workflow module failed to load: ${msg}`)
    }

    const sem = new Semaphore(concurrency)
    // Seed with ALL journaled spend — failed/cancelled attempts AND completed
    // results: that cost is real and must keep counting against the budget
    // across resumes even when resumed control flow never revisits a completed
    // key (the cache-hit path deliberately adds nothing).
    usageTotal.input += (prior?.failedUsage.input ?? 0) + (prior?.completedUsage.input ?? 0)
    usageTotal.output += (prior?.failedUsage.output ?? 0) + (prior?.completedUsage.output ?? 0)
    usageTotal.cost += (prior?.failedUsage.cost ?? 0) + (prior?.completedUsage.cost ?? 0)
    nextIndex = (prior?.maxIndex ?? -1) + 1
    const rootBranch = K.rootCtx(seed).branch

    const budget = {
      total: budgetTotal,
      spent: () => usageTotal.output,
      remaining: () => (budgetTotal == null ? Infinity : Math.max(0, budgetTotal - usageTotal.output)),
    }

    // E1. `AgentOptions.phase` overrides the ambient phase for one agent. A title
    // that no phase() call has declared yet gets its own index and a `phase` event
    // (marked `implicit`) so the group the agent claims actually exists for readers;
    // a title already declared reuses that phase's index. Ambient phases come off
    // the ALS context, so concurrent branches never race each other.
    function resolvePhase(ctx, explicit) {
      if (explicit != null) {
        const title = String(explicit)
        if (!phaseByTitle.has(title)) {
          const phaseIndex = phaseCounter++
          phaseByTitle.set(title, phaseIndex)
          events.emit({ type: 'phase', phaseIndex, title, implicit: true })
        }
        return { phase: title, phaseIndex: phaseByTitle.get(title) }
      }
      const p = ctx?.phase ?? null
      return { phase: p?.title ?? null, phaseIndex: p?.phaseIndex ?? null }
    }

    async function agentImpl(prompt, o = {}, onJob = null) {
      if (aborted || finishing) throw new WorkflowError('run aborted')
      if (typeof prompt !== 'string' || !prompt.trim()) throw new WorkflowError('agent() requires a non-empty prompt string')
      if (++agentCount > 1000) throw new WorkflowError('lifetime agent cap (1000) exceeded — runaway loop?')
      const ctx = K.currentCtx()
      if (!ctx) throw new WorkflowError('agent() called outside workflow context')
      // E1: the phase is captured HERE, at agentImpl entry, from the calling
      // context — NOT when the `running` event fires, which happens after
      // semaphore admission and can therefore observe a later phase() call.
      // E2: likewise the structural path, which the fan-out sites hand down.
      const { phase, phaseIndex } = resolvePhase(ctx, o.phase)
      const path = ctx.path ?? []
      const adapterName = o.adapter ?? defaults.adapter
      const adapter = getAdapter(adapterName)
      const spec = {
        model: o.model !== undefined ? o.model : (o.adapter && o.adapter !== defaults.adapter ? undefined : defaults.model),
        mode: o.mode,
        effort: o.effort ?? defaults.effort,
        system: o.system,
        schema: o.schema,
        cwd: o.cwd ?? defaults.cwd,
        stallMs: o.stallMs,
      }
      if (spec.model && !adapter.caps.acceptsModel) throw new WorkflowError(`adapter "${adapterName}" does not accept a model override`)
      const specErr = adapter.validateSpec?.(spec)
      if (specErr) throw new WorkflowError(`invalid spec for adapter "${adapterName}": ${specErr}`)
      const keyed = { adapter: adapterName, model: spec.model ?? null, mode: spec.mode ?? null, effort: spec.effort ?? null, system: spec.system ?? null, schema: spec.schema ?? null, cwd: spec.cwd ?? null }
      let key
      if (o.key != null) {
        key = K.explicitKey(String(o.key))
        if (explicitKeys.has(key)) throw new WorkflowError(`duplicate explicit key "${o.key}"`)
        explicitKeys.add(key)
      } else {
        key = K.agentKey(ctx, prompt, keyed)
      }
      const label = o.label ?? null

      const cached = prior?.results.get(key)
      if (cached && cached.status === 'completed') {
        // usage NOT added here: completed spend was pre-seeded into usageTotal
        // from Journal.load's completedUsage aggregate — charging it at replay
        // would double-count, and charging it ONLY at replay under-counted
        // whenever resumed control flow skipped a completed key entirely.
        agentInfo.set(cached.index, { key, label, adapter: adapterName, model: spec.model ?? null, phase, phaseIndex, path })
        events.emit({ type: 'agent', index: cached.index, key, label, adapter: adapterName, model: spec.model ?? null, state: 'cached', phase, phaseIndex, path })
        return cached.result
      }
      const index = prior?.indexByKey.get(key) ?? nextIndex++
      agentInfo.set(index, { key, label, adapter: adapterName, model: spec.model ?? null, phase, phaseIndex, path })
      const stallMs = spec.stallMs ?? DEFAULT_STALL_MS
      // E4: admission is observable from here on. The gauge is sampled AT the emit
      // site — release() hands a slot off directly without decrementing, so a sample
      // taken anywhere else reads a different instant.
      const queuedAt = Date.now()
      events.emit({ type: 'agent', index, key, label, adapter: adapterName, model: spec.model ?? null, state: 'queued', phase, phaseIndex, path, sem: { active: sem.active, queued: sem.queued, limit: sem.limit } })

      return sem.with(async () => {
        const waitMs = Date.now() - queuedAt
        // A queued agent whose run aborts (or whose budget runs out) before
        // admission must not stay `queued` forever: emit its terminal event
        // before propagating — the job that would have carried one never exists.
        const preAdmission = (state, err) => {
          events.emit({ type: 'agent', index, key, label, adapter: adapterName, model: spec.model ?? null, state, phase, phaseIndex, error: String(err.message), code: err.code ?? null, retryable: !!err.retryable, durationMs: null, usage: null, lastOutputAt: null, waitMs })
          return err
        }
        if (aborted || finishing) throw preAdmission('cancelled', new WorkflowError('run aborted'))
        if (budget.total != null && usageTotal.output >= budget.total) throw preAdmission('failed', new WorkflowError(`budget exceeded (${usageTotal.output}/${budget.total} output tokens)`))
        journal.append({ type: 'started', key, index, label, adapter: adapterName })
        events.emit({ type: 'agent', index, key, label, adapter: adapterName, model: spec.model ?? null, effort: spec.effort ?? null, state: 'running', promptPreview: prompt.slice(0, 160), phase, phaseIndex, path, waitMs, stallMs, sem: { active: sem.active, queued: sem.queued, limit: sem.limit } })
        const resumedIndex = prior?.indexByKey.has(key) ?? false
        const transcript = new Transcript(dir, index, { fresh: !resumedIndex })
        // E9: this attempt's 1-based number — one more than the journal's result
        // records for the key (§8 E9; `results` is last-wins and hides the history,
        // hence Journal.load's attemptCounts). The machine-readable boundary goes
        // FIRST so the sentinel belongs to the attempt it opens; the sentinel stays
        // for old CLIs tailing the file.
        const attempt = (prior?.attemptCounts.get(key) ?? 0) + 1
        if (resumedIndex) {
          transcript.write('attempt', { n: attempt })
          transcript.write('status', { text: '— resumed run: new attempt below —' })
        }
        // E10: an honest cap beats a silent one — 32 KiB (the transcript's own text
        // cap) with the explicit "… [+N chars]" marker, instead of a bare slice(0,4000)
        // that made a truncated prompt indistinguishable from a short one.
        transcript.write('meta', { index, label, adapter: adapterName, model: spec.model ?? null, attempt, prompt: truncate(prompt, 32768) })
        const priorSessionId = prior?.sessions.get(key) ?? null
        // ALL pending mail is restored — the restored copy is authoritative
        // for delivery. Workflow-origin sends are usually re-issued by the
        // re-executing workflow, but not reliably: a CACHED sender replays
        // instantly and its sendTo() can fire before this job is admitted,
        // find no live job, and deliver nothing — so tombstoning the pending
        // record on the re-send assumption lost acknowledged guidance.
        // Instead the re-sends that DO happen are absorbed in send() against
        // the restored multiset below.
        const priorMail = prior?.pendingMail.get(key) ?? []
        const job = new AgentJob({
          adapter, spec, prompt, index, key, label, runId, scratch, transcript, journal,
          priorSessionId,
          pendingMail: priorMail,
          // delivered-before-the-crash workflow mail, so send() can suppress
          // the workflow's deterministic re-issues (only re-run agents get a
          // job — completed ones replay from cache — so this is precisely the
          // crash-window population)
          deliveredWorkflowMail: prior?.deliveredWorkflowMail.get(key) ?? null,
          // restored-pending workflow mail: the copy in the queue carries the
          // delivery, so a matching re-send is absorbed instead of doubling it
          restoredWorkflowMail: prior?.restoredWorkflowMail.get(key) ?? null,
          usageCum: prior?.usageCum.get(key) ?? null,
          controlSock: sockPath, binPath,
        })
        if (job.sessionId && !priorSessionId) journal.append({ type: 'session', key, sessionId: job.sessionId })
        onJob?.(job)
        live.set(index, job)
        if (label) labels.set(label, index)
        const t0 = Date.now()
        try {
          let result
          try {
            result = await job.execute()
          } catch (err) {
            if (err?.retryable && !aborted && !job.cancelled) {
              events.emit({ type: 'log', source: 'engine', level: 'warn', index, message: `agent [${index}] retrying after: ${err.message}` })
              result = await job.execute()
            } else throw err
          }
          usageTotal.input += job.usage.input
          usageTotal.output += job.usage.output
          usageTotal.cost += job.usage.cost
          const final = result.structured !== undefined ? result.structured : result.text
          journal.append({ type: 'result', key, index, status: 'completed', result: final, usage: job.usage, durationMs: Date.now() - t0, adapter: adapterName, model: spec.model ?? null })
          // The completed result record SEALS the outcome. Everything after it
          // is telemetry — a throw there must never reach the failure catch,
          // which would charge the usage a second time and append a FAILED
          // result for the same key (last-wins on replay: the completed
          // provider work would re-run on resume, duplicating side effects).
          // Telemetry errors are logged best-effort and the agent still
          // returns its completed result.
          try {
            // Sessionless deliveries become durable only now: the completed
            // result reflects the consumed mail, and completed keys replay from
            // cache so no re-send arises. Written AFTER the result record — a
            // crash before it leaves the mail pending, which is exactly right
            // (operator mail restores, workflow mail re-sends into the fresh
            // session the resumed attempt must start).
            for (const m of job.sessionlessDelivered) journal.append({ type: 'mail-done', key, id: m.id })
            transcript.write('status', { text: 'completed' })
            events.emit({ type: 'agent', index, key, label, adapter: adapterName, model: spec.model ?? null, state: 'done', phase, phaseIndex, durationMs: Date.now() - t0, outputTokens: job.usage.output, usage: job.usage, lastOutputAt: job.lastOutputAt ?? null, resultPreview: String(typeof final === 'string' ? final : JSON.stringify(final)).slice(0, 200) })
          } catch (err) {
            try { events.emit({ type: 'log', source: 'engine', level: 'error', index, message: `agent [${index}] post-completion telemetry error (completed result stands): ${err.message}` }) } catch { /* best effort */ }
          }
          return final
        } catch (err) {
          // Failed attempts still consumed tokens — charge them to the run.
          usageTotal.input += job.usage.input
          usageTotal.output += job.usage.output
          usageTotal.cost += job.usage.cost
          const status = err instanceof AgentError && err.code === 'cancelled' ? 'cancelled' : 'failed'
          journal.append({ type: 'result', key, index, status, error: String(err.message), usage: job.usage, durationMs: Date.now() - t0, adapter: adapterName, model: spec.model ?? null })
          transcript.write('status', { text: `${status}: ${err.message}` })
          // E5: a dead agent must stay diagnosable — the code the engine already
          // branched on, whether a retry was possible, what it spent, and when the
          // provider last said anything.
          events.emit({ type: 'agent', index, key, label, adapter: adapterName, model: spec.model ?? null, state: status, phase, phaseIndex, error: String(err.message), code: err?.code ?? null, retryable: !!err?.retryable, durationMs: Date.now() - t0, usage: job.usage, lastOutputAt: job.lastOutputAt ?? null })
          if (err instanceof WorkflowError) throw err
          throw new AgentFailed(`agent [${index}]${label ? ` ${label}` : ''} ${status}: ${err.message}`, err.code)
        } finally {
          job.settled = true
          live.delete(index)
          if (label && labels.get(label) === index) labels.delete(label)
        }
      })
    }

    const degrade = (err) => {
      if (err instanceof AgentFailed) return null
      throw err
    }

    // Fan-out children (E1/E2): makeCtx receives no parent context, so the creating
    // context's phase is COPIED in — a top-level phase('A') before parallel() flows
    // to every item, while a phase() call inside one branch stays in that branch —
    // and the structural path is handed down explicitly. Neither reaches key
    // derivation: makeCtx's key inputs are still (branchKey, runSeed) alone.
    const childCtx = (branch, path, parent) => {
      const c = K.makeCtx(branch, seed, path)
      c.phase = parent?.phase ?? null
      return c
    }

    const toolkit = {
      args: opts.args,
      budget,
      meta,
      agent: (prompt, o) => {
        const p = agentImpl(prompt, o)
        inFlight.add(p)
        p.catch(() => {}).finally(() => inFlight.delete(p))
        return p
      },
      // spawn() returns a handle immediately — workflow code can steer its own agents.
      // Messages sent before the semaphore admits the job are queued and delivered on start.
      spawn: (prompt, o = {}) => {
        // Replay sender identity: the CREATING context's branch, captured once
        // — every send through this handle carries it, wherever the handle
        // later travels. Each handle send additionally captures ITS OWN call
        // site (see AgentJob.send's key+sender+callsite+text+seq identity), so
        // queued mail carries the position it was sent from, not delivered at.
        const senderBranch = K.currentCtx()?.branch ?? null
        let jobRef = null
        let settled = false
        const queued = []
        // E8: a handle send is a steer like any other — emitting only for sendTo()
        // would leave spawn()-steered agents with an empty steering history.
        const handleSend = (job, text, callsite) => {
          const out = {}
          const delivery = job.send(text, 'workflow', senderBranch, callsite, out)
          emitSteered(job, delivery, out.mailId)
          events.emit({ type: 'mail', agent: job.index, dir: 'in', message: text, delivery, mailId: out.mailId ?? null })
          return delivery
        }
        const done = agentImpl(prompt, o, (job) => {
          jobRef = job
          for (const m of queued.splice(0)) handleSend(job, m.text, m.callsite)
        })
        // attached directly to `done` (before the workflow can await it) so a
        // send() right after the await already sees the settled state
        const settle = () => {
          settled = true
          // no job ever started (cache replay / pre-admission failure): queued
          // mail can never deliver — say so instead of letting it evaporate
          if (!jobRef && queued.length) events.emit({ type: 'log', source: 'engine', level: 'warn', message: `spawn: ${queued.length} queued message(s) dropped — agent replayed from cache without starting` })
        }
        done.then(settle, settle)
        inFlight.add(done)
        done.catch(() => {}).finally(() => inFlight.delete(done))
        return {
          done,
          send: (m) => {
            const callsite = wfCallsite()
            if (jobRef) return handleSend(jobRef, String(m), callsite)
            // settled with no job ever started (cache replay, pre-admission
            // failure): mirror the settled-job semantics, don't queue forever
            if (settled) return 'dropped'
            queued.push({ text: String(m), callsite })
            return 'pending'
          },
        }
      },
      parallel: async (thunks) => {
        if (!Array.isArray(thunks)) throw new WorkflowError('parallel() takes an array of thunks')
        if (thunks.length > 4096) throw new WorkflowError('parallel() accepts at most 4096 items')
        // parallel([agent(...)]) — promises instead of thunks — would resolve
        // to nulls while the agents actually ran: refuse loudly instead.
        for (const t of thunks) {
          if (typeof t !== 'function') throw new WorkflowError(`parallel() takes an array of thunks (functions returning promises) — got ${t instanceof Promise ? 'a Promise; wrap calls as () => agent(...)' : typeof t}`)
        }
        const ctx = K.currentCtx()
        // ctx and ordinal are captured BEFORE the map: `ordinal` (the creating
        // branch's fan-out counter) is what disambiguates sequential sibling
        // fanouts, and it is the same value the branch derivation consumes.
        const ordinal = ctx.fanoutIndex++
        const node = K.deriveBranch(ctx.branch, 'parallel', ordinal)
        const base = [...(ctx.path ?? []), { kind: 'parallel', ordinal, count: thunks.length }]
        events.emit({ type: 'fanout', path: base, kind: 'parallel', count: thunks.length })
        return Promise.all(
          thunks.map((t, i) =>
            K.withCtx(childCtx(K.deriveBranch(node, 'item', i), [...base, { kind: 'item', i }], ctx), () => Promise.resolve().then(t).catch(degrade)),
          ),
        )
      },
      pipeline: async (items, ...stages) => {
        if (!Array.isArray(items)) throw new WorkflowError('pipeline() takes an array of items')
        if (items.length > 4096) throw new WorkflowError('pipeline() accepts at most 4096 items')
        for (const s of stages) {
          if (typeof s !== 'function') throw new WorkflowError(`pipeline() stages must be functions — got ${s instanceof Promise ? 'a Promise; wrap calls as (prev, item) => agent(...)' : typeof s}`)
        }
        const ctx = K.currentCtx()
        const ordinal = ctx.fanoutIndex++
        const node = K.deriveBranch(ctx.branch, 'pipeline', ordinal)
        const base = [...(ctx.path ?? []), { kind: 'pipeline', ordinal, count: items.length, stages: stages.length }]
        events.emit({ type: 'fanout', path: base, kind: 'pipeline', count: items.length, stages: stages.length })
        return Promise.all(
          items.map(async (item, i) => {
            const itemBranch = K.deriveBranch(node, 'item', i)
            let prev = item
            for (let s = 0; s < stages.length; s++) {
              // a fresh ctx per stage, so the item segment is RE-DERIVED here
              // rather than inherited; an item that throws simply stops producing
              // stage segments (the DAG renders the declared count, unreached
              // stages dimmed)
              const sctx = childCtx(K.deriveBranch(itemBranch, 'stage', s), [...base, { kind: 'item', i }, { kind: 'stage', s }], ctx)
              try {
                prev = await K.withCtx(sctx, () => stages[s](prev, item, i))
              } catch (err) {
                degrade(err)
                prev = null
                break
              }
              if (prev === null) break
            }
            return prev
          }),
        )
      },
      // E1: phase state lives on the ALS context, never in a run-global — two
      // concurrent branches calling phase() must not overwrite each other. The
      // index (not the title) is the identity: titles repeat legally.
      phase: (title) => {
        const t = String(title)
        const phaseIndex = phaseCounter++
        phaseByTitle.set(t, phaseIndex)
        const ctx = K.currentCtx()
        if (ctx) ctx.phase = { phaseIndex, title: t }
        events.emit({ type: 'phase', phaseIndex, title: t })
      },
      // Deliberately bare (E12): a workflow's own log carries no source/level, and
      // readers fold it as workflow/info. Only the engine's own five log sites are
      // structured — that is what makes them distinguishable at all.
      log: (message) => events.emit({ type: 'log', message: String(message) }),
      // Block the workflow on operator input. Answers are journaled → replayed on resume.
      ask: (question, o = {}) => {
        const ctx = K.currentCtx()
        const qid = o.id != null
          ? String(o.id)
          : 'q' + ctx.questionIndex++ + (ctx.branch === rootBranch ? '' : '-' + ctx.branch.slice(0, 16))
        // Reuse of a qid — even sequentially — would make the journal ambiguous
        // (last answer wins on replay, so both asks would get the second answer).
        if (usedQids.has(qid)) return Promise.reject(new WorkflowError(`duplicate question id "${qid}" — ask() ids must be unique for the whole run`))
        usedQids.add(qid)
        const priorAnswer = prior?.answers.get(qid)
        if (priorAnswer !== undefined) {
          // E7: the replay path used to resolve silently, leaving the resumed
          // run's timeline with a question and no visible answer.
          events.emit({ type: 'answer', qid, value: priorAnswer, replayed: true })
          return Promise.resolve(priorAnswer)
        }
        return new Promise((resolve, reject) => {
          pendingQuestions.set(qid, { question: String(question), resolve, reject })
          events.emit({ type: 'question', qid, question: String(question), runId })
        })
      },
      // Steer a live agent from workflow code (by index or label). The
      // replay sender identity is the CALLING context's branch plus the
      // caller's call-site position, both captured at call time —
      // deterministic per call site under re-execution.
      sendTo: (sel, message) => {
        const job = findJob(sel)
        if (!job) return false
        const out = {}
        const delivery = job.send(String(message), 'workflow', K.currentCtx()?.branch ?? null, wfCallsite(), out)
        // E8: a workflow-origin steer is the same event as an operator one — the
        // agent's timeline must show both, not just the ones typed at the socket
        emitSteered(job, delivery, out.mailId)
        events.emit({ type: 'mail', agent: job.index, dir: 'in', message: String(message), delivery, mailId: out.mailId ?? null })
        return delivery
      },
      now: () => {
        const ctx = K.currentCtx()
        return createdAt + ctx.nowCount++
      },
      random: () => K.nextRandom(K.currentCtx()),
    }

    // E3: everything a reader needs to describe the run without opening the
    // journal — plus `engine`, from which readers derive which of these event
    // fields this run's engine was capable of writing (§6.2 Caps).
    events.emit({
      type: 'run',
      runId,
      state: prior ? 'resumed' : 'started',
      file: path.basename(file),
      name: meta.name ?? null,
      workflowFile: file,
      cwd: process.cwd(),
      defaults: { adapter: defaults.adapter, model: defaults.model ?? null, effort: defaults.effort ?? null },
      concurrency,
      budgetTotal,
      phases: meta.phases ?? null,
      engine: ENGINE_VERSION,
    })

    const sigint = () => abortRun('SIGINT')
    process.on('SIGINT', sigint)
    process.on('SIGTERM', sigint)

    // Late-spawned agents (from completion callbacks) can join inFlight while we
    // drain — loop until it stays empty so nothing outlives the terminal record.
    // The setImmediate flush catches joins scheduled several microtask hops after
    // a settlement, which a bare size check could miss.
    const drain = async () => {
      for (;;) {
        while (inFlight.size) await Promise.allSettled([...inFlight])
        await new Promise((r) => setImmediate(r))
        if (!inFlight.size) return
      }
    }

    let outcome
    try {
      const result = await K.withCtx(K.rootCtx(seed), () => fn(toolkit))
      await drain()
      // Close the lifecycle BEFORE the terminal record: an agent() scheduled via a
      // detached timer (setTimeout in fire-and-forget workflow code) could
      // otherwise be admitted after drain and journal past the end record.
      finishing = true
      await drain()
      if (aborted) throw new WorkflowError('run aborted')
      journal.append({ type: 'end', status: 'completed' })
      outcome = { runId, status: 'completed', result }
    } catch (err) {
      // The workflow failed — nothing may outlive the terminal record: stop
      // semaphore-queued agents from starting, cancel whatever is running, and
      // wait for every job to settle.
      finishing = true
      for (const job of live.values()) job.cancel()
      await drain()
      const status = aborted ? 'interrupted' : 'failed'
      journal.append({ type: 'end', status, error: String(err?.message ?? err) })
      outcome = { runId, status, error: String(err?.message ?? err) }
    } finally {
      process.off('SIGINT', sigint)
      process.off('SIGTERM', sigint)
      clearInterval(hb)
      clearInterval(progressTimer)
      control.close()
    }
    return finalize(outcome)
  } finally {
    // close() is idempotent — this covers precondition throws that happen after
    // the socket bound but before the normal lifecycle's own close
    try { control?.close() } catch { /* never bound */ }
    releaseLock()
  }
}
