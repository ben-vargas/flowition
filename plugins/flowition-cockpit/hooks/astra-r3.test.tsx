// Regressions from the gpt-6-astra (xhigh) review loop, round 3: Astra's reproductions over real
// CLI output (astra-fixtures.ts). Its harness's `head` now tells journal.jsonl (the run's metadata,
// naming its workflow file) from events.jsonl, which the A9 fallback reads.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { statuses, spendEvents, prestartEvent } from './astra-fixtures'
import { foldTimeline, emptyTimeline, parseStatus, lifetimeWorkers, appendEvents, parseTranscript } from './lib'
const ok = (stdout: string) => ({value:{exitCode:0,stdout,stderr:'',isStdoutTruncated:false,isStderrTruncated:false}})
const flo = (args: string) => ({command:'flo',args,origin:{kind:'composer' as const},presentation:{isFullscreen:true,columns:160}})
const PANE = (surface: 'terminal'|'desktop') => ({plugin:'flowition-cockpit',surface,component:'Pane',requestId:'flo',props:{title:'Flowition',isFocused:false,bodyColumns:100,placement:'dock',scroll:{offset:0,bodyRows:30},view:{}},viewport:{columns:160,rows:40}}) as const
const jsonl = (rows:object[]) => rows.map(r=>JSON.stringify(r)+'\n').join('')
const deferred = () => {let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}
function setup(on: On) {
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
for(const cached of [false,true])test(`A2: auto-attach after a poll committed the pending question, cached=${cached}`,async($,on)=>{
  const {w}=setup(on)
  w.questions=[{qid:'q0',question:'Ship it?',t:100_001}]
  if(!cached)delete w.states.flo_new
  await $.command.run(flo('flo_old'));const ui=await $.ui.mount(PANE('terminal'))
  w.states.flo_new='running'
  await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
  await ui.press({key:'refresh'});await ui.press({key:'refresh'})
  expect(w.toasts.filter(t=>t==='flo_new asks: Ship it?')).toHaveLength(1)
  await ui.unmount()
})
for(const cached of [false,true])test(`A2: auto-attach after a poll committed completion, cached=${cached}`,async($,on)=>{
  const {w}=setup(on)
  if(!cached)delete w.states.flo_new
  await $.command.run(flo('flo_old'));const ui=await $.ui.mount(PANE('terminal'))
  w.states.flo_new='completed'
  if(cached)await ui.press({key:'refresh'})
  await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
  await ui.press({key:'refresh'});await ui.press({key:'refresh'})
  expect(w.toasts.filter(t=>t==='flo_new completed')).toHaveLength(1)
  await ui.unmount()
})
for(const initialEvent of ['started','failed'])test(`A9: a run with a journal can resume when its first event is ${initialEvent}`,async($,on)=>{
  const {w}=setup(on)
  w.states={flo_old:'failed'}
  w.head=initialEvent==='started'?JSON.stringify({t:1,type:'run',state:'started',workflowFile:'/w.mjs'}):JSON.stringify({t:1,type:'run',runId:'flo_old',state:'failed',error:'workflow module failed to load: transient network failure'})
  await $.command.run(flo('flo_old'));const ui=await $.ui.mount(PANE('terminal'))
  await ui.press({key:'resume'});await ui.press({key:'resume-yes'})
  expect(w.calls.filter(a=>a[1]==='run'||a[1]==='resume')).toHaveLength(1)
  await ui.unmount()
})
test('A10: a new attempt must not show the previous attempt\'s unanswered tool call as running',async($,on)=>{
  const {w}=setup(on);w.states={flo_old:'running'};w.agents=[{index:0,label:'Worker',adapter:'codex',state:'running'}]
  w.transcript=jsonl([{t:1,kind:'meta',prompt:'p',attempt:1},{t:2,kind:'tool',name:'Bash',id:'old',input:{command:'OLD interrupted tool'}},{t:3,kind:'status',text:'failed: provider gone'},{t:4,kind:'attempt',n:2},{t:5,kind:'meta',prompt:'p',attempt:2},{t:6,kind:'tool',name:'Bash',id:'new',input:{command:'NEW current tool'}}])
  await $.command.run(flo('flo_old'));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'agent:0'})
  expect(await ui.findAll({type:'Text',text:'running…'})).toHaveLength(1)
  await ui.unmount()
})
test('A11: known output from a crashed attempt survives resume and final usage of a later attempt',async()=>{
  const events=jsonl([{t:100,type:'run',state:'started'},{t:110,type:'agent',index:0,state:'queued'},{t:120,type:'agent',index:0,state:'running'},{t:150,type:'agent',index:0,state:'progress',outputTokens:1200,lastOutputAt:150},{t:200,type:'run',state:'resumed'},{t:210,type:'agent',index:0,state:'queued'},{t:220,type:'agent',index:0,state:'running'},{t:250,type:'agent',index:0,state:'done',usage:{output:300,cost:0.03},outputTokens:300},{t:260,type:'run',state:'completed'}])
  const timeline=foldTimeline(emptyTimeline('flo_old'),events)
  const d=parseStatus(JSON.stringify({runId:'flo_old',state:'completed',agents:[{index:0,state:'done',t:250,usage:{output:300,cost:0.03},outputTokens:300,lastOutputAt:245}]}),300)
  expect(lifetimeWorkers(d.workers,timeline.lanes)[0]?.outputTokens).toBe(1500)
})

test('A11: real CLI status and complete events hide 1200 crash-window tokens in the pane',async($,on)=>{
  const {w}=setup(on);w.states={flo_spend:'completed'};w.rawStatuses={flo_spend:statuses.flo_spend};w.events=spendEvents
  await $.command.run(flo('flo_spend'));const ui=await $.ui.mount(PANE('terminal'))
  expect((await ui.find({key:'t:tokens'}))?.text).toBe('Output1.5k tokens')
  await ui.unmount()
})

test('A9: real CLI failed pre-start run with readable journal meta offers a resume that cannot launch',async($,on)=>{
  const {w}=setup(on);w.states={flo_prestart:'failed'};w.rawStatuses={flo_prestart:statuses.flo_prestart};w.head=prestartEvent;w.events=prestartEvent
  await $.command.run(flo('flo_prestart'));const ui=await $.ui.mount(PANE('terminal'))
  await ui.press({key:'resume'});await ui.press({key:'resume-yes'})
  expect(w.toasts.some(t=>t.includes('its first event names no workflow file'))).toBe(false)
  await ui.unmount()
})

test('A2: a real pending Bash launch lets polling commit the question before tool.call returns',async($,on)=>{
  const {w,clock}=setup(on);delete w.states.flo_new
  await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
  await $.command.run(flo('flo_old'));const ui=await $.ui.mount(PANE('terminal'))
  w.toolGate=deferred();w.toolEntered=deferred();w.output='Command running in background with ID: abc'
  const launching=$.tool.call({tool:'Bash',command:'flowition resume flo_new'})
  await w.toolEntered.promise
  w.states.flo_new='running';w.questions=[{qid:'q0',question:'Ship it?',t:100_001}]
  const polling=ui.press({key:'refresh'})
  await clock.settle()
  w.toolGate.resolve();await Promise.all([launching,polling])
  await clock.advance(10_000)
  expect(w.toasts.filter(t=>t==='flo_new asks: Ship it?')).toHaveLength(1)
  await ui.unmount()
})
