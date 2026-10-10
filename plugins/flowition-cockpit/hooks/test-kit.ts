// The shared test harness: a mocked flowition CLI, run files and Bash tool behind the
// plugin's hooks. `w` is the world a test arranges (run states, statuses, Bash output,
// gates that hold a command mid-flight) and inspects (argv sent, toasts shown).
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
export const flo = (args: string) => ({ command: 'flo', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } })
export const PANE = (surface: 'terminal' | 'desktop') =>
  ({ plugin: 'flowition-cockpit', surface, component: 'Pane', requestId: 'flo', props: { title: 'Flowition', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} }, viewport: { columns: 160, rows: 40 } }) as const
export const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r) + '\n').join('')
export const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
type Gate = ReturnType<typeof deferred> | null

export function setup(on: On, opts: { files?: Record<string, string> } = {}) {
  const clock = mock.clock(on, { now: 100_000 })
  const w = {
    states: { flo_a: 'failed' } as Record<string, string>,
    files: { ...opts.files } as Record<string, string>,
    created: {} as Record<string, number>,
    createdAt: 1000,
    mtime: 1,
    // Bash: what the command prints, and what it does to the runs while it runs.
    output: 'started detached run flo_a',
    toolResult: null as any,
    isError: false,
    bashAction: null as (() => void) | null,
    duringBash: null as (() => void) | null,
    // status --json: from the states, agents and questions below, or `rawStatus` verbatim.
    agents: [] as object[],
    questions: [] as object[],
    rawStatus: null as string | null,
    events: '',
    transcript: '',
    workflows: [] as any[],
    cwd: '/home/t/project-a',
    launchCwds: [] as string[],
    failStarts: 0,
    completeOnLaunch: false,
    // Observed.
    toasts: [] as string[],
    calls: [] as string[][],
    cacheStates: [] as string[],
    // Gates: each holds the next such command until resolved, `…Entered` once it is held.
    gate: null as Gate,
    entered: null as Gate,
    listGate: null as Gate,
    listEntered: null as Gate,
    toolGate: null as Gate,
    toolEntered: null as Gate,
    threadGate: null as Gate,
    threadEntered: null as Gate,
    launchEntered: null as Gate,
    headGate: null as Gate,
    headEntered: null as Gate,
    armAfterStatus: false,
    gateAfterStatus: false,
  }
  mock.env(on, { HOME: '/home/t', FLOWITION_HOME: '/home/t/.flowition', FLOWITION_BIN: '/bin/flowition', PATH: '/usr/bin' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', ($, e) => ({ value: { kind: 'file', size: e.path.includes('/agents/') ? w.transcript.length : e.path.endsWith('events.jsonl') ? w.events.length : 0, mtimeMs: w.mtime, isLink: false } }))
  on('state.set', { plugin: 'flowition-cockpit', key: 'details' }, ($, e, next) => {
    w.cacheStates.push(e.value.flo_a?.state ?? 'empty')
    return next(e)
  })
  on('fs.list', ($, e) => ({ value: e.path.endsWith('/workflows') ? w.workflows : [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.scroll', () => ({}))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', { tool: 'Bash' }, async () => {
    w.duringBash?.()
    const gate = w.toolGate
    w.toolGate = null
    if (gate) {
      w.toolEntered?.resolve()
      await gate.promise
    }
    w.bashAction?.()
    const result = w.toolResult ?? w.output
    return w.isError ? { result, text: w.output, isError: true as const } : { result, text: w.output }
  })
  on('process.run', async ($, e) => {
    const argv = [...e.argv]
    w.calls.push(argv)
    if (argv[0] === 'pwd') return w.cwd === 'DENIED' ? { deny: 'pwd refused' } : ok(w.cwd + '\n')
    if (argv[0] === 'head') {
      const gate = w.headGate
      w.headGate = null
      if (gate) {
        w.headEntered?.resolve()
        await gate.promise
      }
      return ok(JSON.stringify({ t: 1, type: 'run', state: 'started', workflowFile: '/w.mjs' }))
    }
    if (argv[0] === '/bin/sh') {
      const s = argv[5]?.includes('/agents/') ? w.transcript : w.events
      const from = Number(argv[4]) - 1
      const result = ok(s.slice(from, from + Number(argv[6])))
      if (w.threadGate && argv[5]?.includes('/agents/0.jsonl')) {
        const gate = w.threadGate
        w.threadGate = null
        w.threadEntered?.resolve()
        await gate.promise
      }
      return result
    }
    if (argv[1] === 'runs') {
      const text = JSON.stringify(
        Object.entries(w.states)
          .map(([runId, state]) => ({ runId, state, file: w.files[runId] ?? 'w.mjs', createdAt: w.created[runId] ?? w.createdAt }))
          .sort((a, b) => b.createdAt - a.createdAt),
      )
      const gate = w.listGate
      w.listGate = null
      if (gate) {
        w.listEntered?.resolve()
        await gate.promise
      }
      return ok(text)
    }
    if (argv[1] === 'status') {
      const runId = argv[2]!
      const text = w.rawStatus ?? JSON.stringify({ runId, state: w.states[runId], result: null, phases: [], agents: w.agents, steps: [], questions: w.questions, live: { ok: true, questions: w.questions } })
      const gate = w.gate
      w.gate = null
      if (gate) {
        w.entered?.resolve()
        await gate.promise
      }
      if (w.armAfterStatus) {
        w.armAfterStatus = false
        w.gateAfterStatus = true
      }
      return ok(text)
    }
    if (argv[1] === 'run') {
      if (w.failStarts > 0) {
        w.failStarts--
        return { value: { exitCode: 1, stdout: '', stderr: 'Could not start detached process: EAGAIN', isStdoutTruncated: false, isStderrTruncated: false } }
      }
      w.launchCwds.push(argv.includes('--cwd') ? argv[argv.indexOf('--cwd') + 1]! : (e.init?.cwd ?? w.cwd))
      w.launchEntered?.resolve()
      if (w.completeOnLaunch) w.states.flo_a = 'completed'
      return ok('{"runId":"flo_a","detached":true,"status":"started"}')
    }
    return ok('{"ok":true}')
  })
  return { w, clock }
}

// A world of an old completed run and a new one a launch names (flo_new), whose status a gate can hold (gatedId).
export function setupNewRun(on: On) {
  const clock = mock.clock(on, {now: 100_000})
  const w = { states: {flo_old:'completed'} as Record<string,string>, toasts: [] as string[], entered: null as ReturnType<typeof deferred>|null, gate: null as ReturnType<typeof deferred>|null, gatedId: 'flo_new', output:'started detached run flo_new', transcript:'', agents:[] as object[], questions:[] as object[], calls:[] as string[] }
  mock.env(on, {HOME:'/home/t',FLOWITION_HOME:'/home/t/.flowition',FLOWITION_BIN:'/bin/flowition',PATH:'/usr/bin'})
  on('session.start', ($,e)=>({cwd:e.cwd}))
  on('command.register', ($,e)=>({value:{command:e.name}}))
  on('fs.stat', ($,e)=>({value:{kind:'file', size:e.path.includes('/agents/')?w.transcript.length:0,mtimeMs:1,isLink:false}}))
  on('fs.list', ($,e)=>({value:e.path.endsWith('/workflows')?[{name:'demo.workflow.mjs',kind:'file',size:1,mtimeMs:1,isLink:false}]:[]}))
  on('ui.open',()=>({value:{isPlaced:true}}))
  on('ui.panes',()=>({value:[]}))
  on('ui.status',()=>({value:undefined}))
  on('ui.toast',($,e)=>{w.toasts.push(e.text);return {value:undefined}})
  on('ui.log',()=>({value:undefined}))
  on('ui.scroll',()=>({}))
  // (duringBash: what the command does while it runs, e.g. a resume making its run live.)
  on('tool.call', {tool:'Bash'},()=>{(w as {duringBash?:()=>void}).duringBash?.();return {result:w.output,text:w.output}})
  on('process.run', async ($,e)=>{
    const args=e.argv.slice(1).join(' '); w.calls.push(args)
    if(e.argv[0]==='/bin/sh') {const from=Number(e.argv[4])-1; return ok(w.transcript.slice(from,from+Number(e.argv[6])))}
    if(args==='runs --json') return ok(JSON.stringify(Object.entries(w.states).map(([runId,state])=>({runId,state,file:'demo.workflow.mjs',createdAt:runId==='flo_old'?1000:100_000}))))
    if(args.startsWith('status ')) {const runId=e.argv[2] as string; if(runId===w.gatedId&&w.gate) { w.entered?.resolve(); await w.gate.promise }
      return ok(JSON.stringify({runId,state:w.states[runId],result:null,agents:w.agents,steps:[],questions:runId==='flo_new'?w.questions:[],phases:[],live:runId==='flo_new'?{ok:true,questions:w.questions}:null}))}
    return ok('{"ok":true}')
  })
  return {w,clock}
}

// A world for resumes over real CLI output: per-run raw statuses, and `head` telling a run's journal (its metadata) from its events.
export function setupResume(on: On) {
  const clock=mock.clock(on,{now:100_000})
  const w={states:{flo_old:'completed',flo_new:'running'} as Record<string,string>,toasts:[] as string[],calls:[] as string[][],output:'started detached run flo_new',questions:[] as object[],agents:[] as object[],events:'' as string,transcript:'',rawStatuses:{} as Record<string,string>,head:JSON.stringify({t:1,type:'run',state:'started',workflowFile:'/w.mjs'}),journal:JSON.stringify({t:1,type:'meta',runId:'flo_old',workflowFile:'/w.mjs',args:{token:'secret'}}),toolGate:null as ReturnType<typeof deferred>|null,toolEntered:null as ReturnType<typeof deferred>|null}
  mock.env(on,{HOME:'/home/t',FLOWITION_HOME:'/home/t/.flowition',FLOWITION_BIN:'/bin/flowition',PATH:'/usr/bin'})
  on('session.start',($,e)=>({cwd:e.cwd}))
  on('command.register',($,e)=>({value:{command:e.name}}))
  on('fs.stat',($,e)=>({value:{kind:'file',size:e.path.includes('/agents/')?w.transcript.length:e.path.endsWith('events.jsonl')?w.events.length:0,mtimeMs:1,isLink:false}}))
  on('fs.list',()=>({value:[]}))
  on('ui.open',()=>({value:{isPlaced:true}}))
  on('ui.panes',()=>({value:[]}))
  on('ui.status',()=>({value:undefined}))
  on('ui.toast',($,e)=>{w.toasts.push(e.text);return {value:undefined}})
  on('ui.log',()=>({value:undefined}))
  on('ui.scroll',()=>({}))
  on('tool.call',{tool:'Bash'},async()=>{w.toolEntered?.resolve();if(w.toolGate)await w.toolGate.promise;return {result:w.output,text:w.output}})
  on('process.run',($,e)=>{
    const argv=[...e.argv];w.calls.push(argv)
    if(argv[0]==='head')return ok(argv[3]?.endsWith('journal.jsonl')?w.journal:w.head)
    if(argv[0]==='/bin/sh'){const file=argv[5]??'';const s=file.includes('/agents/')?w.transcript:w.events;const from=Number(argv[4])-1;return ok(s.slice(from,from+Number(argv[6])))}
    if(argv[1]==='runs')return ok(JSON.stringify(Object.entries(w.states).map(([runId,state])=>({runId,state,file:'w.mjs',createdAt:1000}))))
    if(argv[1]==='status'){const runId=argv[2]!;if(w.rawStatuses[runId])return ok(w.rawStatuses[runId]);return ok(JSON.stringify({runId,state:w.states[runId],result:null,phases:[],agents:w.agents,steps:[],questions:runId==='flo_new'?w.questions:[],live:{ok:true,questions:runId==='flo_new'?w.questions:[]}}))}
    if(argv[1]==='run')return ok('{"runId":"flo_old","detached":true,"status":"started"}')
    return ok('{"ok":true}')
  })
  return {w,clock}
}
