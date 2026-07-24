// Core-engine fixes from REVIEW.md: run lock, journal integrity, budget
// persistence, key-version/module-graph resume validation, mail durability,
// module-load lifecycle, cancelled state.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// short prefix: run-dir control.sock paths must stay under the ~104-byte sun_path cap
process.env.FLOWITION_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-'))

const { runWorkflow, preserveSymlinksFlag } = await import('../src/engine.js')
const { AgentJob } = await import('../src/agent-proc.js')
const { controlRequest } = await import('../src/control.js')
const { Journal, wfMailKey } = await import('../src/journal.js')
const { runDir, readJsonl, readJsonlStrict } = await import('../src/util.js')

const fx = (name) => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name)
const binPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'flowition.js')
const sockOf = (runId) => path.join(runDir(runId), 'control.sock')
const journalOf = (runId) => path.join(runDir(runId), 'journal.jsonl')

async function until(fn, ms = 8000) {
  const t0 = Date.now()
  for (;;) {
    let v = null
    try { v = await fn() } catch { /* not ready */ }
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('until(): timeout')
    await new Promise((r) => setTimeout(r, 50))
  }
}

// Simulate a crash by dropping journal records (under no lock — the run is over).
const doctorJournal = (runId, drop) => {
  const lines = fs.readFileSync(journalOf(runId), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
  fs.writeFileSync(journalOf(runId), lines.filter((e) => !drop(e)).map((e) => JSON.stringify(e)).join('\n') + '\n')
}

test('run lock: a second engine on the same run is refused while the first is live', async () => {
  const runId = 'flo_locktest'
  const p = runWorkflow({ file: fx('cancel.workflow.js'), defaults: { adapter: 'mock' }, runId, quiet: true })
  await until(async () => (await controlRequest(sockOf(runId), { cmd: 'status' }).catch(() => null))?.ok)
  await assert.rejects(
    runWorkflow({ file: fx('cancel.workflow.js'), defaults: { adapter: 'mock' }, runId, quiet: true }),
    /already being executed/,
  )
  await controlRequest(sockOf(runId), { cmd: 'cancel' })
  const out = await p
  assert.equal(out.status, 'interrupted')
  // lock released after the run reached its terminal state
  assert.ok(!fs.existsSync(path.join(runDir(runId), 'run.lock')))
})

test('journal: a torn tail record is repaired; resume then replays cleanly', async () => {
  const out = await runWorkflow({ file: fx('basic.workflow.js'), args: { x: 1 }, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  fs.appendFileSync(journalOf(out.runId), '{"type":"result","key":"torn-partial')
  const again = await runWorkflow({ file: fx('basic.workflow.js'), args: { x: 1 }, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.deepEqual(again.result, out.result)
  assert.ok(!fs.readFileSync(journalOf(out.runId), 'utf8').includes('torn-partial'))
})

test('journal: interior corruption refuses to resume instead of re-running history', async () => {
  const out = await runWorkflow({ file: fx('basic.workflow.js'), args: { x: 2 }, defaults: { adapter: 'mock' }, quiet: true })
  const lines = fs.readFileSync(journalOf(out.runId), 'utf8').trimEnd().split('\n')
  lines.splice(2, 0, 'NOT-JSON-CORRUPTION')
  fs.writeFileSync(journalOf(out.runId), lines.join('\n') + '\n')
  await assert.rejects(
    runWorkflow({ file: fx('basic.workflow.js'), args: { x: 2 }, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /corrupt journal/,
  )
})

test('resume: refuses a journal recorded under a different key version', async () => {
  const out = await runWorkflow({ file: fx('basic.workflow.js'), args: { x: 3 }, defaults: { adapter: 'mock' }, quiet: true })
  const lines = fs.readFileSync(journalOf(out.runId), 'utf8').trimEnd().split('\n')
  const meta = JSON.parse(lines[0])
  meta.keyVersion = 'k0'
  lines[0] = JSON.stringify(meta)
  fs.writeFileSync(journalOf(out.runId), lines.join('\n') + '\n')
  await assert.rejects(
    runWorkflow({ file: fx('basic.workflow.js'), args: { x: 3 }, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /resume-key version k0/,
  )
})

test('resume: refuses when an imported local module changed (graph hash)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-graph-'))
  fs.writeFileSync(path.join(dir, 'helper.js'), 'export const V = 1\n')
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'),
    "import { V } from './helper.js'\nexport const meta = { name: 'g' }\nexport default async ({ agent }) => agent('ECHO v' + V)\n")
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'v1')
  fs.writeFileSync(path.join(dir, 'helper.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /module imported by the workflow file has changed/,
  )
})

test('resume: a symlinked entry hashes deps from the realpath — editing the real dep refuses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-symgraph-'))
  const A = path.join(dir, 'A')
  const B = path.join(dir, 'B')
  fs.mkdirSync(A)
  fs.mkdirSync(B)
  fs.writeFileSync(path.join(A, 'dep.js'), 'export const V = 1\n')
  fs.writeFileSync(path.join(A, 'wf.workflow.js'),
    "import { V } from './dep.js'\nexport const meta = { name: 'sym' }\nexport default async ({ agent }) => agent('ECHO v' + V)\n")
  // Node's ESM loader canonicalizes the symlinked entry and loads A/dep.js;
  // lexical resolution would hash the nonexistent B/dep.js as a stable
  // "unreadable" and let a changed dep resume unsoundly
  fs.symlinkSync(path.join(A, 'wf.workflow.js'), path.join(B, 'wf.workflow.js'))
  const out = await runWorkflow({ file: path.join(B, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'v1')
  fs.writeFileSync(path.join(A, 'dep.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(B, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /module imported by the workflow file has changed/,
  )
})

test('resume: under --preserve-symlinks the graph hashes the lexical deps Node actually loads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-symlex-'))
  const A = path.join(dir, 'A')
  const B = path.join(dir, 'B')
  fs.mkdirSync(A)
  fs.mkdirSync(B)
  fs.writeFileSync(path.join(A, 'dep.js'), 'export const V = 1\n')
  fs.writeFileSync(path.join(B, 'dep.js'), 'export const V = 9\n')
  fs.writeFileSync(path.join(A, 'wf.workflow.js'),
    "import { V } from './dep.js'\nexport const meta = { name: 'symlex' }\nexport default async ({ agent }) => agent('ECHO v' + V)\n")
  fs.symlinkSync(path.join(A, 'wf.workflow.js'), path.join(B, 'wf.workflow.js'))
  // Under --preserve-symlinks Node resolves LEXICALLY: running via the symlink
  // loads B/dep.js, not the target's A/dep.js — the hash must track B. The
  // in-process runWorkflow cannot change the loader flag, so spawn the CLI with
  // NODE_OPTIONS (the launcher propagates it to the engine via env inheritance).
  const env = { ...process.env, NODE_OPTIONS: '--preserve-symlinks' }
  const cli = (argv) => new Promise((resolve) => {
    execFile(process.execPath, [binPath, ...argv], { env, timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }))
  })
  const first = await cli(['run', path.join(B, 'wf.workflow.js'), '--adapter', 'mock', '--json'])
  assert.equal(first.code, 0, first.stderr)
  const out = JSON.parse(first.stdout)
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'v9', 'lexical resolution loaded the symlinked-side dep')
  // the target-side dep Node does NOT load in this mode must not block resume
  fs.writeFileSync(path.join(A, 'dep.js'), 'export const V = 2\n')
  const second = await cli(['resume', out.runId, '--json'])
  assert.equal(second.code, 0, second.stderr)
  assert.equal(JSON.parse(second.stdout).status, 'completed')
  // the symlinked-side dep Node loads lexically is exactly what the hash tracks
  fs.writeFileSync(path.join(B, 'dep.js'), 'export const V = 8\n')
  const third = await cli(['resume', out.runId, '--json'])
  assert.equal(third.code, 1)
  assert.match(third.stderr, /module imported by the workflow file has changed/)
})

test('preserve-symlinks detection: boolean-flag spellings, --no- negation, NODE_OPTIONS quoting, last-wins, -main excluded', () => {
  assert.equal(preserveSymlinksFlag([], undefined), false)
  assert.equal(preserveSymlinksFlag(['--preserve-symlinks'], ''), true)
  // Node's boolean-flag semantics: ANY =<value> spelling ENABLES — the value
  // is ignored, =false/=0/=junk included
  assert.equal(preserveSymlinksFlag(['--preserve-symlinks=true'], ''), true)
  assert.equal(preserveSymlinksFlag([], '--preserve-symlinks=true'), true)
  assert.equal(preserveSymlinksFlag([], '--preserve-symlinks=1'), true)
  assert.equal(preserveSymlinksFlag([], '--preserve-symlinks=false'), true)
  assert.equal(preserveSymlinksFlag([], '--preserve-symlinks=0'), true)
  assert.equal(preserveSymlinksFlag(['--preserve-symlinks=junk'], ''), true)
  // disabling is ONLY the --no- negation, valid in both sources
  assert.equal(preserveSymlinksFlag(['--no-preserve-symlinks'], ''), false)
  assert.equal(preserveSymlinksFlag([], '--no-preserve-symlinks'), false)
  // NODE_OPTIONS values may be double-quoted (whole token or value part)
  assert.equal(preserveSymlinksFlag([], '"--preserve-symlinks"'), true)
  assert.equal(preserveSymlinksFlag([], '--max-old-space-size=64 "--preserve-symlinks=true"'), true)
  assert.equal(preserveSymlinksFlag([], '--preserve-symlinks="true"'), true)
  // last mention wins within a source (an =<value> respelling never disables)…
  assert.equal(preserveSymlinksFlag([], '--preserve-symlinks --no-preserve-symlinks'), false)
  assert.equal(preserveSymlinksFlag(['--no-preserve-symlinks', '--preserve-symlinks'], ''), true)
  assert.equal(preserveSymlinksFlag([], '--preserve-symlinks --preserve-symlinks=false'), true)
  // …and the command line is applied after NODE_OPTIONS, Node's own precedence
  assert.equal(preserveSymlinksFlag(['--no-preserve-symlinks'], '--preserve-symlinks'), false)
  assert.equal(preserveSymlinksFlag(['--preserve-symlinks'], '--no-preserve-symlinks'), true)
  // the -main flags only affect the entry point and must never match
  assert.equal(preserveSymlinksFlag(['--preserve-symlinks-main'], ''), false)
  assert.equal(preserveSymlinksFlag([], '--preserve-symlinks-main'), false)
  assert.equal(preserveSymlinksFlag(['--preserve-symlinks', '--no-preserve-symlinks-main'], ''), true)
  // Node accepts '_' anywhere '-' appears in the option NAME — underscore and
  // mixed spellings alias the dash forms, in both sources, =value included
  assert.equal(preserveSymlinksFlag(['--preserve_symlinks'], ''), true)
  assert.equal(preserveSymlinksFlag([], '--preserve_symlinks'), true)
  assert.equal(preserveSymlinksFlag(['--preserve_symlinks=false'], ''), true)
  assert.equal(preserveSymlinksFlag([], '--preserve-symlinks_main --preserve_symlinks'), true)
  assert.equal(preserveSymlinksFlag(['--preserve_symlinks-main'], ''), false)
  // …and the --no- negation in every spelling, still last-wins
  assert.equal(preserveSymlinksFlag(['--no_preserve_symlinks'], ''), false)
  assert.equal(preserveSymlinksFlag([], '--preserve-symlinks --no-preserve_symlinks'), false)
  assert.equal(preserveSymlinksFlag(['--no_preserve-symlinks', '--preserve_symlinks'], ''), true)
  assert.equal(preserveSymlinksFlag([], '--no_preserve_symlinks-main'), false)
  // negation is equally value-blind: ANY --no-preserve-symlinks=<value>
  // spelling negates (Node ignores the value on the --no- form too), dash and
  // underscore alike, in both sources
  assert.equal(preserveSymlinksFlag([], '--preserve-symlinks --no-preserve-symlinks=false'), false)
  assert.equal(preserveSymlinksFlag(['--preserve-symlinks', '--no-preserve-symlinks=true'], ''), false)
  assert.equal(preserveSymlinksFlag(['--no-preserve-symlinks=1'], ''), false)
  assert.equal(preserveSymlinksFlag([], '--no-preserve-symlinks=false'), false)
  assert.equal(preserveSymlinksFlag([], '--preserve_symlinks --no_preserve_symlinks=false'), false)
  assert.equal(preserveSymlinksFlag(['--preserve-symlinks', '--no-preserve_symlinks=0'], ''), false)
  // last-wins and source precedence still hold around an =value negation…
  assert.equal(preserveSymlinksFlag(['--preserve-symlinks'], '--no-preserve-symlinks=false'), true)
  assert.equal(preserveSymlinksFlag([], '--no-preserve-symlinks=false --preserve-symlinks'), true)
  // …and the -main pair stays excluded even with =value
  assert.equal(preserveSymlinksFlag(['--preserve-symlinks', '--no-preserve-symlinks-main=true'], ''), true)
})

