// Regressions from the gpt-6-astra (xhigh) review loop, round 8: Astra's reproductions, as written.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { extractRunIds, launchesIn, parseTranscript, appendEvents, emptyTimeline, foldTimeline, parseStatus, lifetimeWorkers, laneText, laneSvg } from './lib'

const ok=(stdout:string)=>({value:{exitCode:0,stdout,stderr:'',isStdoutTruncated:false,isStderrTruncated:false}})
const flo=(args:string)=>({command:'flo',args,origin:{kind:'composer' as const},presentation:{isFullscreen:true,columns:160}})
const PANE=(surface:'terminal'|'desktop')=>({plugin:'flowition-cockpit',surface,component:'Pane',requestId:'flo',props:{title:'Flowition',isFocused:false,bodyColumns:100,placement:'dock',scroll:{offset:0,bodyRows:30},view:{}},viewport:{columns:160,rows:40}}) as const
const jsonl=(rows:object[])=>rows.map(r=>JSON.stringify(r)+'\n').join('')
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}
function setup(on:On){
 const clock=mock.clock(on,{now:100_000})
 const w={armAfterStatus:false,gateAfterStatus:false,states:{flo_a:'failed'} as Record<string,string>,toasts:[] as string[],calls:[] as string[][],output:'started detached run flo_a',toolResult:null as any,questions:[] as object[],agents:[] as object[],events:'',transcript:'',gate:null as ReturnType<typeof deferred>|null,entered:null as ReturnType<typeof deferred>|null,createdAt:1000,rawStatus:null as string|null,completeOnLaunch:false,mtime:1,listGate:null as ReturnType<typeof deferred>|null,listEntered:null as ReturnType<typeof deferred>|null,created:{} as Record<string,number>,files:{} as Record<string,string>, toolGate:null as ReturnType<typeof deferred>|null, toolEntered:null as ReturnType<typeof deferred>|null}
 mock.env(on,{HOME:'/home/t',FLOWITION_HOME:'/home/t/.flowition',FLOWITION_BIN:'/bin/flowition',PATH:'/usr/bin'})
 on('session.start',($,e)=>({cwd:e.cwd}));on('command.register',($,e)=>({value:{command:e.name}}))
 on('fs.stat',($,e)=>({value:{kind:'file',size:e.path.includes('/agents/')?w.transcript.length:e.path.endsWith('events.jsonl')?w.events.length:0,mtimeMs:w.mtime,isLink:false}}))
 on('fs.list',()=>({value:[]}));on('ui.open',()=>({value:{isPlaced:true}}));on('ui.panes',()=>({value:[]}));on('ui.status',()=>({value:undefined}));on('ui.log',()=>({value:undefined}));on('ui.scroll',()=>({}))
 on('ui.toast',($,e)=>{w.toasts.push(e.text);return {value:undefined}})
 on('tool.call',{tool:'Bash'},async()=>{const gate=w.toolGate;w.toolGate=null;if(gate){w.toolEntered?.resolve();await gate.promise};return {result:w.toolResult??w.output,text:w.output}})
 on('process.run',async($,e)=>{
   const argv=[...e.argv];w.calls.push(argv)
   if(argv[0]==='head')return ok(JSON.stringify({t:1,type:'run',state:'started',workflowFile:'/w.mjs'}))
   if(argv[0]==='/bin/sh'){const s=argv[5]?.includes('/agents/')?w.transcript:w.events;const from=Number(argv[4])-1;return ok(s.slice(from,from+Number(argv[6])))}
   if(argv[1]==='runs'){const text=JSON.stringify(Object.entries(w.states).map(([runId,state])=>({runId,state,file:w.files[runId]??'w.mjs',createdAt:w.created[runId]??w.createdAt})).sort((a,b)=>b.createdAt-a.createdAt)); const gate=w.listGate;w.listGate=null;if(gate){w.listEntered?.resolve();await gate.promise};return ok(text)}
   if(argv[1]==='status'){
     const runId=argv[2]!;const text=w.rawStatus??JSON.stringify({runId,state:w.states[runId],result:null,phases:[],agents:w.agents,steps:[],questions:w.questions,live:{ok:true,questions:w.questions}})
     const gate=w.gate;w.gate=null;if(gate){w.entered?.resolve();await gate.promise}
     if(w.armAfterStatus){w.armAfterStatus=false;w.gateAfterStatus=true}
     return ok(text)
   }
   if(argv[1]==='run'){if(w.completeOnLaunch)w.states.flo_a='completed';return ok('{"runId":"flo_a","detached":true,"status":"started"}')}
   return ok('{"ok":true}')
 })
 return {w,clock}
}



