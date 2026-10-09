// Regressions from the gpt-6-astra (xhigh) review loop, round 2: Astra's own reproductions,
// kept as written (its harness), each failing on the code before its fix (A8 is a control).
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { boundThread, resumeTarget } from './lib'
const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const flo = (args: string) => ({ command: 'flo', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } })
const PANE = (surface: 'terminal' | 'desktop') => ({ plugin: 'flowition-cockpit', surface, component: 'Pane', requestId: 'flo', props: { title: 'Flowition', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} }, viewport: { columns: 160, rows: 40 } }) as const
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }
function setup(on: On) {
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
for (const discovered of [false,true]) {
  test(`A2 discovery overlap: listed before attach = ${discovered}`,async($,on)=>{
    const {w}=setup(on)
    w.states.flo_old='running';w.gatedId='flo_old'
    await $.command.run(flo('flo_old'))
    const ui=await $.ui.mount(PANE('terminal'))
    if(discovered) w.states.flo_new='running'
    w.gate=deferred();w.entered=deferred()
    const poll=ui.press({key:'refresh'})
    await w.entered.promise
    await $.tool.call({tool:'Bash',command:'flowition run demo.workflow.mjs --detach'})
    w.states.flo_new='completed'
    w.gate.resolve();await poll;w.gate=null
    await ui.press({key:'refresh'})
    expect(w.toasts.filter(t=>t.includes('flo_new')&&t.includes('completed'))).toHaveLength(1)
    await ui.unmount()
  })
}
test('A6: plain foreground resume output attaches its run',async($,on)=>{
  const {w}=setup(on)
  await $.command.run(flo(''))
  // Exact event/final-line shapes emitted by EventSink and cli.js case resume.
  w.output='▶ run flo_old — resumed\n▶ run flo_old — completed\n\nrun flo_old: completed\nok\n'
  await $.tool.call({tool:'Bash',command:'flowition resume flo_old'})
  await $.command.run(flo('flo_old')); const ui=await $.ui.mount(PANE('terminal')); expect(await ui.find({text:/launched here/})).toBeDefined(); await ui.unmount()
})
test('A6: backgrounded foreground resume attaches despite old createdAt',async($,on)=>{
  const {w,clock}=setup(on)
  await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
  w.output='Command running in background with ID: abc'
  ;(w as {duringBash?:()=>void}).duringBash=()=>{w.states.flo_old='running'}
  await $.tool.call({tool:'Bash',command:'flowition resume flo_old'})
  await clock.advance(20_000)
  await $.command.run(flo('flo_old')); const ui=await $.ui.mount(PANE('terminal')); expect(await ui.find({text:/launched here/})).toBeDefined(); await ui.unmount()
})
for(const fragmented of [false,true]) test(`A5: same long reply keeps its newest text (fragmented=${fragmented})`,async($,on)=>{
  const {w}=setup(on)
  w.states.flo_old='running';w.agents=[{index:0,label:'Writer',state:'running'}]
  const text='x'.repeat(9000)+'FINAL RECOMMENDATION'; const chunks=fragmented?[text.slice(0,4000),text.slice(4000,8000),text.slice(8000)]:[text]; w.transcript=chunks.map((text,i)=>JSON.stringify({t:i+1,kind:'text',text})+'\n').join('')
  await $.command.run(flo('flo_old'))
  const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'agent:0'})
  expect((await ui.findAll({type:'Markdown'})).map(m=>m.text).join('').includes('FINAL RECOMMENDATION')).toBe(true)
  await ui.unmount()
})
for(const redacted of [false,true]) test(`A7: visible reasoning survives (adjacent redaction=${redacted})`,async($,on)=>{
  const {w}=setup(on)
  w.states.flo_old='running';w.agents=[{index:0,label:'Writer',state:'running'}]
  w.transcript=[{t:1,kind:'reasoning',text:'Visible reasoning'}, ...(redacted?[{t:2,kind:'reasoning',text:'',redacted:true}]:[])].map(x=>JSON.stringify(x)).join('\n')+'\n'
  await $.command.run(flo('flo_old'))
  const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'agent:0'})
  expect(await ui.find({text:/Visible reasoning/})).toBeDefined()
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`A8: Enter uses submitted args while a prior change is still persisting (${surface})`,async($,on)=>{
    const {w,clock}=setup(on)
    const gate=deferred(),entered=deferred()
    let hold=false
    on('state.set',{plugin:'flowition-cockpit',key:'launch'},async($,e,next)=>{
      if(hold && e.value?.args==='{"target":"B"}') {entered.resolve();await gate.promise}
      return next(e)
    })
    await $.command.run(flo(''))
    const ui=await $.ui.mount(PANE(surface))
    const press=async(key:string)=>{if(surface==='terminal')return ui.press({key});await ui.pointer({in:key,type:'down',x:1,y:0,button:'left'});await ui.pointer({in:key,type:'up',x:1,y:0,button:'left'})}
    const file='/home/t/.flowition/workflows/demo.workflow.mjs'
    await press('new');await press(surface==='terminal'?`wf-pick:${file}`:`wf:${file}`)
    await ui.input({key:`launch-args:${file}:0`,text:'{"target":"A"}',kind:'change'})
    hold=true
    const edit=ui.input({key:`launch-args:${file}:0`,text:'{"target":"B"}',kind:'change'})
    await entered.promise
    const submit=ui.input({key:`launch-args:${file}:0`,text:'{"target":"B"}',kind:'submit'})
    await clock.settle()
    hold=false;gate.resolve();await Promise.all([edit,submit])
    // (Since round 17 the launch also pins its folder with --cwd: not what this checks.)
    expect(w.calls.filter(c=>c.startsWith('run ')).map(c=>c.replace(/ --cwd \S+/,''))).toEqual([`run ${file} --args {"target":"B"} --detach --json`])
    await ui.unmount()
  })
}