test('resume: NODE_OPTIONS="--preserve-symlinks=true" also selects lexical graph hashing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-symlexeq-'))
  const A = path.join(dir, 'A')
  const B = path.join(dir, 'B')
  fs.mkdirSync(A)
  fs.mkdirSync(B)
  fs.writeFileSync(path.join(A, 'dep.js'), 'export const V = 1\n')
  fs.writeFileSync(path.join(B, 'dep.js'), 'export const V = 9\n')
  fs.writeFileSync(path.join(A, 'wf.workflow.js'),
    "import { V } from './dep.js'\nexport const meta = { name: 'symlexeq' }\nexport default async ({ agent }) => agent('ECHO v' + V)\n")
  fs.symlinkSync(path.join(A, 'wf.workflow.js'), path.join(B, 'wf.workflow.js'))
  // Node treats this spelling exactly like the bare flag; the old exact-match
  // detection missed it and hashed the realpath side while Node loaded lexically
  const env = { ...process.env, NODE_OPTIONS: '--preserve-symlinks=true' }
  const cli = (argv) => new Promise((resolve) => {
    execFile(process.execPath, [binPath, ...argv], { env, timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }))
  })
  const first = await cli(['run', path.join(B, 'wf.workflow.js'), '--adapter', 'mock', '--json'])
  assert.equal(first.code, 0, first.stderr)
  const out = JSON.parse(first.stdout)
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'v9', 'lexical resolution loaded the symlinked-side dep')
  // the symlinked-side dep Node loads lexically is what the hash must track
  fs.writeFileSync(path.join(B, 'dep.js'), 'export const V = 8\n')
  const second = await cli(['resume', out.runId, '--json'])
  assert.equal(second.code, 1)
  assert.match(second.stderr, /module imported by the workflow file has changed/)
})

test('resume: .resuming marker survives a refused preflight and is cleared by a completed resume', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-marker-'))
  const wf = path.join(dir, 'wf.workflow.js')
  const src = "export const meta = { name: 'marker' }\nexport default async ({ agent }) => agent('ECHO ok')\n"
  fs.writeFileSync(wf, src)
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  const marker = path.join(runDir(out.runId), '.resuming')
  // refused preflight: the engine must NOT clear the marker (it now falls at
  // the ownership point, right before the result.json unlink) — it ages out
  // via run-state like any failed launch, and the old terminal result stands
  fs.writeFileSync(marker, String(Date.now()))
  fs.writeFileSync(wf, src + '// changed\n')
  await assert.rejects(
    runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /workflow file has changed/,
  )
  assert.ok(fs.existsSync(marker), 'marker left for age-out on refused preflight')
  assert.ok(fs.existsSync(path.join(runDir(out.runId), 'result.json')))
  // a resume that passes preflight owns the run: marker cleared with the stale result
  fs.writeFileSync(wf, src)
  const again = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.ok(!fs.existsSync(marker), 'marker cleared once the resume took ownership')
})

test('resume: engine re-stamps the .resuming marker mtime at socket bind — the 30s budget covers preflight', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-marker-restamp-'))
  const wf = path.join(dir, 'wf.workflow.js')
  const src = "export const meta = { name: 'restamp' }\nexport default async ({ agent }) => agent('ECHO ok')\n"
  fs.writeFileSync(wf, src)
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  const marker = path.join(runDir(out.runId), '.resuming')
  // launcher-stamped almost a full budget ago: without the bind-time refresh a
  // long preflight would let the marker age out mid-scan and expose the stale
  // terminal result. A refused preflight leaves the marker behind, which makes
  // the re-stamp observable: the refusal fires AFTER the bind gate.
  const old = new Date(Date.now() - 29_000)
  fs.writeFileSync(marker, String(old.getTime()))
  fs.utimesSync(marker, old, old)
  fs.writeFileSync(wf, src + '// changed\n')
  await assert.rejects(
    runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /workflow file has changed/,
  )
  assert.ok(fs.existsSync(marker), 'marker left for age-out on refused preflight')
  assert.ok(fs.statSync(marker).mtimeMs > old.getTime() + 20_000, 'marker mtime advanced across the resume start')
})

test('resume: computed dynamic imports refuse loudly; import-text in strings does not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-dyn-'))
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const which = () => 1\n')
  // quote-prefixed computed import — the shape that escaped the regex detector
  fs.writeFileSync(path.join(dir, 'dyn.workflow.js'),
    "export const meta = { name: 'dyn' }\nexport default async ({ agent }) => { const m = await import('./' + 'a' + '.js'); return agent('ECHO ' + m.which()) }\n")
  const out = await runWorkflow({ file: path.join(dir, 'dyn.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'dyn.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import/,
  )
  // import-like text inside a string/template must NOT poison resumability
  fs.writeFileSync(path.join(dir, 'text.workflow.js'),
    "export const meta = { name: 'text' }\nconst blurb = `agents may call import(name) or import('./x/' + n)`\nexport default async ({ agent }) => agent('ECHO ' + blurb.length)\n")
  const t = await runWorkflow({ file: path.join(dir, 'text.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(t.status, 'completed')
  const t2 = await runWorkflow({ file: path.join(dir, 'text.workflow.js'), defaults: { adapter: 'mock' }, resumeId: t.runId, quiet: true })
  assert.equal(t2.status, 'completed')
  // no-space static import form is still hashed: changing the dep blocks resume
  fs.writeFileSync(path.join(dir, 'b.js'), 'export const V=1\n')
  fs.writeFileSync(path.join(dir, 'tight.workflow.js'),
    "import{V}from'./b.js'\nexport const meta = { name: 'tight' }\nexport default async ({ agent }) => agent('ECHO v' + V)\n")
  const g = await runWorkflow({ file: path.join(dir, 'tight.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(g.status, 'completed')
  fs.writeFileSync(path.join(dir, 'b.js'), 'export const V=2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'tight.workflow.js'), defaults: { adapter: 'mock' }, resumeId: g.runId, quiet: true }),
    /module imported by the workflow file has changed/,
  )
})

test('resume: percent-encoded relative specifiers hash the decoded path Node loads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-pct-'))
  fs.writeFileSync(path.join(dir, 'dep x.js'), 'export const V = 1\n')
  // Node URL-decodes relative ESM specifiers and loads 'dep x.js'; resolving
  // the encoded text hashed a nonexistent path as a stable 'unreadable' and
  // let an edited real dep resume silently
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'pct' }",
    "import { V } from './dep%20x.js'",
    "export default async ({ agent }) => agent('ECHO v' + V)",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'v1')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  const again = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  fs.writeFileSync(path.join(dir, 'dep x.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /module imported by the workflow file has changed/,
  )
})

test('resume: a malformed percent-sequence in a specifier flags dynamic — Node would fail it too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-pctbad-'))
  // guarded so it never executes (the fresh run completes); decodeURIComponent
  // throws on '%zz', and guessing at a path would hash a file Node could never
  // resolve — flag dynamic and refuse resume loudly instead
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'pctbad' }",
    'export default async ({ agent }) => {',
    "  const m = false && await import('./x%zz.js')",
    "  return agent('ECHO ' + (m ? 'y' : 'n'))",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'n')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import/,
  )
})

test('budget: persisted in meta and restored on resume without --budget', async () => {
  const first = await runWorkflow({ file: fx('budget.workflow.js'), defaults: { adapter: 'mock' }, budgetTotal: 3, quiet: true })
  assert.equal(first.status, 'failed')
  assert.match(first.error, /budget exceeded/)
  // resume with no explicit budget: the journaled ceiling still applies
  const second = await runWorkflow({ file: fx('budget.workflow.js'), defaults: { adapter: 'mock' }, resumeId: first.runId, quiet: true })
  assert.equal(second.status, 'failed')
  assert.match(second.error, /budget exceeded/)
})

test('mail: accepted steering is journaled and marked done once delivered', async () => {
  const p = runWorkflow({ file: fx('steer.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  const runId = await until(async () => {
    const ids = fs.readdirSync(path.join(process.env.FLOWITION_HOME, 'runs')).filter((d) => fs.existsSync(sockOf(d)))
    for (const id of ids) {
      const st = await controlRequest(sockOf(id), { cmd: 'status' }).catch(() => null)
      if (st?.ok && st.agents.some((a) => a.label === 'steerme')) return id
    }
    return null
  })
  await controlRequest(sockOf(runId), { cmd: 'send', agent: 'steerme', message: 'durable-hello' })
  const out = await p
  assert.equal(out.result, 'mail:durable-hello')
  const entries = readJsonl(journalOf(runId))
  const mail = entries.find((e) => e.type === 'mail' && e.text === 'durable-hello')
  assert.ok(mail, 'mail record journaled')
  assert.equal(mail.origin, 'operator')
  // full uuid: 32-bit sliced ids can collide within one agent and mark the
  // wrong message done across a crash (mail-done matches the first id hit)
  assert.match(mail.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.ok(entries.some((e) => e.type === 'mail-done' && e.id === mail.id), 'delivery journaled')
  assert.equal(Journal.load(runDir(runId)).pendingMail.get(mail.key)?.length ?? 0, 0)

  // crash before delivery/completion: the resumed agent must receive the
  // restored operator message exactly once — a duplicate would leave a second
  // queued message that forces a follow-up turn and changes the result
  doctorJournal(runId, (e) => e.type === 'end' || (e.type === 'result' && e.key === mail.key) || (e.type === 'mail-done' && e.id === mail.id))
  const again = await runWorkflow({ file: fx('steer.workflow.js'), defaults: { adapter: 'mock' }, resumeId: runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, 'mail:durable-hello')
  const after = readJsonl(journalOf(runId))
  assert.equal(after.filter((e) => e.type === 'mail' && e.text === 'durable-hello').length, 1, 'restore does not re-journal')
  assert.ok(after.some((e) => e.type === 'mail-done' && e.id === mail.id), 'restored mail delivered')
  assert.equal(Journal.load(runDir(runId)).pendingMail.get(mail.key)?.length ?? 0, 0)
})

test('mail: DELIVERED workflow mail is replay-suppressed on crash-resume, never sent twice', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-mailreplay-'))
  const wf = path.join(dir, 'wf.workflow.js')
  // the send lands mid-turn (agent sleeping) and is delivered via a follow-up
  // turn; the agent does not need to receive it again to finish, so the
  // resumed run can complete with the re-send suppressed
  fs.writeFileSync(wf, [
    "export const meta = { name: 'mailreplay' }",
    'export default async ({ spawn, sendTo }) => {',
    "  const h = spawn('SLEEP 200\\nECHO fin', { label: 'worker' })",
    '  let d = false',
    "  while ((d = sendTo('worker', 'replay-me')) === false) await new Promise((r) => setTimeout(r, 10))",
    '  const r = await h.done',
    "  return r + '|' + d",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.match(out.result, /\|queued$/)
  const sent = readJsonl(journalOf(out.runId)).find((e) => e.type === 'mail')
  assert.equal(sent.origin, 'workflow')
  assert.ok(readJsonl(journalOf(out.runId)).some((e) => e.type === 'mail-done' && e.id === sent.id), 'delivered in the first run')
  // crash window: mail-done journaled but the engine died before the agent's
  // result record — the resumed workflow deterministically re-issues the same
  // send into the CONTINUED provider session
  doctorJournal(out.runId, (e) => e.type === 'end' || (e.type === 'result' && e.key === sent.key))
  const again = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, 'fin|replayed', 're-send reports replayed; the agent finishes without a second delivery')
  const after = readJsonl(journalOf(out.runId))
  assert.equal(after.filter((e) => e.type === 'mail' && e.text === 'replay-me').length, 1, 'the suppressed re-send journals nothing')
  assert.equal(after.filter((e) => e.type === 'mail-done').length, 1, 'one delivery record for one logical send')
  const transcript = readJsonl(path.join(runDir(out.runId), 'agents', '0.jsonl'))
  assert.ok(transcript.some((e) => e.kind === 'status' && /replay-suppressed/.test(e.text)), 'suppression noted in the transcript')
})

test('mail: deliver-or-declare drops journal dropped:true and never count as deliveries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-maildrop-'))
  const journal = new Journal(dir)
  let startTurn, finishTurn
  const turnStarted = new Promise((r) => { startTurn = r })
  const turnFinished = new Promise((r) => { finishTurn = r })
  // no resumable session: at successful return the queued mail can only be
  // terminally declared undeliverable
  const noResume = {
    name: 'no-resume',
    caps: { steer: 'turn', resume: false, schema: 'prompt', selfSession: false },
    direct: async () => { startTurn(); await turnFinished; return { text: 'done' } },
  }
  const mkJob = (deliveredWorkflowMail) => new AgentJob({
    adapter: noResume, spec: {}, prompt: 'work', index: 0, key: 'k', label: null,
    runId: 'flo_maildrop', scratch: dir, transcript: { write: () => {} },
    journal, priorSessionId: null, pendingMail: [], deliveredWorkflowMail,
  })
  const job = mkJob(null)
  const executing = job.execute()
  await turnStarted
  assert.equal(job.send('need-this', 'workflow'), 'queued')
  finishTurn()
  await executing
  const entries = readJsonl(journal.file)
  const mail = entries.find((e) => e.type === 'mail')
  assert.equal(mail.origin, 'workflow')
  const done = entries.find((e) => e.type === 'mail-done' && e.id === mail.id)
  assert.equal(done?.dropped, true, 'drop marked dropped:true, distinguishable from a delivery')
  // crash-before-result window: pendingMail still clears, but the dropped text
  // must NOT enter the delivered multiset — the provider never received it
  const st = Journal.load(dir)
  assert.equal(st.pendingMail.get('k')?.length ?? 0, 0, 'dropped mail still clears pending')
  assert.equal(st.deliveredWorkflowMail.get('k')?.size ?? 0, 0, 'a drop is not a delivery')
  // the resumed workflow's deterministic re-send goes out genuinely
  const resumed = mkJob(st.deliveredWorkflowMail.get('k') ?? null)
  assert.equal(resumed.send('need-this', 'workflow'), 'queued', 'not replayed — the session never got it')
  assert.equal(readJsonl(journal.file).filter((e) => e.type === 'mail' && e.text === 'need-this').length, 2, 'fresh mail record journaled')
})

