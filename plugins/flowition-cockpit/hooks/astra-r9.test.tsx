// Regressions from the gpt-6-astra (xhigh) review loop, round 9: Astra's reproductions, as written.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { extractRunIds, launchesIn, parseTranscript, appendEvents, emptyTimeline, foldTimeline, parseStatus, lifetimeWorkers, laneText, laneSvg, isFlowitionLaunch } from './lib'

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



for(const overlap of [false,true])test(`A2 poll beginning inside renewed attachment, overlap=${overlap}`,async($,on)=>{
 const {w,clock}=setup(on); const attachGate=deferred(),attachEntered=deferred(); let armed=false
 on('state.set',{plugin:'flowition-cockpit',key:'details'},async($,e,next)=>{
   if(armed && e.value.flo_a?.state==='starting'){armed=false;attachEntered.resolve();await attachGate.promise}
   return next(e)
 })
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
 const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'});w.toasts=[]
 armed=overlap;w.states.flo_a='completed'
 const attaching=$.tool.call({tool:'Bash',command:'flowition run w.mjs --resume flo_a --detach'})
 let refreshing:Promise<unknown>|undefined
 if(overlap){
  await attachEntered.promise
  w.gate=deferred();w.entered=deferred()
  const statusGate=w.gate
  refreshing=ui.press({key:'refresh'});await w.entered.promise
  attachGate.resolve();await attaching
  statusGate.resolve();await refreshing
 }else await attaching
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(1)
 await ui.unmount()
})
for(const named of [false,true])test(`A12 consumed launches leave no discovery debt, named=${named}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output=named?'run flo_here\nCommand was moved to the background (ID: task1)':'Command was moved to the background (ID: task1)'
 w.toolResult={stdout:'',stderr:named?'run flo_here\n':'',interrupted:false,backgroundTaskId:'task1'}
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs',run_in_background:true})
 w.states={flo_here:'running'};w.created.flo_here=100_000;w.mtime++;w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(5000)
 w.states.flo_elsewhere='running';w.created.flo_elsewhere=105_000;w.mtime++
 await clock.advance(30_000)
 expect(w.toasts.filter(t=>t==='flo_here asks: Need input')).toHaveLength(1)
 expect(w.toasts.filter(t=>t==='flo_elsewhere asks: Need input')).toHaveLength(0)
 await ui.unmount()
})
for(const [name,command] of [
 ['plain','flowition run w.mjs --json'],
 ['continuation-before-file','flowition run \\\n  w.mjs --json'],
 ['continuation-before-subcommand','flowition \\\n  run w.mjs --json'],
 ['node','node bin/flowition.js run w.mjs --json'],
 ['npx-yes','npx -y flowition run w.mjs --json'],
] as const)test(`A20 actual shell argv background discovery ${name}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output='Command was moved to the background (ID: task1)'
 w.toolResult={stdout:'',stderr:'',interrupted:false,backgroundTaskId:'task1'}
 await $.tool.call({tool:'Bash',command})
 w.states={flo_here:'running'};w.mtime++;w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_here asks: Need input')).toHaveLength(1)
 await ui.unmount()
})
for(const notification of ['completed','question'] as const)for(const overlap of [false,true])test(`A2 timer begins inside attachment ${notification}, overlap=${overlap}`,async($,on)=>{
 const {w,clock}=setup(on); const attachGate=deferred(),attachEntered=deferred(); let armed=false
 on('state.set',{plugin:'flowition-cockpit',key:'details'},async($,e,next)=>{
   if(armed && e.value.flo_a?.state==='starting'){armed=false;attachEntered.resolve();await attachGate.promise}
   return next(e)
 })
 if(notification==='question'){w.states.flo_a='running';w.questions=[{qid:'q0',t:99_999,question:'Need input'}]}
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 if(notification==='completed')await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
 await ui.press({key:'refresh'});w.toasts=[]
 armed=overlap;if(notification==='completed')w.states.flo_a='completed'
 const attaching=$.tool.call({tool:'Bash',command:notification==='completed'?'flowition resume flo_a':'flowition run w.mjs --detach'})
 if(overlap){
  await attachEntered.promise
  w.gate=deferred();w.entered=deferred(); const statusGate=w.gate
  const polling=clock.advance(2500);await w.entered.promise
  attachGate.resolve();await attaching
  statusGate.resolve();await polling
 }else await attaching
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t===(notification==='completed'?'flo_a completed':'flo_a asks: Need input'))).toHaveLength(1)
 await ui.unmount()
})
for(const shellBackground of [false,true])test(`A12 fully identified detached shell launch, shellBackground=${shellBackground}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output='started detached run flo_here\n  status: flowition status flo_here\n  follow: flowition tail flo_here -f\n'
 w.toolResult={stdout:w.output,stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command:`flowition run w.mjs --detach${shellBackground?' & wait':''}`})
 w.states={flo_here:'running'};w.created.flo_here=100_000;w.mtime++;w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(5000)
 w.states.flo_elsewhere='running';w.created.flo_elsewhere=105_000;w.mtime++
 await clock.advance(30_000)
 expect(w.toasts.filter(t=>t==='flo_here asks: Need input')).toHaveLength(1)
 expect(w.toasts.filter(t=>t==='flo_elsewhere asks: Need input')).toHaveLength(0)
 await ui.unmount()
})

test('A20: continuations and wrappers are read like the shell, and detection agrees', () => {
  const of = (c: string) => launchesIn(c).invocations.map((v) => v.file)
  expect([of('flowition \\\n  run \\\n  w.mjs --json'), of('node bin/flowition.js run w.mjs'), of('npx -y -p flowition flowition run w.mjs'), of('nohup flowition run w.mjs &')]).toEqual([['w.mjs'], ['w.mjs'], ['w.mjs'], ['w.mjs']])
  expect(['flowition \\\n run w.mjs', 'echo flowition run w.mjs', 'npx --yes flowition resume flo_1'].map(isFlowitionLaunch)).toEqual([true, false, true])
})
