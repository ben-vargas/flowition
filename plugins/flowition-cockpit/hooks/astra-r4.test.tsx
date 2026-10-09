// Regressions from the gpt-6-astra (xhigh) review loop, round 4: Astra's reproductions, as written
// (real CLI fixtures in astra-r4-fixtures.ts).
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { foldTimeline, emptyTimeline, parseStatus, lifetimeWorkers, appendEvents, parseTranscript, phaseGroups, extractRunId } from './lib'
import { liveStatus, liveEvents } from './astra-r4-fixtures'
const ok=(stdout:string)=>({value:{exitCode:0,stdout,stderr:'',isStdoutTruncated:false,isStderrTruncated:false}})
const flo=(args:string)=>({command:'flo',args,origin:{kind:'composer' as const},presentation:{isFullscreen:true,columns:160}})
const PANE=(surface:'terminal'|'desktop')=>({plugin:'flowition-cockpit',surface,component:'Pane',requestId:'flo',props:{title:'Flowition',isFocused:false,bodyColumns:100,placement:'dock',scroll:{offset:0,bodyRows:30},view:{}},viewport:{columns:160,rows:40}}) as const
const jsonl=(rows:object[])=>rows.map(r=>JSON.stringify(r)+'\n').join('')
// The CLI lists each run with its own workflow file's basename (as launched).
const FILES:Record<string,string>={flo_0:'workflow0.mjs',flo_1:'workflow1.mjs'}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}
function setup(on:On){
 const clock=mock.clock(on,{now:100_000})
 const w={states:{flo_a:'failed'} as Record<string,string>,toasts:[] as string[],calls:[] as string[][],output:'started detached run flo_a',questions:[] as object[],agents:[] as object[],events:'',transcript:'',gate:null as ReturnType<typeof deferred>|null,entered:null as ReturnType<typeof deferred>|null,createdAt:1000,rawStatus:null as string|null,completeOnLaunch:false}
 mock.env(on,{HOME:'/home/t',FLOWITION_HOME:'/home/t/.flowition',FLOWITION_BIN:'/bin/flowition',PATH:'/usr/bin'})
 on('session.start',($,e)=>({cwd:e.cwd}));on('command.register',($,e)=>({value:{command:e.name}}))
 on('fs.stat',($,e)=>({value:{kind:'file',size:e.path.includes('/agents/')?w.transcript.length:e.path.endsWith('events.jsonl')?w.events.length:0,mtimeMs:1,isLink:false}}))
 on('fs.list',()=>({value:[]}));on('ui.open',()=>({value:{isPlaced:true}}));on('ui.panes',()=>({value:[]}));on('ui.status',()=>({value:undefined}));on('ui.log',()=>({value:undefined}));on('ui.scroll',()=>({}))
 on('ui.toast',($,e)=>{w.toasts.push(e.text);return {value:undefined}})
 on('tool.call',{tool:'Bash'},()=>({result:w.output,text:w.output}))
 on('process.run',async($,e)=>{
   const argv=[...e.argv];w.calls.push(argv)
   if(argv[0]==='head')return ok(JSON.stringify({t:1,type:'run',state:'started',workflowFile:'/w.mjs'}))
   if(argv[0]==='/bin/sh'){const s=argv[5]?.includes('/agents/')?w.transcript:w.events;const from=Number(argv[4])-1;return ok(s.slice(from,from+Number(argv[6])))}
   if(argv[1]==='runs')return ok(JSON.stringify(Object.entries(w.states).map(([runId,state])=>({runId,state,file:FILES[runId]??'w.mjs',createdAt:w.createdAt}))))
   if(argv[1]==='status'){
     const runId=argv[2]!;const text=w.rawStatus??JSON.stringify({runId,state:w.states[runId],result:null,phases:[],agents:w.agents,steps:[],questions:w.questions,live:{ok:true,questions:w.questions}})
     const gate=w.gate;w.gate=null;if(gate){w.entered?.resolve();await gate.promise}
     return ok(text)
   }
   if(argv[1]==='run'){if(w.completeOnLaunch)w.states.flo_a='completed';return ok('{"runId":"flo_a","detached":true,"status":"started"}')}
   return ok('{"ok":true}')
 })
 return {w,clock}
}
for(const overlap of [false,true])test(`A2: watched resume retains its new notification baseline, overlap=${overlap}`,async($,on)=>{
 const {w}=setup(on)
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'))
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
 await ui.press({key:'refresh'});w.toasts.length=0
 let polling:Promise<unknown>|null=null;let gate:ReturnType<typeof deferred>|null=null
 if(overlap){gate=deferred();w.gate=gate;w.entered=deferred();polling=ui.press({key:'refresh'});await w.entered.promise}
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --resume flo_a --detach'})
 w.states.flo_a='completed'
 if(gate){gate.resolve();await polling}
 await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(1)
 await ui.unmount()
})
for(const launches of [1,2])test(`A12: every background launch attaches, count=${launches}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 w.output='Command running in background with ID: bash123'
 for(let i=0;i<launches;i++)await $.tool.call({tool:'Bash',command:`flowition run workflow${i}.mjs`})
 for(let i=0;i<launches;i++)w.states[`flo_${i}`]='running'
 w.questions=[{t:100_110,qid:'q0',question:'Need input'}]
 await ui.press({key:'refresh'});await clock.advance(5000)
 expect(w.toasts.filter(t=>t.endsWith('asks: Need input'))).toHaveLength(launches)
 await ui.unmount()
})
for(const isResumed of [false,true])test(`A13: an abandoned agent does not become live before its new attempt, resumed=${isResumed}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:isResumed?'running':'stale'}
 w.agents=[{t:150,index:0,key:'k0',label:'old worker',adapter:'codex',state:'running',outputTokens:1200,lastOutputAt:150}]
 w.events=jsonl([{t:10,type:'run',state:'started'},{t:100,type:'agent',index:0,state:'running'},{t:150,type:'agent',index:0,state:'progress',outputTokens:1200,lastOutputAt:150},...(isResumed?[{t:200,type:'run',state:'resumed'},{t:210,type:'question',qid:'q0',question:'Proceed?'}]:[])])
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'))
 expect(await ui.find({key:'steer:flo_a:0'})).toBeUndefined()
 await ui.unmount()
})