for(const overlap of [false,true])test(`A2 renewed attachment during cache commit, overlap=${overlap}`,async($,on)=>{
 const {w,clock}=setup(on)
 const gate=deferred(),entered=deferred();let armed=false
 on('state.set',{plugin:'flowition-cockpit',key:'details'},async($,e,next)=>{
   if(armed && e.value.flo_a?.workers.length){armed=false;entered.resolve();await gate.promise}
   return next(e)
 })
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
 const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'});w.toasts=[]
 armed=overlap
 // A normal forced poll changes the failed worker's detail, before the user resumes.
 w.agents=[{index:0,label:'Writer',state:'failed',error:'old attempt failed'}]
 let refreshing:Promise<unknown>|undefined
 if(overlap){refreshing=ui.press({key:'refresh'});await entered.promise}
 w.states.flo_a='completed'
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --resume flo_a --detach'})
 gate.resolve();if(refreshing)await refreshing
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(1)
 await ui.unmount()
})
for(const mixed of [false,true])test(`A15 mixed known and unresolved background launches, mixed=${mixed}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output=mixed?'started detached run flo_fast\nCommand was moved to the background (ID: task1)':'Command was moved to the background (ID: task1)'
 w.toolResult={stdout:mixed?'started detached run flo_fast\n':'',stderr:'',interrupted:false,backgroundTaskId:'task1'}
 await $.tool.call({tool:'Bash',command:mixed?'flowition run slow.mjs --json & flowition run fast.mjs --detach; wait':'flowition run slow.mjs --json'})
 w.states={flo_slow:'running',...(mixed?{flo_fast:'running'}:{})};w.files={flo_slow:'slow.mjs',flo_fast:'fast.mjs'};w.mtime++
 w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_slow asks: Need input')).toHaveLength(1)
 if(mixed)expect(w.toasts.filter(t=>t==='flo_fast asks: Need input')).toHaveLength(1)
 await ui.unmount()
})
for(const [name,command,file] of [
 ['plain','flowition run wanted.mjs --json','wanted.mjs'],
 ['option-first','flowition run --json wanted.mjs','wanted.mjs'],
 ['space-path','flowition run "/my workflows/wanted.mjs" --json','wanted.mjs'],
 ['quoted-name','flowition run "my workflow.mjs" --json','my workflow.mjs'],
] as const)test(`A20 background workflow extraction ${name}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output='Command running in background with ID: task1';w.toolResult={stdout:'',stderr:'',interrupted:false,backgroundTaskId:'task1'}
 await $.tool.call({tool:'Bash',command})
 w.states={flo_new:'running'};w.files={flo_new:file};w.mtime++;w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_new asks: Need input')).toHaveLength(1)
 await ui.unmount()
})

for(const overlap of [false,true])test(`A2 unchanged terminal poll commit/read race, overlap=${overlap}`,async($,on)=>{
 const {w,clock}=setup(on);const gate=deferred(),entered=deferred()
 on('state.get',{plugin:'flowition-cockpit',key:'details'},async($,e,next)=>{
   if(w.gateAfterStatus){w.gateAfterStatus=false;entered.resolve();await gate.promise};return next(e)
 })
 w.agents=[{index:0,label:'Writer',state:'failed',error:'old attempt failed'}]
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
 const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'});w.toasts=[]
 let refreshing:Promise<unknown>|undefined
 if(overlap){w.armAfterStatus=true;refreshing=ui.press({key:'refresh'});await entered.promise}
 w.states.flo_a='completed'
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --resume flo_a --detach'})
 gate.resolve();if(refreshing)await refreshing
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(1)
 await ui.unmount()
})
for(const shellBackground of [false,true])test(`A17 shell-managed background launch, shellBackground=${shellBackground}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output=shellBackground?'':'Command running in background with ID: task1'
 w.toolResult={stdout:'',stderr:'',interrupted:false,...(shellBackground?{}:{backgroundTaskId:'task1'})}
 await $.tool.call({tool:'Bash',command:shellBackground?'flowition run w.mjs --json > /tmp/w.log 2>&1 &':'flowition run w.mjs --json',...(!shellBackground?{run_in_background:true}:{})})
 w.states={flo_new:'running'};w.mtime++;w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_new asks: Need input')).toHaveLength(1)
 await ui.unmount()
})

test('A20: launches are read with the shell\'s words and the CLI\'s option grammar', async () => {
  const of = (c: string) => launchesIn(c).invocations.map((v) => [v.file, v.target, v.isBackground])
  expect(of('flowition run --json wanted.mjs')).toEqual([['wanted.mjs', null, false]])
  expect(of('flowition run --cwd /tmp/x --args \'{"a":1}\' "my flows/report v2.workflow.mjs" --detach')).toEqual([['report v2.workflow.mjs', null, false]])
  expect(of('cd w && FOO=1 flowition run a\\ b.mjs > /tmp/l 2>&1 & flo resume flo_9; flowition run w.mjs --resume=flo_8 --detach')).toEqual([['a b.mjs', null, true], [null, 'flo_9', false], [null, 'flo_8', false]])
  expect(of('flowition run "$WF" && flowition run *.mjs')).toEqual([[null, null, false], [null, null, false]])
  expect(of('echo flowition run x.mjs | cat')).toEqual([])
})
