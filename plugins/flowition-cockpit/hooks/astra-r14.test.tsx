// Regressions from the gpt-6-astra (xhigh) review loop, round 14: Astra's reproductions, as written,
// except that the mixed-format A15 harness lists its launched runs created during the command, as
// the real CLI does (createdAt is the evidence that separates a launched run from one a report names).
// Round 11 scratch reproductions. All process, filesystem and Bash responses are mocked.
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
 const w={workflows:[] as any[],launchEntered:null as ReturnType<typeof deferred>|null,cacheStates:[] as string[],armAfterStatus:false,gateAfterStatus:false,states:{flo_a:'failed'} as Record<string,string>,toasts:[] as string[],calls:[] as string[][],output:'started detached run flo_a',toolResult:null as any,questions:[] as object[],agents:[] as object[],events:'',transcript:'',gate:null as ReturnType<typeof deferred>|null,entered:null as ReturnType<typeof deferred>|null,createdAt:1000,rawStatus:null as string|null,completeOnLaunch:false,mtime:1,listGate:null as ReturnType<typeof deferred>|null,listEntered:null as ReturnType<typeof deferred>|null,created:{} as Record<string,number>,files:{} as Record<string,string>, toolGate:null as ReturnType<typeof deferred>|null, toolEntered:null as ReturnType<typeof deferred>|null}
 mock.env(on,{HOME:'/home/t',FLOWITION_HOME:'/home/t/.flowition',FLOWITION_BIN:'/bin/flowition',PATH:'/usr/bin'})
 on('session.start',($,e)=>({cwd:e.cwd}));on('command.register',($,e)=>({value:{command:e.name}}))
 on('fs.stat',($,e)=>({value:{kind:'file',size:e.path.includes('/agents/')?w.transcript.length:e.path.endsWith('events.jsonl')?w.events.length:0,mtimeMs:w.mtime,isLink:false}}))
 on('state.set',{plugin:'flowition-cockpit',key:'details'},($,e,next)=>{w.cacheStates.push(e.value.flo_a?.state??'empty');return next(e)})
 on('fs.list',($,e)=>({value:e.path.endsWith('/workflows')?w.workflows:[]}));on('ui.open',()=>({value:{isPlaced:true}}));on('ui.panes',()=>({value:[]}));on('ui.status',()=>({value:undefined}));on('ui.log',()=>({value:undefined}));on('ui.scroll',()=>({}))
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
   if(argv[1]==='run'){w.launchEntered?.resolve();if(w.completeOnLaunch)w.states.flo_a='completed';return ok('{"runId":"flo_a","detached":true,"status":"started"}')}
   return ok('{"ok":true}')
 })
 return {w,clock}
}



import {phaseStatus,phaseEvents} from './astra-r14-fixtures'

for(const outcome of [false,true])test(`A14 foreground report text has outcome-shaped JSON=${outcome}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'})
 const report=JSON.stringify(outcome?{runId:'flo_ref',status:'completed',result:'CI run analyzed'}:{runId:'flo_ref',status:'completed',message:'CI run analyzed'})
 w.output='\nrun flo_actual: completed\n'+report+'\n';w.toolResult={stdout:w.output,stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command:'flowition run report.mjs --quiet'})
 w.states={flo_actual:'completed',flo_ref:'running'};w.questions=[{qid:'q0',t:100_000,question:'Other session asks'}];w.mtime++
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_actual completed')).toHaveLength(1)
 expect(w.toasts.filter(t=>t==='flo_ref asks: Other session asks')).toHaveLength(0)
 expect((await ui.find({key:'header'}))?.text??'').toContain('flo_actual')
 await ui.unmount()
})
for(const realStatus of [false,true])test(`A21 before first phase of resumed attempt real CLI status=${realStatus}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'running'};w.events=phaseEvents
 if(realStatus)w.rawStatus=phaseStatus
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'tab:phases'})
 expect((await ui.find({key:'phase:1'}))?.text??'').not.toContain('● running')
 expect((await ui.find({key:'t:phase'}))?.text??'').not.toContain('Release')
 await ui.unmount()
})
for(const overlap of [false,true])test(`A23 Enter with argument change pending overlap=${overlap}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.workflows=[{name:'w.mjs',kind:'file',size:10,mtimeMs:1}]
 const gate=deferred(),entered=deferred();let armed=overlap
 on('state.set',{plugin:'flowition-cockpit',key:'launch'},async($,e,next)=>{
  if(armed&&e.value?.args==='{"target":"staging"}'){armed=false;entered.resolve();await gate.promise}
  return next(e)
 })
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'new'});await ui.press({key:'wf-pick:/home/t/.flowition/workflows/w.mjs'})
 const edit=ui.input({key:'launch-args:/home/t/.flowition/workflows/w.mjs',text:'{"target":"staging"}',kind:'change'})
 if(overlap)await entered.promise;else await edit
 w.launchEntered=deferred()
 const submit=ui.input({key:'launch-args:/home/t/.flowition/workflows/w.mjs',text:'{"target":"staging"}',kind:'submit'})
 await clock.settle()
 gate.resolve();await edit;await submit
 const calls=w.calls.filter(a=>a[1]==='run')
 expect(calls).toHaveLength(1)
 expect(calls[0]).toContain('--args')
 expect(calls[0]).toContain('{"target":"staging"}')
 await ui.unmount()
})
for(const hasResult of [true,false])test(`A15 later foreground JSON outcome has result=${hasResult}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={}
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'})
 w.output='\nrun flo_first: completed\nReport first\n'+JSON.stringify({runId:'flo_second',status:'completed',result:hasResult?'Report second':undefined})+'\n'
 w.toolResult={stdout:w.output,stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command:'flowition run first.mjs --quiet && flowition run second.mjs --json'})
 w.states={flo_first:'completed',flo_second:'completed'};w.created={flo_first:100_000,flo_second:100_000};w.mtime++
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_first completed')).toHaveLength(1)
 expect(w.toasts.filter(t=>t==='flo_second completed')).toHaveLength(1)
 await ui.unmount()
})
for(const reload of [false,true])test(`A22 previously announced completion is not repeated reload=${reload}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_a:'running'}
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'})
 w.states.flo_a='completed';await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(1)
 w.toasts=[]
 if(reload)await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await clock.advance(65_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(0)
 await ui.unmount()
})