test('mail: a crash window holding a DROPPED workflow mail does not suppress the resumed re-send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-maildropresume-'))
  const wf = path.join(dir, 'wf.workflow.js')
  fs.writeFileSync(wf, [
    "export const meta = { name: 'maildropresume' }",
    'export default async ({ spawn, sendTo }) => {',
    "  const h = spawn('SLEEP 200\\nECHO fin', { label: 'worker' })",
    '  let d = false',
    "  while ((d = sendTo('worker', 'need-this')) === false) await new Promise((r) => setTimeout(r, 10))",
    '  const r = await h.done',
    "  return r + '|' + d",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  const sent = readJsonl(journalOf(out.runId)).find((e) => e.type === 'mail')
  assert.equal(sent.origin, 'workflow')
  // crash window with a DROP: rewrite the delivery record as the drop path
  // journals it (the provider never received the text) and lose the attempt's
  // result + end records — before the fix, load counted the drop into the
  // delivered multiset and the resumed re-send came back 'replayed'
  const doctored = readJsonl(journalOf(out.runId))
    .filter((e) => e.type !== 'end' && !(e.type === 'result' && e.key === sent.key))
    .map((e) => (e.type === 'mail-done' && e.id === sent.id ? { ...e, dropped: true } : e))
  fs.writeFileSync(journalOf(out.runId), doctored.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const again = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.ok(!again.result.endsWith('|replayed'), `re-send must not report replayed: ${again.result}`)
  const after = readJsonl(journalOf(out.runId))
  const mails = after.filter((e) => e.type === 'mail' && e.text === 'need-this')
  assert.equal(mails.length, 2, 'the re-send journals a fresh mail record')
  const freshId = mails.map((m) => m.id).find((id) => id !== sent.id)
  assert.ok(after.some((e) => e.type === 'mail-done' && e.id === freshId && !e.dropped), 'the re-send was genuinely delivered')
})

// A degenerate provider stream: the turn completes without ever emitting a
// session event, so the attempt cannot be continued on resume.
const withSessionlessMock = async (fn) => {
  const mock = (await import('../src/adapters/index.js')).getAdapter('mock')
  const origDirect = mock.direct
  mock.direct = ({ prompt, spec, io }) => origDirect({ prompt, spec, io: { ...io, emit: (e) => { if (e.k !== 'session') io.emit(e) } } })
  try { return await fn() } finally { mock.direct = origDirect }
}

// Emulate a crash BEFORE the agent's result record: everything from the result
// on is lost (under the fix the mail-done rides after it, so it is lost too).
const truncateAtResult = (runId, key) => {
  const entries = readJsonl(journalOf(runId))
  const resultIdx = entries.findIndex((e) => e.type === 'result' && e.key === key)
  assert.ok(resultIdx !== -1, 'result record present before truncation')
  fs.writeFileSync(journalOf(runId), entries.slice(0, resultIdx).map((e) => JSON.stringify(e)).join('\n') + '\n')
}

test('mail: sessionless delivery defers mail-done to the completed result; crash-resume restores operator mail', { timeout: 30_000 }, async () => {
  let runId
  await withSessionlessMock(async () => {
    const p = runWorkflow({ file: fx('steer.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
    runId = await until(async () => {
      const ids = fs.readdirSync(path.join(process.env.FLOWITION_HOME, 'runs')).filter((d) => fs.existsSync(sockOf(d)))
      for (const id of ids) {
        const st = await controlRequest(sockOf(id), { cmd: 'status' }).catch(() => null)
        if (st?.ok && st.agents.some((a) => a.label === 'steerme')) return id
      }
      return null
    })
    await controlRequest(sockOf(runId), { cmd: 'send', agent: 'steerme', message: 'sessionless-hello' })
    const out = await p
    assert.equal(out.status, 'completed')
    assert.equal(out.result, 'mail:sessionless-hello')
  })
  const entries = readJsonl(journalOf(runId))
  assert.ok(!entries.some((e) => e.type === 'session'), 'degenerate stream captured no session')
  const mail = entries.find((e) => e.type === 'mail' && e.text === 'sessionless-hello')
  assert.equal(mail.origin, 'operator')
  // a sessionless COMPLETED agent leaves no pending mail — but its mail-done is
  // written with the result record, not at turn end (delivery is durable only
  // once the outcome is)
  const doneIdx = entries.findIndex((e) => e.type === 'mail-done' && e.id === mail.id && !e.dropped && !e.skipped)
  const resultIdx = entries.findIndex((e) => e.type === 'result' && e.key === mail.key)
  assert.ok(doneIdx !== -1, 'delivery journaled for the completed agent')
  assert.ok(doneIdx > resultIdx, 'mail-done rides AFTER the completed result record')
  assert.equal(Journal.load(runDir(runId)).pendingMail.get(mail.key)?.length ?? 0, 0, 'no pending mail left behind')

  // crash before the result record: the delivery never became durable, so the
  // restored operator mail must reach the FRESH session exactly once
  truncateAtResult(runId, mail.key)
  assert.equal(Journal.load(runDir(runId)).pendingMail.get(mail.key)?.length, 1, 'crash window keeps the mail pending')
  const again = await runWorkflow({ file: fx('steer.workflow.js'), defaults: { adapter: 'mock' }, resumeId: runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, 'mail:sessionless-hello', 'restored mail delivered exactly once into the re-run')
  const after = readJsonl(journalOf(runId))
  assert.equal(after.filter((e) => e.type === 'mail' && e.text === 'sessionless-hello').length, 1, 'restore does not re-journal')
  assert.equal(Journal.load(runDir(runId)).pendingMail.get(mail.key)?.length ?? 0, 0)
})

test('mail: a sessionless crash window leaves workflow mail pending — restored copy delivers, re-send absorbed', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-sessionless-resend-'))
  const wf = path.join(dir, 'wf.workflow.js')
  // the worker sleeps before consuming mail: on resume the restored copy
  // already sits in its queue, and an instant WAIT_MAIL would let the job
  // settle before the send loop below ever finds it live
  fs.writeFileSync(wf, [
    "export const meta = { name: 'sessionless-resend' }",
    'export default async ({ spawn, sendTo }) => {',
    "  const h = spawn('SLEEP 300\\nWAIT_MAIL', { label: 'worker' })",
    '  let d = false',
    "  while ((d = sendTo('worker', 'need-this')) === false) await new Promise((r) => setTimeout(r, 10))",
    '  const r = await h.done',
    "  return r + '|' + d",
    '}',
  ].join('\n') + '\n')
  const out = await withSessionlessMock(() => runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true }))
  assert.equal(out.status, 'completed')
  assert.match(out.result, /^mail:need-this\|(live|queued)$/)
  const entries = readJsonl(journalOf(out.runId))
  const sent = entries.find((e) => e.type === 'mail')
  assert.equal(sent.origin, 'workflow')
  assert.ok(entries.findIndex((e) => e.type === 'mail-done' && e.id === sent.id) >
    entries.findIndex((e) => e.type === 'result' && e.key === sent.key), 'sessionless delivery became durable only with the result')
  // crash before the result record: no mail-done survives, so the mail is
  // pending again — the restored copy goes into the fresh session and the
  // re-executing workflow's send is absorbed against the restored multiset
  // (the delivered multiset stays empty: the old session never became durable)
  truncateAtResult(out.runId, sent.key)
  assert.equal(Journal.load(runDir(out.runId)).restoredWorkflowMail.get(sent.key)?.get(wfMailKey('need-this', sent.seq, sent.sender, sent.callsite)), 1)
  const again = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, 'mail:need-this|replayed', 'restored copy delivered; the re-send absorbed, not lost')
  const after = readJsonl(journalOf(out.runId))
  assert.equal(after.filter((e) => e.type === 'mail' && e.text === 'need-this').length, 1, 'the absorbed re-send journals nothing')
  assert.ok(after.some((e) => e.type === 'mail-done' && e.id === sent.id && !e.skipped && !e.dropped), 'exactly the restored copy was delivered')
})

test('mail: Journal.load keeps origin on pendingMail; legacy records restore as operator', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-mailorigin-'))
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), [
    { t: 1, type: 'started', key: 'k', index: 0 },
    { t: 2, type: 'mail', key: 'k', id: 'id-op', text: 'op-msg', origin: 'operator' },
    { t: 3, type: 'mail', key: 'k', id: 'id-wf', text: 'wf-msg', origin: 'workflow' },
    { t: 4, type: 'mail', key: 'k', id: 'id-legacy', text: 'old-msg' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')
  const st = Journal.load(dir)
  assert.deepEqual(st.pendingMail.get('k'), [
    { id: 'id-op', text: 'op-msg', origin: 'operator' },
    { id: 'id-wf', text: 'wf-msg', origin: 'workflow' },
    { id: 'id-legacy', text: 'old-msg', origin: 'operator' },
  ])
  // the engine restores everything; the workflow-origin subset is also
  // counted into the restored multiset (legacy seq-less records under their
  // text-only identity) so matching re-sends are absorbed
  assert.deepEqual(st.restoredWorkflowMail.get('k'), new Map([[wfMailKey('wf-msg', null), 1]]))
})

test('mail: pending workflow mail restores on resume; the re-executed spawn send is absorbed — one delivery', async () => {
  const out = await runWorkflow({ file: fx('self-steer.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.result, 'mail:from-workflow')
  const sent = readJsonl(journalOf(out.runId)).find((e) => e.type === 'mail')
  assert.equal(sent.origin, 'workflow')
  doctorJournal(out.runId, (e) => e.type === 'end' || (e.type === 'result' && e.key === sent.key) || (e.type === 'mail-done' && e.id === sent.id))
  const again = await runWorkflow({ file: fx('self-steer.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  // restored + re-sent would deliver twice and force a follow-up turn
  assert.equal(again.result, 'mail:from-workflow')
  const after = readJsonl(journalOf(out.runId))
  const mails = after.filter((e) => e.type === 'mail')
  assert.equal(mails.length, 1, 'the absorbed re-send journals nothing — the restored record stands alone')
  // the restored copy carried the delivery under its original id — a genuine
  // mail-done, not a tombstone, so no pending orphan survives the cycle
  assert.ok(after.some((e) => e.type === 'mail-done' && e.id === sent.id && !e.skipped && !e.dropped), 'restored copy delivered')
  assert.ok(!after.some((e) => e.type === 'mail-done' && e.skipped), 'no tombstone written')
  assert.equal(Journal.load(runDir(out.runId)).pendingMail.get(sent.key)?.length ?? 0, 0)
  const transcript = readJsonl(path.join(runDir(out.runId), 'agents', '0.jsonl'))
  assert.ok(transcript.some((e) => e.kind === 'status' && /restored pending copy/.test(e.text)), 'absorption noted in the transcript')
})

test('mail: restored workflow mail delivers even when the resumed workflow fails to re-send (cached sender)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-restoredwf-'))
  const wf = path.join(dir, 'wf.workflow.js')
  const flag = path.join(dir, 'first-run-done')
  // First run: the send lands while the worker is live. Resumed run: models a
  // CACHED sender branch replaying instantly — its sendTo() fires before the
  // worker job is admitted, finds no live job, returns false, and journals
  // nothing. The restored pending copy must carry the delivery.
  fs.writeFileSync(wf, [
    "import fs from 'node:fs'",
    "export const meta = { name: 'restored-wf-mail' }",
    'export default async ({ spawn, sendTo }) => {',
    `  const first = !fs.existsSync(${JSON.stringify(flag)})`,
    `  if (first) fs.writeFileSync(${JSON.stringify(flag)}, '1')`,
    "  let d = null",
    "  if (!first) d = sendTo('worker', 'guide')",
    "  const h = spawn('WAIT_MAIL', { label: 'worker' })",
    "  if (first) while (sendTo('worker', 'guide') === false) await new Promise((r) => setTimeout(r, 10))",
    '  const r = await h.done',
    "  return r + '|' + d",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'mail:guide|null')
  const sent = readJsonl(journalOf(out.runId)).find((e) => e.type === 'mail')
  assert.equal(sent.origin, 'workflow')
  // crash window: the send was accepted but never delivered — before the fix,
  // restore tombstoned it and the failed re-send left the worker without the
  // acknowledged guidance
  doctorJournal(out.runId, (e) => e.type === 'end' || (e.type === 'result' && e.key === sent.key) || (e.type === 'mail-done' && e.id === sent.id))
  const again = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, 'mail:guide|false', 'sendTo found no live job, yet the restored mail reached the worker')
  const after = readJsonl(journalOf(out.runId))
  assert.equal(after.filter((e) => e.type === 'mail' && e.text === 'guide').length, 1, 'the failed sendTo journals nothing')
  assert.ok(after.some((e) => e.type === 'mail-done' && e.id === sent.id && !e.skipped && !e.dropped), 'restored copy delivered under its original id')
  assert.equal(Journal.load(runDir(out.runId)).pendingMail.get(sent.key)?.length ?? 0, 0)
})

// Drive AgentJob.handleEvent directly: the cumulative-baseline rules are about
// which thread the baseline belongs to, not about any provider process.
const stubJob = ({ priorSessionId, usageCum }, appended) => new AgentJob({
  adapter: { caps: {} }, spec: {}, prompt: 'p', index: 0, key: 'k', label: null,
  runId: 'flo_stub', scratch: '', transcript: { write: () => {} },
  journal: { append: (e) => appended.push(e) },
  priorSessionId, pendingMail: [], usageCum,
})

test('usage: a restored baseline from a sessionless attempt is zeroed when a new thread arrives', () => {
  const appended = []
  // prior attempt journaled usage-cum but never a session: the baseline's
  // thread cannot be continued, so priorSessionId is null on resume
  const job = stubJob({ priorSessionId: null, usageCum: { input: 100, output: 50 } }, appended)
  job.handleEvent({ k: 'session', id: 'thread-B' })
  job.handleEvent({ k: 'usage', cumulative: true, input: 20, output: 10 })
  // full delta charged — not max(0, 20-100) = 0 — with the zero-reset journaled
  assert.deepEqual(appended.filter((e) => e.type === 'usage-cum').map((e) => e.cum),
    [{ input: 0, output: 0 }, { input: 20, output: 10 }])
  assert.equal(job.usage.input, 20)
  assert.equal(job.usage.output, 10)
})

test('usage: resuming the SAME journaled thread keeps the restored cumulative baseline', () => {
  const appended = []
  const job = stubJob({ priorSessionId: 'thread-A', usageCum: { input: 100, output: 50 } }, appended)
  job.handleEvent({ k: 'session', id: 'thread-A' })
  job.handleEvent({ k: 'usage', cumulative: true, input: 120, output: 60 })
  // only the growth beyond the kept baseline is charged; no zero-reset record
  assert.deepEqual(appended.filter((e) => e.type === 'usage-cum').map((e) => e.cum),
    [{ input: 120, output: 60 }])
  assert.equal(job.usage.input, 20)
  assert.equal(job.usage.output, 10)
})

test('usage: a doubly-sessionless attempt discards the restored baseline at construction', () => {
  const appended = []
  // prior attempt journaled usage-cum but never a session, and the new attempt
  // never emits a session event either — the constructor must not wait for one
  const job = stubJob({ priorSessionId: null, usageCum: { input: 100, output: 50 } }, appended)
  // zero-reset journaled immediately, so Journal.load chaining cannot clamp
  assert.deepEqual(appended, [{ type: 'usage-cum', key: 'k', cum: { input: 0, output: 0 } }])
  job.handleEvent({ k: 'usage', cumulative: true, input: 20, output: 10 })
  // full delta charged — not max(0, 20-100) = 0
  assert.equal(job.usage.input, 20)
  assert.equal(job.usage.output, 10)
  assert.deepEqual(appended.filter((e) => e.type === 'usage-cum').map((e) => e.cum),
    [{ input: 0, output: 0 }, { input: 20, output: 10 }])
})

test('mail: a failed turn requeues delivered mail in acceptance order, ahead of undelivered', async () => {
  const appended = []
  // direct adapter: consumes one live-delivered message, then fails the turn
  const job = new AgentJob({
    adapter: {
      caps: { resume: true },
      direct: async ({ io }) => {
        const first = io.waitMail() // waiter registered before any send
        await sends // m1 lands on the waiter (live), m2 queues
        await first
        throw new Error('provider turn failed')
      },
    },
    spec: {}, prompt: 'p', index: 0, key: 'k', label: null,
    runId: 'flo_mailorder', scratch: '', transcript: { write: () => {} },
    journal: { append: (e) => appended.push(e) },
    priorSessionId: null, pendingMail: [],
  })
  // m0 was accepted BEFORE this turn (a queued batch being delivered in-prompt)
  job.pendingDelivery = [{ id: 'id-m0', text: 'm0' }]
  let resolveSends
  const sends = new Promise((r) => { resolveSends = r })
  const turn = job.runTurn('p', 'fresh')
  assert.equal(job.send('m1'), 'live') // consumed by the waiting turn
  assert.equal(job.send('m2'), 'queued') // never delivered this turn
  resolveSends()
  await assert.rejects(turn, /provider turn failed/)
  // acceptance order preserved: pending (m0) then live-delivered (m1) go back
  // to the FRONT together, ahead of the never-delivered m2 — not [m2, …, m1]
  assert.deepEqual(job.mailQueue.map((m) => m.text), ['m0', 'm1', 'm2'])
  assert.equal(job.pendingDelivery, null)
  assert.deepEqual(job.liveDelivered, [])
  // nothing was marked done — the failed turn delivered nothing durably
  assert.ok(!appended.some((e) => e.type === 'mail-done'))
})

test('mail: sendTo() steering is journaled with workflow origin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-sendto-'))
  const wf = path.join(dir, 'wf.workflow.js')
  fs.writeFileSync(wf, [
    "export const meta = { name: 'sendto-origin' }",
    'export default async ({ spawn, sendTo }) => {',
    "  const h = spawn('WAIT_MAIL', { label: 'listener' })",
    "  while (sendTo('listener', 'via-sendto') === false) await new Promise((r) => setTimeout(r, 10))",
    '  return h.done',
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.result, 'mail:via-sendto')
  assert.equal(readJsonl(journalOf(out.runId)).find((e) => e.type === 'mail')?.origin, 'workflow')
})

test('mail: a send racing final-turn completion is never stranded — acceptance closes with the turn', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-mailwindow-'))
  const wf = path.join(dir, 'wf.workflow.js')
  // The race: after the anchor send releases WAIT_MAIL, the turn's completion
  // runs as a chain of microtasks ending in the engine's finally (which sets
  // settled). A send fired from a workflow microtask interleaved with that
  // chain used to land in the one-slot window AFTER execute()'s final queue
  // check but BEFORE the engine's finally: accepted as 'queued', journaled —
  // and stranded forever (completed keys replay from cache; no turn ever
  // consumes it). The sweep over n chained microtasks walks the send across
  // every slot of the completion chain, so one run lands in the window.
  fs.writeFileSync(wf, [
    "export const meta = { name: 'mail-window' }",
    'export default async ({ spawn, sendTo, args }) => {',
    "  const h = spawn('WAIT_MAIL', { label: 'w' })",
    '  let go = false',
    "  while ((go = sendTo('w', 'go')) === false) await new Promise((r) => setTimeout(r, 10))",
    '  let late = null',
    '  let chain = Promise.resolve()',
    '  for (let i = 0; i < args.n; i++) chain = chain.then(() => {})',
    "  chain = chain.then(() => { late = h.send('late') })",
    '  const r = await h.done',
    '  await chain',
    "  return go + '|' + late + '|' + r",
    '}',
  ].join('\n') + '\n')
  const verdicts = []
  for (let n = 0; n < 10; n++) {
    const out = await runWorkflow({ file: wf, args: { n }, defaults: { adapter: 'mock' }, quiet: true })
    assert.equal(out.status, 'completed')
    const [go, late] = out.result.split('|')
    assert.equal(go, 'live', `n=${n}: anchor send must land on the waiting turn`)
    verdicts.push(late)
    // the hard invariant: a mail record without a matching mail-done must be
    // impossible in a completed run — every accepted send was delivered (a
    // follow-up turn) or declared (dropped:true); post-settle sends journal
    // nothing at all
    const entries = readJsonl(journalOf(out.runId))
    for (const m of entries.filter((e) => e.type === 'mail')) {
      assert.ok(entries.some((e) => e.type === 'mail-done' && e.id === m.id),
        `n=${n}: mail ${JSON.stringify(m.text)} stranded — journaled but never marked done (late verdict: ${late})`)
    }
    for (const [k, pend] of Journal.load(runDir(out.runId)).pendingMail) {
      assert.equal(pend.length, 0, `n=${n}: pending mail survived a completed run for key ${k}`)
    }
  }
  // the sweep genuinely crossed the closure: early slots ride a follow-up
  // turn ('queued'), post-settle slots are absorbed loudly ('dropped')
  assert.ok(verdicts.includes('dropped'), `no send was absorbed post-settle: ${verdicts.join(',')}`)
  assert.ok(verdicts.every((v) => v === 'dropped' || v === 'queued'), `unexpected verdict in sweep: ${verdicts.join(',')}`)
})

test('mail: a failed attempt does not settle — mail accepted between retries still delivers', async () => {
  const appended = []
  const prompts = []
  let attempt = 0
  // acceptance closes only at the SUCCESSFUL return: a retryable failure
  // leaves the job open so the engine's second execute() can still consume
  // mail accepted in between
  const job = new AgentJob({
    adapter: {
      caps: { resume: true },
      direct: async ({ prompt, io }) => {
        prompts.push(prompt)
        io.emit({ k: 'session', id: 's1' })
        if (++attempt === 1) throw Object.assign(new Error('flaky provider'), { retryable: true })
        return { text: 'ok' }
      },
    },
    spec: {}, prompt: 'p', index: 0, key: 'k', label: null,
    runId: 'flo_retrymail', scratch: '', transcript: { write: () => {} },
    journal: { append: (e) => appended.push(e) },
    priorSessionId: null, pendingMail: [],
  })
  await assert.rejects(job.execute(), /flaky provider/)
  assert.equal(job.settled, false, 'a failed attempt must not close acceptance — the engine retries this job')
  assert.equal(job.send('between-attempts'), 'queued')
  await job.execute()
  assert.equal(job.settled, true, 'the successful return closes acceptance synchronously')
  assert.ok(prompts.some((p) => p.includes('between-attempts')), 'mail accepted between attempts reached the provider')
  const mail = appended.find((e) => e.type === 'mail' && e.text === 'between-attempts')
  assert.ok(appended.some((e) => e.type === 'mail-done' && e.id === mail.id && !e.dropped), 'delivered, not declared')
  assert.equal(job.send('after-completion'), 'dropped')
  assert.ok(!appended.some((e) => e.type === 'mail' && e.text === 'after-completion'), 'post-settle sends journal nothing')
})

test('module-load failure still produces a terminal journal record and result.json', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-badmod-'))
  const bad = path.join(dir, 'bad.workflow.js')
  fs.writeFileSync(bad, 'export const meta = { name: "bad" }\nthis is a syntax error{{{\n')
  const runId = 'flo_badmod'
  await assert.rejects(runWorkflow({ file: bad, defaults: { adapter: 'mock' }, runId, quiet: true }))
  const result = JSON.parse(fs.readFileSync(path.join(runDir(runId), 'result.json'), 'utf8'))
  assert.equal(result.status, 'failed')
  assert.ok(readJsonl(journalOf(runId)).some((e) => e.type === 'end' && e.status === 'failed'))
})