test('A2 discovery overlap also permanently suppresses a pending question toast',async($,on)=>{
  const {w}=setup(on)
  w.states.flo_old='running';w.gatedId='flo_old'
  await $.command.run(flo('flo_old'));const ui=await $.ui.mount(PANE('terminal'))
  w.states.flo_new='running';w.gate=deferred();w.entered=deferred()
  const poll=ui.press({key:'refresh'});await w.entered.promise
  await $.tool.call({tool:'Bash',command:'flowition run demo.workflow.mjs --detach'})
  w.questions=[{qid:'q0',question:'Proceed?',t:100_010}]
  w.gate.resolve();await poll;w.gate=null
  await ui.press({key:'refresh'});await ui.press({key:'refresh'})
  expect(w.toasts.filter(t=>t.includes('flo_new asks: Proceed?'))).toHaveLength(1)
  await ui.unmount()
})

test('A5: a thread past $.state\'s room drops its oldest events, keeping the newest', async () => {
  const ev = (seq: number) => ({ seq, t: seq, kind: 'text', text: 'x'.repeat(20_000), name: null, summary: null, input: null, output: null, isError: false, toolId: null, toolUseId: null, redacted: false, attempt: null })
  const all = Array.from({ length: 200 }, (_, i) => ev(i))
  const kept = boundThread(all)
  expect([kept.isCut, JSON.stringify(kept.events).length <= 2_500_000, kept.events.at(-1)?.seq]).toEqual([true, true, 199])
})

test('A6: a resume names its run on the command line', async () => {
  expect(['flowition resume flo_a1', 'cd x && flo resume flo_a1 --json', 'flowition run w.mjs --resume flo_a1 --detach', 'flowition run w.mjs --resume=flo_a1', 'flowition run w.mjs --detach'].map(resumeTarget)).toEqual(['flo_a1', 'flo_a1', 'flo_a1', 'flo_a1', null])
})