for(const overlap of [false,true])test(`A2: pane Resume preserves baseline against in-flight status, overlap=${overlap}`,async($,on)=>{
 const {w,clock}=setup(on)
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'))
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
 await ui.press({key:'refresh'});w.toasts.length=0
 await ui.press({key:'resume'})
 let polling:Promise<unknown>|null=null;let gate:ReturnType<typeof deferred>|null=null
 if(overlap){gate=deferred();w.gate=gate;w.entered=deferred();polling=ui.press({key:'refresh'});await w.entered.promise}
 w.completeOnLaunch=true
 const launching=ui.press({key:'resume-yes'})
 await clock.settle()
 if(gate)gate.resolve()
 await Promise.all([launching,polling])
 await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(1)
 await ui.unmount()
})
test('A13: real CLI reports zero live agents; old worker must not offer live steering',async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'running'};w.rawStatus=liveStatus;w.events=liveEvents
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'))
 expect(await ui.find({key:'steer:flo_a:0'})).toBeUndefined()
 await ui.unmount()
})
for(const result of ['done',JSON.stringify({runId:'flo_reference',message:'CI run analyzed'})])test(`A14: a foreground result cannot override the CLI run header, result=${result}`,()=>{
 expect(extractRunId('\nrun flo_actual: completed\n'+result+'\n')).toBe('flo_actual')
})
for(const structuredResult of [false,true])test(`A14: foreground auto-attach chooses launched run, structuredResult=${structuredResult}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_actual:'completed',flo_reference:'completed'}
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 w.output='\nrun flo_actual: completed\n'+(structuredResult?JSON.stringify({runId:'flo_reference',message:'CI run analyzed'}):'done')+'\n'
 await $.tool.call({tool:'Bash',command:'flowition run analyze.workflow.mjs'})
 await ui.press({key:'refresh'})
 expect(await ui.find({text:/flo_actual · launched here/})).toBeDefined()
 await ui.unmount()
})