test('module-load: ESM parse failure under a CommonJS package scope names the offending package.json and the fix', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-cjsscope-'))
  const pkg = path.join(dir, 'package.json')
  fs.writeFileSync(pkg, JSON.stringify({ name: 'scratch', type: 'commonjs' }))
  const wf = path.join(dir, 'wf.workflow.js')
  fs.writeFileSync(wf, 'export default async function () { return { ok: true } }\n')
  const runId = 'flo_cjsscope'
  await assert.rejects(runWorkflow({ file: wf, defaults: { adapter: 'mock' }, runId, quiet: true }), (err) => {
    assert.equal(err.constructor.name, 'WorkflowError', 'clean CLI error, not a raw stack')
    assert.match(err.message, /Unexpected token 'export'/, 'underlying parse error stays visible')
    assert.ok(err.message.includes(pkg), 'names the offending package.json')
    assert.match(err.message, /"type": "module"/)
    assert.match(err.message, /\.mjs/)
    return true
  })
  // the journaled/terminal error carries the same diagnosis
  const result = JSON.parse(fs.readFileSync(path.join(runDir(runId), 'result.json'), 'utf8'))
  assert.equal(result.status, 'failed')
  assert.ok(result.error.includes(pkg))
})

test('readJsonlStrict: prefix-property tail rules', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-jsonl-'))
  // newline-terminated unparseable record = corruption, even as the final line
  const corrupt = path.join(dir, 'corrupt.jsonl')
  fs.writeFileSync(corrupt, '{"a":1}\nBROKEN\n')
  assert.throws(() => readJsonlStrict(corrupt, { repair: true }), /corrupt journal/)
  // parseable tail without newline: record kept, newline appended under repair
  const tail = path.join(dir, 'tail.jsonl')
  fs.writeFileSync(tail, '{"a":1}\n{"b":2}')
  const r = readJsonlStrict(tail, { repair: true })
  assert.equal(r.entries.length, 2)
  assert.ok(fs.readFileSync(tail, 'utf8').endsWith('{"b":2}\n'))
  // without repair, readers never mutate
  const ro = path.join(dir, 'ro.jsonl')
  fs.writeFileSync(ro, '{"a":1}\n{"partial')
  const before = fs.readFileSync(ro, 'utf8')
  const rr = readJsonlStrict(ro)
  assert.equal(rr.entries.length, 1)
  assert.equal(fs.readFileSync(ro, 'utf8'), before)
})

test('resume: refuses when defaults differ from the original run', async () => {
  const out = await runWorkflow({ file: fx('basic.workflow.js'), args: { x: 9 }, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  await assert.rejects(
    runWorkflow({ file: fx('basic.workflow.js'), args: { x: 9 }, defaults: { adapter: 'mock', model: 'other-model' }, resumeId: out.runId, quiet: true }),
    /defaults .* differ/,
  )
})

test('resume: stale terminal result.json is cleared while the resumed run is live', async () => {
  const runId = 'flo_stale_result'
  const p1 = runWorkflow({ file: fx('cancel.workflow.js'), defaults: { adapter: 'mock' }, runId, quiet: true })
  await until(async () => (await controlRequest(sockOf(runId), { cmd: 'status' }).catch(() => null))?.ok)
  await controlRequest(sockOf(runId), { cmd: 'cancel' })
  const first = await p1
  assert.equal(first.status, 'interrupted')
  assert.ok(fs.existsSync(path.join(runDir(runId), 'result.json')))
  const p2 = runWorkflow({ file: fx('cancel.workflow.js'), defaults: { adapter: 'mock' }, resumeId: runId, quiet: true })
  await until(async () => (await controlRequest(sockOf(runId), { cmd: 'status' }).catch(() => null))?.ok)
  // supervisors must see a live run, not the previous attempt's outcome
  assert.ok(!fs.existsSync(path.join(runDir(runId), 'result.json')))
  await controlRequest(sockOf(runId), { cmd: 'cancel' })
  assert.equal((await p2).status, 'interrupted')
})

test('invalid concurrency and budget are rejected before any work starts', async () => {
  await assert.rejects(
    runWorkflow({ file: fx('basic.workflow.js'), args: { x: 4 }, defaults: { adapter: 'mock' }, concurrency: Number.NaN, quiet: true }),
    /concurrency must be an integer/,
  )
  await assert.rejects(
    runWorkflow({ file: fx('basic.workflow.js'), args: { x: 4 }, defaults: { adapter: 'mock' }, budgetTotal: 1.5, quiet: true }),
    /budget must be an integer/,
  )
})

test('lexer: a quote inside a regex literal cannot hide a same-line computed import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexrx-'))
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const which = () => 1\n')
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'rx' }",
    'export default async ({ agent }) => {',
    "  const name = './a.js'",
    "  const ok = /'/.test(name); const m = ok ? await import(name) : null",
    "  return agent('ECHO ' + (m ? 'y' : 'n'))",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  // the mis-lexed line must journal the module as dynamic, never hide the import
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import/,
  )
})

test('lexer: a quoted "}" inside a template interpolation cannot hide an import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lextpl-'))
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const which = () => 1\n')
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'tpl' }",
    'export default async ({ agent }) => {',
    "  const name = './a.js'",
    '  const t = `x${ "}" && (await import(name)).which() }y`',
    "  return agent('ECHO ' + t.length)",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import/,
  )
})

test('lexer: clean interpolation with quoted braces but no import still resumes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexok-'))
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'ok' }",
    'const s = `a${ "}" + \'{\' }b`',
    "export default async ({ agent }) => agent('ECHO ' + s)",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'a}{b')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  const again = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, 'a}{b')
})

test('lexer: paired quotes across two regex literals cannot swallow the import between them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexrxpair-'))
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const which = () => 1\n')
  // the quote in the first regex pairs with the quote in the second — an
  // unmodeled regex would eat the import( between them as string text with no
  // EOL trigger to catch the mis-lex
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'rxpair' }",
    'export default async ({ agent }) => {',
    "  const name = './a.js'",
    '  let m = null',
    "  if (/'/.test(name)) { m = await import(name) } else { m = /'/ }",
    "  return agent('ECHO ' + (m ? 'y' : 'n'))",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import/,
  )
})

test('lexer: an unbalanced "}" inside an interpolation regex cannot hide an import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexrxtpl-'))
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const which = () => 1\n')
  // the } inside /}/ would pop the brace counter early, ending the
  // interpolation before the import is seen
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'rxtpl' }",
    'export default async ({ agent }) => {',
    "  const name = './a.js'",
    '  const t = `x${ /}/.test(name) && (await import(name)).which() }y`',
    "  return agent('ECHO ' + t.length)",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import/,
  )
})

test('lexer: ordinary division is not flagged dynamic and resumes cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexdiv-'))
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'div' }",
    'const a = 6',
    'const b = 3',
    'const label = `ratio ${ a / b } of ${ b / a }`',
    "export default async ({ agent }) => agent('ECHO ' + (a / b) + ':' + label.length)",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '2:14')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  const again = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, '2:14')
})

test('lexer: division after postfix ++ cannot swallow a same-line import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexinc-'))
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 1\n')
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'inc' }",
    'export default async ({ agent }) => {',
    '  let a = 1',
    "  const u = a++ / 2; const m = await import('./dep.js'); // don't mind me",
    "  return agent('ECHO ' + (u + m.V))",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '1.5')
  // the literal dynamic import must be hashed, not swallowed by a phantom regex
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /module imported by the workflow file has changed/,
  )
})

test('lexer: division after postfix -- cannot swallow a same-line import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexdec-'))
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 1\n')
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'dec' }",
    'export default async ({ agent }) => {',
    '  let a = 1',
    "  const u = a-- / 2; const m = await import('./dep.js'); // don't mind me",
    "  return agent('ECHO ' + (u + m.V))",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /module imported by the workflow file has changed/,
  )
})

test('lexer: prefix ++ before a quote-bearing regex cannot swallow a same-line import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexpreinc-'))
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 1\n')
  // ++ here is PREFIX (the grammar lexes a regex after it) — treating it as
  // expression-ending judged the `/` division, the regex-body quote opened a
  // phantom string, and with even quote parity the import vanished silently
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'preinc' }",
    'let n = ++/a"b/.x; import { V } from \'./dep.js\'; let s = "q" // x"y',
    "export default async ({ agent }) => agent('ECHO ' + V + s + n)",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '1qNaN')
  // the regex scan's universal swallow guard trips on the body quote — LOUD
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import|has changed/,
  )
})

test('lexer: prefix -- before a quote-bearing regex cannot swallow a same-line import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexpredec-'))
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 1\n')
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'predec' }",
    'let n = --/a"b/.x; import { V } from \'./dep.js\'; let s = "q" // x"y',
    "export default async ({ agent }) => agent('ECHO ' + V + s + n)",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import|has changed/,
  )
})

test('lexer: ASI makes ++ after a newline PREFIX — its quote-bearing regex goes loud, never swallows the import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexasiinc-'))
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 1\n')
  // [no LineTerminator here] forbids postfix across the break: ASI closes
  // `let n = a` and the ++ is PREFIX, so Node lexes /a"b/ as a regex. A
  // newline-blind lexer carried exprEnd=true across the break, judged the /
  // division, and the regex-body quote opened a phantom string that swallowed
  // the same-line import silently (even quote parity — no EOL trigger)
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'asiinc' }",
    'let a = 1',
    'let n = a',
    '++/a"b/.x; import { V } from \'./dep.js\'; let s = "q" // x"y',
    "export default async ({ agent }) => agent('ECHO ' + V + s + n)",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '1q1')
  // the regex scan's universal swallow guard trips on the body quote — LOUD
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import|has changed/,
  )
})

test('lexer: ASI makes -- after a newline PREFIX — same loud path as ++', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexasidec-'))
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 1\n')
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'asidec' }",
    'let a = 1',
    'let n = a',
    '--/a"b/.x; import { V } from \'./dep.js\'; let s = "q" // x"y',
    "export default async ({ agent }) => agent('ECHO ' + V + s + n)",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '1q1')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import|has changed/,
  )
})

test('lexer: prefix ++ after a newline routes / into a clean regex — the same-line import stays hashed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexasiok-'))
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 1\n')
  // quote-free regex body: the guard stays quiet, the regex is consumed as a
  // regex, and the import after it is SEEN and hashed — proof the fix routes
  // the / correctly instead of merely flagging everything dynamic
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'asiok' }",
    'let a = 1',
    'let n = a',
    "++/ab/.x; import { V } from './dep.js'",
    "export default async ({ agent }) => agent('ECHO ' + V + n)",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '11')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  const again = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /module imported by the workflow file has changed/,
  )
})

test('lexer: raw U+2028/U+2029 inside strings are content, not EOL — stays non-dynamic and resumes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexlsps-'))
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 1\n')
  // legal since ES2019: a raw LS/PS inside a ' or " string (and inside a
  // quoted span within an interpolation) is CONTENT — treating it as
  // end-of-line tripped the unterminated-string fail-safe and permanently
  // refused resume for loadable code
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'lsps' }",
    "import { V } from './dep.js'",
    'const s = \'a b\' + "c d"',
    "const t = `x${ 'p q'.length }y`",
    "export default async ({ agent }) => agent('ECHO ' + s.length + ':' + t + ':' + V)",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '6:x3y:1')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  const again = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, '6:x3y:1')
  // the same-line-of-file import stays hashed: an edited dep still refuses
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /module imported by the workflow file has changed/,
  )
})

test('lexer: a CR-only file cannot hide an import behind a // comment', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexcr-'))
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 1\n')
  // \r is the ONLY line terminator: Node sees three lines, a \n-only comment
  // scan saw one — everything after the // vanished from the graph and a
  // changed dep resumed unsoundly
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'),
    "export const meta = { name: 'cronly' } // c\r" +
    "import { V } from './dep.js'\r" +
    "export default async ({ agent }) => agent('ECHO v' + V)\r")
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'v1')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /module imported by the workflow file has changed/,
  )
})

test('lexer: import.source with a literal specifier is hashed — editing the wasm refuses resume', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexsrcphase-'))
  // a real (minimal) Wasm module: magic + version, plus a custom section
  // (id 0, size 3, name-len 1, name 'c') whose content byte 0x81 is INVALID
  // UTF-8 — lossy decoding collapses it to U+FFFD, so a string-based hash
  // cannot tell it apart from the 0x82 edit below; only a byte hash can
  const wasm = (b) => Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x63, b])
  fs.writeFileSync(path.join(dir, 'm.wasm'), wasm(0x81))
  // lexed as property access, import.source('./m.wasm') was invisible: the
  // module was neither hashed nor flagged, and an edited wasm resumed unsoundly
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'srcphase' }",
    'export default async ({ agent }) => {',
    "  const src = await import.source('./m.wasm')",
    "  return agent('ECHO ' + (src instanceof WebAssembly.Module))",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'true')
  // hashed, not flagged — and the wasm bytes are never lexed as JS
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  const again = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  // flip the invalid-UTF-8 custom-section byte 0x81 -> 0x82: still a valid
  // module, different bytes, IDENTICAL lossy-decoded string — only raw-byte
  // hashing catches the edit
  fs.writeFileSync(path.join(dir, 'm.wasm'), wasm(0x82))
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /module imported by the workflow file has changed/,
  )
})

test('lexer: import.source with a computed argument flags dynamic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexsrcdyn-'))
  fs.writeFileSync(path.join(dir, 'm.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'srcdyn' }",
    'export default async ({ agent }) => {',
    "  const name = './m.wasm'",
    '  const src = await import.source(name)',
    "  return agent('ECHO ' + (src instanceof WebAssembly.Module))",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import/,
  )
})

test('lexer: import.meta stays inert — no phantom call handling, resumes cleanly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexmeta-'))
  // only a `(` after the RECOGNIZED source/defer property arms call handling:
  // import.meta.url is plain property access and import.meta.resolve('…') is
  // an ordinary call whose string is NOT a specifier
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'metainert' }",
    'const here = import.meta.url',
    "const near = import.meta.resolve('./nothing.js')",
    "export default async ({ agent }) => agent('ECHO ' + (here.length > 0) + (near.length > 0))",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'truetrue')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  const again = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, 'truetrue')
})

test('lexer: object-literal division ("}" before "/") cannot silently hide a same-line import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexbrace-'))
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const V = 1\n')
  // grammar-undecidable without a parser: the lexer prefers regex here, so the
  // guard must turn the swallowed import into a loud refusal, never a silent resume
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'brace' }",
    'export default async ({ agent }) => {',
    "  const u = {n:1} / 2; const m = await import('./a.js'); // don't mind me",
    "  return agent('ECHO ' + (Number.isNaN(u) ? 'nan' : u) + m.V)",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import|has changed/,
  )
})

test('lexer: postfix division and a return-position regex stay non-dynamic and resume', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexctrl-'))
  // the control regex must be quote-free: a quote in ANY regex body now flags
  // dynamic by design (universal swallow guard) — that path has its own test
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'ctrl' }",
    'const half = (x) => { const y = x++ / 2; return y }',
    'const quo = String.fromCharCode(39)',
    'const pick = (s) => { return /b/.test(s) }',
    "export default async ({ agent }) => agent('ECHO ' + half(4) + ':' + pick('a' + quo + 'b'))",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '2:true')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  const again = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, '2:true')
})

test('lexer: a regex after an if-condition ")" cannot swallow a same-line import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexif-'))
  fs.mkdirSync(path.join(dir, 'a'))
  fs.writeFileSync(path.join(dir, 'a', 'b.js'), 'export const V = 1\n')
  // division-judged, the regex body's quote opens a phantom string that pairs
  // with the specifier's opening quote and eats the import with no EOL trigger
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'ifrx' }",
    'export default async ({ agent }) => {',
    '  const c = true, s = "a\'b"',
    '  let m = null',
    "  if (c) /a\\'b/.test(s) && (m = await import('./a/b.js')) // don't",
    "  return agent('ECHO ' + (m ? m.V : 0))",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '1')
  fs.writeFileSync(path.join(dir, 'a', 'b.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import|has changed/,
  )
})

test('lexer: a regex after a while-condition ")" cannot swallow a same-line import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexwhile-'))
  fs.mkdirSync(path.join(dir, 'a'))
  fs.writeFileSync(path.join(dir, 'a', 'b.js'), 'export const V = 1\n')
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'whilerx' }",
    'export default async ({ agent }) => {',
    '  const s = "a\'b"',
    '  let x = 1, m = null',
    "  while (x--) /a\\'b/.test(s) && (m = await import('./a/b.js')) // don't",
    "  return agent('ECHO ' + (m ? m.V : 0))",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '1')
  fs.writeFileSync(path.join(dir, 'a', 'b.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import|has changed/,
  )
})

test('lexer: statement-head paren tracking keeps division and clean condition regexes non-dynamic', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexstmt-'))
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'stmtctl' }",
    'const a = 6, b = 2',
    'const f = (x) => x * 4',
    'const half = (a + b) / 2',
    'const quarter = f(2) / 2',
    'const hit = (s) => { let r = 0; if (s) /ab/.test(s) && (r = 1); return r }',
    'const g = `q${ (() => { if (a) /ab/.test("zab"); return 7 })() }r`',
    "export default async ({ agent }) => agent('ECHO ' + half + ':' + quarter + ':' + hit('cabd') + ':' + g)",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '4:4:1:q7r')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  const again = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, '4:4:1:q7r')
})

test('lexer: an interpolation regex after an if-condition ")" cannot hide an import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexiftpl-'))
  fs.writeFileSync(path.join(dir, 'a.js'), 'export const which = () => 1\n')
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'iftpl' }",
    'export default async ({ agent }) => {',
    "  const name = './a.js', s = \"a'b\"",
    '  let m = null',
    "  const t = `x${ await (async () => { if (s) /a\\'b/.test(s) && (m = await import(name)) })() }y` + 'z'",
    "  return agent('ECHO ' + t.length + (m ? m.which() : 0))",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import/,
  )
})

test('lexer: a regex after a for-await-condition ")" cannot swallow a same-line import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexforawait-'))
  fs.mkdirSync(path.join(dir, 'a'))
  fs.writeFileSync(path.join(dir, 'a', 'b.js'), 'export const V = 1\n')
  // at the `(` the previous word is `await`, not `for` — one-word lookbehind
  // must still class the condition `)` as statement position
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'forawaitrx' }",
    "async function* gen() { yield \"a'b\" }",
    'export default async ({ agent }) => {',
    '  let m = null',
    "  for await (const x of gen()) /a\\'b/.test(x) && (m = await import('./a/b.js')) // don't",
    "  return agent('ECHO ' + (m ? m.V : 0))",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '1')
  fs.writeFileSync(path.join(dir, 'a', 'b.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import|has changed/,
  )
})

test('lexer: division after a keyword-named property cannot swallow a same-line import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexprop-'))
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 1\n')
  // after `.` the word `return` is a property name, not a keyword — the `/` is
  // division, never a regex opener that could eat the import
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'proprx' }",
    'export default async ({ agent }) => {',
    '  const obj = { return: 4 }',
    "  const u = obj.return / 2; const m = await import('./dep.js'); // don't mind me",
    "  return agent('ECHO ' + (u + m.V))",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '3')
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import|has changed/,
  )
})

test('lexer: keyword-named property division with no import stays non-dynamic and resumes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexpropctl-'))
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'propctl' }",
    'const obj = { return: 4 }',
    'const u = obj.return / 2',
    "export default async ({ agent }) => agent('ECHO ' + u)",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '2')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  const again = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, '2')
})

test('lexer: universal guard — a genuine quote-bearing regex flags dynamic (loud, not silent)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexquoterx-'))
  // documented trade: ANY regex body holding a quote or the `import` token
  // flags the module dynamic, so no mis-judged position can ever swallow an
  // import silently — the fresh run still completes, only resume refuses
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'quoterx' }",
    "const has = (s) => /'/.test(s)",
    'const quo = String.fromCharCode(39)',
    "export default async ({ agent }) => agent('ECHO ' + has('a' + quo + 'b'))",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'true')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import/,
  )
})

test('lexer: export-default regex cannot swallow a same-line import in a dependency', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexdflt-'))
  fs.mkdirSync(path.join(dir, 'h'))
  fs.writeFileSync(path.join(dir, 'h', 'x.js'), 'export default 1\n')
  // round-11 confirmed silent repro: `default` was absent from the enumerated
  // blocklist, so the `/` was judged division and the regex's quote opened a
  // phantom string that paired with the specifier's opening quote — the import
  // was swallowed with no EOL trigger (the trailing comment quote re-pairs the
  // rest of the line). NONEXPR classes `default` as regex position instead.
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export default /a"b/ ; import y from "./h/x.js" // "n\n')
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'dflt' }",
    "import rx from './dep.js'",
    "export default async ({ agent }) => agent('ECHO ' + rx.source)",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'a"b')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  fs.writeFileSync(path.join(dir, 'h', 'x.js'), 'export default 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import|has changed/,
  )
})

test('lexer: a regex after debugger cannot swallow a same-line import', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexdbg-'))
  fs.mkdirSync(path.join(dir, 'h'))
  fs.writeFileSync(path.join(dir, 'h', 'x.js'), 'export default 1\n')
  // same phantom-string swallow shape at another word the old blocklist missed
  fs.writeFileSync(path.join(dir, 'dep.js'), [
    'debugger',
    '/a"b/ ; import y from "./h/x.js" // "n',
    'export const val = y',
  ].join('\n') + '\n')
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'dbg' }",
    "import { val } from './dep.js'",
    "export default async ({ agent }) => agent('ECHO ' + val)",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '1')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  fs.writeFileSync(path.join(dir, 'h', 'x.js'), 'export default 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import|has changed/,
  )
})

test('lexer: export default of a plain value with ordinary division stays non-dynamic and resumes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexdfltctl-'))
  // the identifier between `default` and `/` ends the expression — division,
  // exactly as before the NONEXPR inversion
  fs.writeFileSync(path.join(dir, 'dep.js'), 'const n = 8\nexport default n / 2\n')
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'dfltctl' }",
    "import half from './dep.js'",
    "export default async ({ agent }) => agent('ECHO ' + half)",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '4')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  const again = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, '4')
})

test('lexer: division after a property named default keeps a same-line import hashed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexdfltprop-'))
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 1\n')
  // after `.` the word `default` is a property name, not a keyword — the dot
  // rule bypasses NONEXPR entirely and the `/` is division
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'dfltprop' }",
    'export default async ({ agent }) => {',
    '  const obj = { default: 4 }',
    "  const u = obj.default / 2; const m = await import('./dep.js'); // don't mind me",
    "  return agent('ECHO ' + (u + m.V))",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '3')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /module imported by the workflow file has changed/,
  )
})

test('lexer: a contextual word used as an identifier before division goes loud, never silent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexofdiv-'))
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 1\n')
  // deliberate trade of the closed NONEXPR surface: a variable literally named
  // `of` before `/` enters a regex scan, which trips the universal guard on
  // the specifier's quote — a loud dynamic refusal, never a silent resume
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'ofdiv' }",
    'export default async ({ agent }) => {',
    '  const of = 4',
    "  const u = of / 2; const m = await import('./dep.js'); // don't mind me",
    "  return agent('ECHO ' + (u + m.V))",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '3')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  fs.writeFileSync(path.join(dir, 'dep.js'), 'export const V = 2\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import|has changed/,
  )
})

test('run lock: a live pid that started after the lock was written is pid reuse, not the holder', async () => {
  const runId = 'flo_pidreuse'
  const dir = runDir(runId)
  fs.mkdirSync(dir, { recursive: true })
  // the recorded pid is live (this very process) but the lock claims it was
  // written long before that process started — only pid reuse explains that
  fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: process.pid, startedAt: 1 }))
  const out = await runWorkflow({ file: fx('basic.workflow.js'), args: { x: 77 }, defaults: { adapter: 'mock' }, runId, quiet: true })
  assert.equal(out.status, 'completed')
  assert.ok(!fs.existsSync(path.join(dir, 'run.lock')))
})

test('scratch: crash-left scratch files are swept even when resume preflight refuses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-scratch-'))
  const wf = path.join(dir, 'wf.workflow.js')
  fs.writeFileSync(wf, "export const meta = { name: 'sc' }\nexport default async ({ agent }) => agent('ECHO ok')\n")
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  const leftover = path.join(runDir(out.runId), 'scratch', 'crashed-turn.tmp')
  fs.writeFileSync(leftover, 'x')
  fs.writeFileSync(wf, "export const meta = { name: 'sc' }\nexport default async ({ agent }) => agent('ECHO changed')\n")
  await assert.rejects(
    runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /workflow file has changed/,
  )
  assert.ok(!fs.existsSync(leftover), 'scratch swept despite refused resume')
  // the refused resume must NOT clear the previous terminal state
  assert.ok(fs.existsSync(path.join(runDir(out.runId), 'result.json')))
})

test('spawn: send() on a cache-replayed agent reports dropped, not pending forever', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-spawnlate-'))
  const wf = path.join(dir, 'wf.workflow.js')
  fs.writeFileSync(wf, [
    "export const meta = { name: 'spawnlate' }",
    'export default async ({ spawn }) => {',
    "  const h = spawn('ECHO hi')",
    '  const r = await h.done',
    "  return r + ':' + h.send('late')",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.result, 'hi:dropped')
  // resume replays the agent from cache — no job ever starts, same semantics
  const again = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, 'hi:dropped')
})

test('spawn: mail queued before a cache replay settles is loudly logged as dropped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-spawndrop-'))
  const wf = path.join(dir, 'wf.workflow.js')
  fs.writeFileSync(wf, [
    "export const meta = { name: 'spawndrop' }",
    'export default async ({ spawn }) => {',
    "  const h = spawn('WAIT_MAIL')",
    "  const early = h.send('go')",
    '  const r = await h.done',
    "  return r + ':' + early",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.result, 'mail:go:pending')
  // resume: the agent replays from cache, so the queued 'go' can never deliver —
  // the run must say so instead of letting it evaporate
  const again = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, 'mail:go:pending')
  const logs = readJsonl(path.join(runDir(out.runId), 'events.jsonl'))
  assert.ok(logs.some((e) => e.type === 'log' && /1 queued message\(s\) dropped/.test(e.message) && /cache/.test(e.message)))
})

test('fresh run with an unbindable control socket still records a failed result', async () => {
  const prev = process.env.FLOWITION_HOME
  // sun_path caps around 104 bytes — a deep FLOWITION_HOME makes bind fail while
  // plain file writes in the same dir keep working
  process.env.FLOWITION_HOME = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-sock-')), 'x'.repeat(120))
  try {
    const runId = 'flo_nobind'
    await assert.rejects(
      runWorkflow({ file: fx('basic.workflow.js'), args: { x: 5 }, defaults: { adapter: 'mock' }, runId, quiet: true }),
      /control socket unavailable/,
    )
    const result = JSON.parse(fs.readFileSync(path.join(runDir(runId), 'result.json'), 'utf8'))
    assert.equal(result.status, 'failed')
    assert.ok(readJsonl(journalOf(runId)).some((e) => e.type === 'end' && e.status === 'failed'))
  } finally { process.env.FLOWITION_HOME = prev }
})

test('lexer: eval( and new Function( are runtime code construction — flagged dynamic, resume refuses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexeval-'))
  // eval("import('./dep.mjs')") executes an import the scanner cannot see —
  // string contents are DELIBERATELY inert (the design's core property), so
  // the whole class goes LOUD instead: eval( in code position flags dynamic
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'evaldyn' }",
    'export default async ({ agent }) => {',
    "  const v = eval('6 * 7')",
    "  return agent('ECHO ' + v)",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '42')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import/,
  )
  // new Function( — the same construction surface
  fs.writeFileSync(path.join(dir, 'fn.workflow.js'), [
    "export const meta = { name: 'fndyn' }",
    "const f = new Function('return 6 * 7')",
    "export default async ({ agent }) => agent('ECHO ' + f())",
  ].join('\n') + '\n')
  const g = await runWorkflow({ file: path.join(dir, 'fn.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(g.status, 'completed')
  assert.equal(g.result, '42')
  assert.equal(readJsonl(journalOf(g.runId))[0].graphDynamic, true)
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'fn.workflow.js'), defaults: { adapter: 'mock' }, resumeId: g.runId, quiet: true }),
    /computed dynamic import/,
  )
  // and inside a template interpolation — the inner lexer applies the same rule
  fs.writeFileSync(path.join(dir, 'tpl.workflow.js'), [
    "export const meta = { name: 'evaltpl' }",
    "const t = `v=${ eval('2 + 3') }`",
    "export default async ({ agent }) => agent('ECHO ' + t)",
  ].join('\n') + '\n')
  const tp = await runWorkflow({ file: path.join(dir, 'tpl.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(tp.status, 'completed')
  assert.equal(tp.result, 'v=5')
  assert.equal(readJsonl(journalOf(tp.runId))[0].graphDynamic, true)
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'tpl.workflow.js'), defaults: { adapter: 'mock' }, resumeId: tp.runId, quiet: true }),
    /computed dynamic import/,
  )
})

test('lexer: property-access eval and the word eval inside strings stay clean and resume', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexevalok-'))
  const note = 'agents may call eval(x) or new Function(y) in prompts'
  // obj.eval(x) is property access (the dot rule clears the keyword) and the
  // WORD eval inside a string is inert content — neither may poison resume
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'evalclean' }",
    `const note = ${JSON.stringify(note)}`,
    'export default async ({ agent }) => {',
    '  const obj = { eval: (s) => s.length }',
    "  const n = obj.eval('abc')",
    "  return agent('ECHO ' + n + ':' + note.length)",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '3:' + note.length)
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  const again = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, '3:' + note.length)
})

test('lexer: bare Function( — no `new` — is the same constructor, flagged dynamic; obj.Function stays clean', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-lexbarefn-'))
  // Function('...') without `new` constructs the identical function (ES
  // 20.2.1.1) — a detector requiring the `new` would let it escape the
  // runtime-code-construction flag
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'), [
    "export const meta = { name: 'barefn' }",
    "const f = Function('return 6 * 7')",
    "export default async ({ agent }) => agent('ECHO ' + f())",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, '42')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import/,
  )
  // and inside a template interpolation — the inner lexer applies the same rule
  fs.writeFileSync(path.join(dir, 'tpl.workflow.js'), [
    "export const meta = { name: 'barefntpl' }",
    "const t = `v=${ Function('return 5')() }`",
    "export default async ({ agent }) => agent('ECHO ' + t)",
  ].join('\n') + '\n')
  const tp = await runWorkflow({ file: path.join(dir, 'tpl.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(tp.status, 'completed')
  assert.equal(tp.result, 'v=5')
  assert.equal(readJsonl(journalOf(tp.runId))[0].graphDynamic, true)
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'tpl.workflow.js'), defaults: { adapter: 'mock' }, resumeId: tp.runId, quiet: true }),
    /computed dynamic import/,
  )
  // obj.Function(x) is property access — the dot rule keeps it clean, same as obj.eval
  fs.writeFileSync(path.join(dir, 'ok.workflow.js'), [
    "export const meta = { name: 'fnclean' }",
    'export default async ({ agent }) => {',
    '  const obj = { Function: (s) => s.length }',
    "  const n = obj.Function('abc')",
    "  return agent('ECHO ' + n)",
    '}',
  ].join('\n') + '\n')
  const ok = await runWorkflow({ file: path.join(dir, 'ok.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(ok.status, 'completed')
  assert.equal(ok.result, '3')
  assert.equal(readJsonl(journalOf(ok.runId))[0].graphDynamic, false)
  const okAgain = await runWorkflow({ file: path.join(dir, 'ok.workflow.js'), defaults: { adapter: 'mock' }, resumeId: ok.runId, quiet: true })
  assert.equal(okAgain.status, 'completed')
  assert.equal(okAgain.result, '3')
})

test('mail: a same-callsite re-send stays a true replay even when recovery adds sends before it (identity = key+sender+callsite+text+ordinal)', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-mailseq-'))
  const wf = path.join(dir, 'wf.workflow.js')
  const flag = path.join(dir, 'first-run-done')
  // First run: 'go' is delivered from its sendTo line. Resumed run: control
  // flow legitimately changes (flag file, modeling a retried branch
  // succeeding) and sends 'prep' first from a DIFFERENT line, then re-executes
  // the SAME 'go' line. Ordinals count per (sender, callsite), so the new
  // preceding send cannot shift the 'go' line's ordinal: its re-send still
  // matches the pre-crash delivery exactly and absorbs (the continued session
  // already holds it), while 'prep' — its own call site's first send — goes
  // out fresh.
  fs.writeFileSync(wf, [
    "import fs from 'node:fs'",
    "export const meta = { name: 'mailseq' }",
    'export default async ({ spawn, sendTo }) => {',
    `  const first = !fs.existsSync(${JSON.stringify(flag)})`,
    `  if (first) fs.writeFileSync(${JSON.stringify(flag)}, '1')`,
    "  const h = spawn('SLEEP 300\\nWAIT_MAIL', { label: 'worker' })",
    '  let d1 = null',
    '  let d2 = null',
    "  if (!first) while ((d1 = sendTo('worker', 'prep')) === false) await new Promise((r) => setTimeout(r, 10))",
    "  while ((d2 = sendTo('worker', 'go')) === false) await new Promise((r) => setTimeout(r, 10))",
    '  const r = await h.done',
    "  return r + '|' + d1 + '|' + d2",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.match(out.result, /^mail:go\|null\|(live|queued)$/)
  const sent = readJsonl(journalOf(out.runId)).find((e) => e.type === 'mail')
  assert.equal(sent.origin, 'workflow')
  assert.equal(sent.seq, 1, 'workflow mail carries its per-(sender,callsite) send ordinal')
  assert.match(sent.callsite ?? '', /wf\.workflow\.js:\d+:\d+$/, 'workflow mail records its call site')
  assert.ok(readJsonl(journalOf(out.runId)).some((e) => e.type === 'mail-done' && e.id === sent.id), 'delivered in the first run')
  // crash window: delivery journaled, the attempt's result record lost
  doctorJournal(out.runId, (e) => e.type === 'end' || (e.type === 'result' && e.key === sent.key))
  const again = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  const parts = again.result.split('|')
  const [d1, d2] = parts.slice(-2)
  assert.match(d1, /^(live|queued)$/, `different-callsite send goes out fresh: ${again.result}`)
  assert.equal(d2, 'replayed', `the same-callsite ordinal-1 re-send absorbs against the delivery: ${again.result}`)
  const after = readJsonl(journalOf(out.runId))
  assert.equal(after.filter((e) => e.type === 'mail' && e.text === 'go').length, 1, 'the absorbed re-send journals nothing')
  const prep = after.find((e) => e.type === 'mail' && e.text === 'prep')
  assert.equal(prep.seq, 1, "the new send is its own call site's first")
  assert.notEqual(prep.callsite, sent.callsite, 'a different call site')
  assert.ok(after.some((e) => e.type === 'mail-done' && e.id === prep.id && !e.dropped && !e.skipped), 'the fresh send delivered')
})

test('mail: legacy seq-less journal records keep text-only replay matching', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-mailseqlegacy-'))
  fs.writeFileSync(path.join(dir, 'journal.jsonl'), [
    { t: 1, type: 'started', key: 'k', index: 0 },
    // pre-seq record: journaled by an older engine, delivered before the crash
    { t: 2, type: 'mail', key: 'k', id: 'id-old', text: 'guide', origin: 'workflow' },
    { t: 3, type: 'mail-done', key: 'k', id: 'id-old' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n')
  const st = Journal.load(dir)
  assert.deepEqual(st.deliveredWorkflowMail.get('k'), new Map([[wfMailKey('guide', null), 1]]))
  const appended = []
  const job = new AgentJob({
    adapter: { caps: {} }, spec: {}, prompt: 'p', index: 0, key: 'k', label: null,
    runId: 'flo_seqlegacy', scratch: '', transcript: { write: () => {} },
    journal: { append: (e) => appended.push(e) },
    priorSessionId: null, pendingMail: [], deliveredWorkflowMail: st.deliveredWorkflowMail.get('k'),
  })
  // the re-send carries seq 1, but the legacy entry absorbs on text alone
  assert.equal(job.send('guide', 'workflow'), 'replayed')
  assert.ok(!appended.some((e) => e.type === 'mail'), 'the absorbed re-send journals nothing')
  // exhausted: a second same-text send is a new logical send and goes out
  assert.equal(job.send('guide', 'workflow'), 'queued')
  assert.equal(appended.find((e) => e.type === 'mail')?.seq, 2, 'ordinals kept counting through the absorbed send')
})

test('mail: same-text same-ordinal sends from different branches are never cross-absorbed (sender identity)', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-mailsender-'))
  const wf = path.join(dir, 'wf.workflow.js')
  const flag = path.join(dir, 'first-run-done')
  // First run: parallel item 0 sends 'go' — the first send from ITS branch.
  // Resumed run: control flow changes (flag file) and item 1 sends 'go'
  // instead — also the first send from its own branch, so text AND ordinal
  // collide with item 0's crashed send. A sender-less identity would absorb
  // item 1's genuinely different logical send against item 0's restored copy
  // and starve the worker; the sender branch in the identity keeps the two
  // apart — the restored copy delivers AND the fresh send goes out. The root
  // branch's 'done' re-send stays a straight same-sender replay and absorbs.
  fs.writeFileSync(wf, [
    "import fs from 'node:fs'",
    "export const meta = { name: 'mailsender' }",
    'export default async ({ spawn, sendTo, parallel }) => {',
    `  const first = !fs.existsSync(${JSON.stringify(flag)})`,
    `  if (first) fs.writeFileSync(${JSON.stringify(flag)}, '1')`,
    "  const h = spawn('SLEEP 300\\nWAIT_MAIL\\nWAIT_MAIL', { label: 'worker' })",
    "  const send = async (text) => { let d; while ((d = sendTo('worker', text)) === false) await new Promise((r) => setTimeout(r, 10)); return d }",
    '  const [dA, dB] = await parallel([',
    "    async () => (first ? send('go') : null),",
    "    async () => (first ? null : send('go')),",
    '  ])',
    "  const dDone = await send('done')",
    '  const r = await h.done',
    "  return r + '|' + dA + '|' + dB + '|' + dDone",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.match(out.result, /^mail:done\|(live|queued)\|null\|(live|queued)$/)
  const entries = readJsonl(journalOf(out.runId))
  const goSent = entries.find((e) => e.type === 'mail' && e.text === 'go')
  const doneSent = entries.find((e) => e.type === 'mail' && e.text === 'done')
  assert.equal(goSent.origin, 'workflow')
  assert.ok(goSent.sender && doneSent.sender, 'workflow mail carries its sender branch')
  assert.notEqual(goSent.sender, doneSent.sender, 'item and root sends record different branches')
  assert.equal(goSent.seq, 1)
  assert.equal(doneSent.seq, 1, 'ordinals count per (key, sender, callsite), not per key')
  // both route through the one sendTo line inside the helper — the sender
  // branch alone keeps their identities apart
  assert.equal(goSent.callsite, doneSent.callsite, 'a shared helper is one call site')
  // crash window: item 0's 'go' was accepted but never became durable — the
  // root's 'done' delivery survives (its mail-done stays)
  doctorJournal(out.runId, (e) => e.type === 'end' || (e.type === 'result' && e.key === goSent.key) || (e.type === 'mail-done' && e.id === goSent.id))
  assert.equal(Journal.load(runDir(out.runId)).restoredWorkflowMail.get(goSent.key)?.get(wfMailKey('go', 1, goSent.sender, goSent.callsite)), 1)
  const again = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.match(again.result, /^mail:go\|null\|(live|queued)\|replayed$/,
    `the different-branch 'go' goes out fresh and the same-branch 'done' absorbs: ${again.result}`)
  const after = readJsonl(journalOf(out.runId))
  const goMails = after.filter((e) => e.type === 'mail' && e.text === 'go')
  assert.equal(goMails.length, 2, "item 1's send journals a fresh record beside the restored one")
  const freshGo = goMails.find((m) => m.id !== goSent.id)
  assert.equal(freshGo.seq, 1, "the first send from item 1's own branch")
  assert.notEqual(freshGo.sender, goSent.sender, 'a different sender branch')
  for (const m of goMails) {
    assert.ok(after.some((e) => e.type === 'mail-done' && e.id === m.id && !e.skipped && !e.dropped), `both same-text sends delivered: ${m.id}`)
  }
  assert.equal(after.filter((e) => e.type === 'mail' && e.text === 'done').length, 1, "the root's absorbed re-send journals nothing")
})

test('mail: sequential call sites in one branch never cross-absorb — an else-arm send is not the if-arm send (callsite identity)', { timeout: 30_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-mailcallsite-'))
  const wf = path.join(dir, 'wf.workflow.js')
  const flag = path.join(dir, 'first-run-done')
  // First run: the if-arm's 'go' is accepted and delivered but never became
  // durable (crash before the result record, its mail-done lost too — the
  // copy restores as pending). Recovery switches arms: the else-arm's 'go' is
  // a DIFFERENT logical send — same branch, same text, same per-sender
  // position, different line. Sender+ordinal identity alone would absorb it
  // against the restored copy and starve the worker of a send; the call site
  // in the identity keeps sequential call sites apart, so the restored copy
  // delivers AND the else-arm send goes out fresh. The root's 'done' re-send
  // is a true same-callsite replay and still absorbs exactly once.
  fs.writeFileSync(wf, [
    "import fs from 'node:fs'",
    "export const meta = { name: 'mailcallsite' }",
    'export default async ({ spawn, sendTo }) => {',
    `  const first = !fs.existsSync(${JSON.stringify(flag)})`,
    `  if (first) fs.writeFileSync(${JSON.stringify(flag)}, '1')`,
    "  const h = spawn('SLEEP 300\\nWAIT_MAIL\\nWAIT_MAIL', { label: 'worker' })",
    '  let d = null',
    '  if (first) {',
    "    while ((d = sendTo('worker', 'go')) === false) await new Promise((r) => setTimeout(r, 10))",
    '  } else {',
    "    while ((d = sendTo('worker', 'go')) === false) await new Promise((r) => setTimeout(r, 10))",
    '  }',
    '  let dDone = null',
    "  while ((dDone = sendTo('worker', 'done')) === false) await new Promise((r) => setTimeout(r, 10))",
    '  const r = await h.done',
    "  return r + '|' + d + '|' + dDone",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.match(out.result, /^mail:done\|(live|queued)\|(live|queued)$/)
  const entries = readJsonl(journalOf(out.runId))
  const goSent = entries.find((e) => e.type === 'mail' && e.text === 'go')
  const doneSent = entries.find((e) => e.type === 'mail' && e.text === 'done')
  assert.equal(goSent.sender, doneSent.sender, 'both sends come from the root branch')
  assert.match(goSent.callsite ?? '', /wf\.workflow\.js:\d+:\d+$/)
  assert.notEqual(goSent.callsite, doneSent.callsite, 'different lines are different call sites')
  assert.equal(goSent.seq, 1)
  assert.equal(doneSent.seq, 1, 'each call site counts its own ordinals')
  // crash window: the if-arm's 'go' was accepted but never became durable —
  // the root's 'done' delivery survives (its mail-done stays)
  doctorJournal(out.runId, (e) => e.type === 'end' || (e.type === 'result' && e.key === goSent.key) || (e.type === 'mail-done' && e.id === goSent.id))
  assert.equal(Journal.load(runDir(out.runId)).restoredWorkflowMail.get(goSent.key)?.get(wfMailKey('go', 1, goSent.sender, goSent.callsite)), 1)
  const again = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.match(again.result, /^mail:go\|(live|queued)\|replayed$/,
    `the else-arm 'go' goes out fresh beside the restored copy and the same-callsite 'done' absorbs: ${again.result}`)
  const after = readJsonl(journalOf(out.runId))
  const goMails = after.filter((e) => e.type === 'mail' && e.text === 'go')
  assert.equal(goMails.length, 2, "the else-arm's send journals a fresh record beside the restored one")
  const freshGo = goMails.find((m) => m.id !== goSent.id)
  assert.equal(freshGo.sender, goSent.sender, 'same sender branch')
  assert.equal(freshGo.seq, 1, "the else-arm call site's own first send")
  assert.notEqual(freshGo.callsite, goSent.callsite, 'a different call site')
  for (const m of goMails) {
    assert.ok(after.some((e) => e.type === 'mail-done' && e.id === m.id && !e.skipped && !e.dropped), `both same-text sends delivered: ${m.id}`)
  }
  assert.equal(after.filter((e) => e.type === 'mail' && e.text === 'done').length, 1, "the root's absorbed 'done' re-send journals nothing")
})

test('budget: completed usage still counts when resumed control flow skips the completed key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-budgetskip-'))
  const wf = path.join(dir, 'wf.workflow.js')
  const flag = path.join(dir, 'first-run-done')
  fs.writeFileSync(wf, [
    "import fs from 'node:fs'",
    "export const meta = { name: 'budgetskip' }",
    'export default async ({ agent }) => {',
    `  const first = !fs.existsSync(${JSON.stringify(flag)})`,
    `  if (first) fs.writeFileSync(${JSON.stringify(flag)}, '1')`,
    "  if (first) await agent('ECHO one')",
    "  return agent('ECHO two')",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  // crash window after agent one completed: agent two's records are lost (its
  // usage-cum records too, so the crash-window path stays out of this test)
  const two = readJsonl(journalOf(out.runId)).find((e) => e.type === 'result' && e.index === 1)
  doctorJournal(out.runId, (e) => e.type === 'end' || ((e.type === 'result' || e.type === 'usage-cum') && e.key === two.key))
  // resumed control flow SKIPS the completed 'ECHO one' key entirely, so its
  // 5 output tokens can only enter budget.spent() via the load-time aggregate —
  // the cache-hit replay path never runs. The pre-admission ceiling must fire.
  const again = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, budgetTotal: 5, quiet: true })
  assert.equal(again.status, 'failed')
  assert.match(again.error, /budget exceeded \(5\/5/, 'completed usage seeded into spent() before any admission')
})

test('budget: cache-hit replay does not double-count the pre-seeded completed usage', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-budgetseed-'))
  const wf = path.join(dir, 'wf.workflow.js')
  const flag = path.join(dir, 'first-run-done')
  fs.writeFileSync(wf, [
    "import fs from 'node:fs'",
    "export const meta = { name: 'budgetseed' }",
    'export default async ({ agent }) => {',
    `  const first = !fs.existsSync(${JSON.stringify(flag)})`,
    `  if (first) fs.writeFileSync(${JSON.stringify(flag)}, '1')`,
    "  const a = await agent('ECHO one')",
    "  let c = 'none'",
    "  if (!first) c = await agent('ECHO extra')",
    "  return a + ':' + c",
    '}',
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, budgetTotal: 6, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'one:none')
  doctorJournal(out.runId, (e) => e.type === 'end')
  // resume: 'ECHO one' replays from cache (5 output tokens, seeded once). If
  // the replay path ALSO charged it, spent() would read 10 >= 6 and refuse the
  // resumed-only agent; counted once, 5 < 6 admits it and the run completes.
  const again = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(again.result, 'one:extra')
})

test('usage: a crash after a usage event but before the result record still charges the window for a per-event adapter', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-cumwindow-'))
  const wf = path.join(dir, 'wf.workflow.js')
  fs.writeFileSync(wf, [
    "export const meta = { name: 'cumwindow' }",
    "export default async ({ agent }) => agent('ECHO one')",
  ].join('\n') + '\n')
  const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  // mock is non-cumulative: the job's running totals are journaled per usage
  // event, with no spurious zero-reset on a fresh run
  const cums = readJsonl(journalOf(out.runId)).filter((e) => e.type === 'usage-cum')
  assert.deepEqual(cums.map((e) => e.cum), [{ input: 10, output: 5 }])
  // a clean run's totals are unchanged: the chain is fully covered by the
  // result record, so nothing lands in the crash-window aggregate
  const clean = Journal.load(runDir(out.runId))
  assert.equal(clean.failedUsage.output, 0, 'no double count on a clean run')
  assert.equal(clean.completedUsage.output, 5)
  // crash window: the usage event was journaled, the result record was lost
  const res = readJsonl(journalOf(out.runId)).find((e) => e.type === 'result')
  doctorJournal(out.runId, (e) => e.type === 'end' || (e.type === 'result' && e.key === res.key))
  assert.equal(Journal.load(runDir(out.runId)).failedUsage.output, 5, 'window tokens recovered from the usage-cum chain')
  // resumed budget.spent() includes the window before any admission
  const again = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, budgetTotal: 5, quiet: true })
  assert.equal(again.status, 'failed')
  assert.match(again.error, /budget exceeded \(5\/5/)
  // a fatter budget lets the attempt re-run: the retried attempt journals a
  // zero-reset before its own totals so the chain charges full deltas
  const done = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, budgetTotal: 100, quiet: true })
  assert.equal(done.status, 'completed')
  const st = Journal.load(runDir(out.runId))
  assert.equal(st.completedUsage.output, 5, 'the re-run attempt recorded its own completed usage')
  assert.equal(st.failedUsage.output, 5, 'the crashed attempt keeps charging exactly its window — once')
})

test('sealed outcome: a post-completion telemetry error cannot rewrite a completed agent as failed', async () => {
  const { EventSink } = await import('../src/events.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-sealed-'))
  const wf = path.join(dir, 'wf.workflow.js')
  fs.writeFileSync(wf, [
    "export const meta = { name: 'sealed' }",
    'export default async ({ agent }) => {',
    "  const a = await agent('ECHO one')",
    "  const b = await agent('ECHO two')",
    "  return a + ':' + b",
    '}',
  ].join('\n') + '\n')
  // The sink dies exactly on the first agent's done event — inside the
  // post-record telemetry section. Before the seal, that throw fell into the
  // failure catch, charged the usage a second time, and appended a FAILED
  // result over the completed one (last-wins on replay: the completed work
  // re-ran on resume).
  const orig = EventSink.prototype.emit
  EventSink.prototype.emit = function (ev) {
    if (ev.type === 'agent' && ev.state === 'done' && ev.resultPreview === 'one') throw new Error('telemetry sink exploded')
    return orig.call(this, ev)
  }
  try {
    // budget 10 doubles as the charged-once probe: each mock agent reports 5
    // output tokens and admission refuses at spent >= total, so a double
    // charge of agent one (10) would refuse agent two.
    const out = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, budgetTotal: 10, quiet: true })
    assert.equal(out.status, 'completed')
    assert.equal(out.result, 'one:two')
    const results = readJsonl(journalOf(out.runId)).filter((e) => e.type === 'result')
    assert.equal(results.length, 2, 'exactly one result record per agent')
    assert.ok(results.every((e) => e.status === 'completed'), 'no failed record from the telemetry throw')
    const st = Journal.load(runDir(out.runId))
    assert.equal(st.completedUsage.output, 10)
    assert.equal(st.failedUsage.output, 0, 'usage charged once, as completed spend')
    assert.ok(readJsonl(path.join(runDir(out.runId), 'events.jsonl')).some((e) => e.type === 'log' && /post-completion telemetry error/.test(e.message)),
      'the swallowed error surfaces as a best-effort log event')
    // resume replays both agents from cache — no new attempt, no new records
    const again = await runWorkflow({ file: wf, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
    assert.equal(again.status, 'completed')
    assert.equal(again.result, 'one:two')
    assert.equal(readJsonl(journalOf(out.runId)).filter((e) => e.type === 'result').length, 2, 'resume replayed from cache without re-running')
  } finally {
    EventSink.prototype.emit = orig
  }
})

test('per-agent cancel journals status cancelled with usage, and emits state cancelled', async () => {
  const p = runWorkflow({ file: fx('cancel.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  const runId = await until(async () => {
    const ids = fs.readdirSync(path.join(process.env.FLOWITION_HOME, 'runs')).filter((d) => fs.existsSync(sockOf(d)))
    for (const id of ids) {
      const st = await controlRequest(sockOf(id), { cmd: 'status' }).catch(() => null)
      if (st?.ok && st.agents.some((a) => a.label === 'sleeper')) return id
    }
    return null
  })
  const res = await controlRequest(sockOf(runId), { cmd: 'cancel', agent: 'sleeper' })
  assert.ok(res.ok)
  const out = await p
  assert.equal(out.status, 'failed') // directly-awaited cancelled agent fails the workflow
  const entry = readJsonl(journalOf(runId)).find((e) => e.type === 'result' && e.status === 'cancelled')
  assert.ok(entry, 'cancelled result journaled')
  assert.ok(entry.usage, 'usage recorded on non-completed result')
  assert.ok(readJsonl(path.join(runDir(runId), 'events.jsonl')).some((e) => e.type === 'agent' && e.state === 'cancelled'))
})

test('lexer: a local CommonJS require chain is hashed — editing the nested dep refuses resume', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-cjs-'))
  fs.writeFileSync(path.join(dir, 'dep.cjs'), 'module.exports = { v: 1 }\n')
  // the workflow imports helper.cjs (hashed); helper's require('./dep.cjs')
  // used to escape the module graph entirely
  fs.writeFileSync(path.join(dir, 'helper.cjs'), "const dep = require('./dep.cjs')\nmodule.exports = { v: dep.v }\n")
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'),
    "import helper from './helper.cjs'\nexport const meta = { name: 'cjs' }\nexport default async ({ agent }) => agent('ECHO v' + helper.v)\n")
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(out.result, 'v1')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, false)
  const again = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  fs.writeFileSync(path.join(dir, 'dep.cjs'), 'module.exports = { v: 2 }\n')
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /module imported by the workflow file has changed/,
  )
})

test('lexer: computed require flags dynamic; obj.require and require-in-strings stay clean', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-cjsdyn-'))
  fs.writeFileSync(path.join(dir, 'dep.cjs'), 'module.exports = { v: 1 }\n')
  // computed require in a hashed CJS dep — cannot be followed statically
  fs.writeFileSync(path.join(dir, 'computed.cjs'), "const name = './de' + 'p.cjs'\nconst dep = require(name)\nmodule.exports = { v: dep.v }\n")
  fs.writeFileSync(path.join(dir, 'wf.workflow.js'),
    "import helper from './computed.cjs'\nexport const meta = { name: 'cjsdyn' }\nexport default async ({ agent }) => agent('ECHO v' + helper.v)\n")
  const out = await runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(readJsonl(journalOf(out.runId))[0].graphDynamic, true)
  await assert.rejects(
    runWorkflow({ file: path.join(dir, 'wf.workflow.js'), defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true }),
    /computed dynamic import/,
  )
  // a require( inside a template interpolation flags dynamic too (mirrored lexer)
  fs.writeFileSync(path.join(dir, 'interp.cjs'), 'module.exports = { s: `v${require(\'./dep.cjs\').v}` }\n')
  fs.writeFileSync(path.join(dir, 'wf2.workflow.js'),
    "import helper from './interp.cjs'\nexport const meta = { name: 'cjsinterp' }\nexport default async ({ agent }) => agent('ECHO ' + helper.s)\n")
  const t = await runWorkflow({ file: path.join(dir, 'wf2.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(t.status, 'completed')
  assert.equal(readJsonl(journalOf(t.runId))[0].graphDynamic, true)
  // control: property access is not the CJS loader — stays clean and resumes
  fs.writeFileSync(path.join(dir, 'ctrl.workflow.js'),
    "export const meta = { name: 'cjsctrl' }\nconst obj = { require: (x) => x }\nexport default async ({ agent }) => agent('ECHO ' + obj.require('ok') + ' require(x) in prose')\n")
  const c = await runWorkflow({ file: path.join(dir, 'ctrl.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(c.status, 'completed')
  assert.equal(readJsonl(journalOf(c.runId))[0].graphDynamic, false)
  const c2 = await runWorkflow({ file: path.join(dir, 'ctrl.workflow.js'), defaults: { adapter: 'mock' }, resumeId: c.runId, quiet: true })
  assert.equal(c2.status, 'completed')
})

test('run dir is created 0o700 — artifacts unreachable by other local users', { skip: process.platform === 'win32' }, async () => {
  const out = await runWorkflow({ file: fx('basic.workflow.js'), args: { x: 700 }, defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(out.status, 'completed')
  assert.equal(fs.statSync(runDir(out.runId)).mode & 0o777, 0o700)
  assert.equal(fs.statSync(path.join(runDir(out.runId), 'scratch')).mode & 0o777, 0o700)
  // an existing wide-open run dir is tightened at the next engine acquisition
  fs.chmodSync(runDir(out.runId), 0o755)
  const again = await runWorkflow({ file: fx('basic.workflow.js'), args: { x: 700 }, defaults: { adapter: 'mock' }, resumeId: out.runId, quiet: true })
  assert.equal(again.status, 'completed')
  assert.equal(fs.statSync(runDir(out.runId)).mode & 0o777, 0o700)
})

test('parallel() and pipeline() refuse promises where thunks/stages are expected', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-thunk-'))
  fs.writeFileSync(path.join(dir, 'par.workflow.js'),
    "export const meta = { name: 'par-promise' }\nexport default async ({ agent, parallel }) => parallel([agent('ECHO a')])\n")
  const p = await runWorkflow({ file: path.join(dir, 'par.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(p.status, 'failed')
  assert.match(p.error, /parallel\(\) takes an array of thunks \(functions returning promises\) — got a Promise; wrap calls as \(\) => agent\(\.\.\.\)/)
  fs.writeFileSync(path.join(dir, 'pipe.workflow.js'),
    "export const meta = { name: 'pipe-promise' }\nexport default async ({ agent, pipeline }) => pipeline(['a'], agent('ECHO b'))\n")
  const q = await runWorkflow({ file: path.join(dir, 'pipe.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(q.status, 'failed')
  assert.match(q.error, /pipeline\(\) stages must be functions — got a Promise/)
  // non-function, non-promise elements are named by type
  fs.writeFileSync(path.join(dir, 'str.workflow.js'),
    "export const meta = { name: 'par-string' }\nexport default async ({ parallel }) => parallel(['nope'])\n")
  const s = await runWorkflow({ file: path.join(dir, 'str.workflow.js'), defaults: { adapter: 'mock' }, quiet: true })
  assert.equal(s.status, 'failed')
  assert.match(s.error, /array of thunks .* got string/)
})
