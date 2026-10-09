// Regressions from the gpt-6-astra (xhigh) review loop, round 7: Astra's reproductions, as written.
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
 const w={states:{flo_a:'failed'} as Record<string,string>,toasts:[] as string[],calls:[] as string[][],output:'started detached run flo_a',toolResult:null as any,questions:[] as object[],agents:[] as object[],events:'',transcript:'',gate:null as ReturnType<typeof deferred>|null,entered:null as ReturnType<typeof deferred>|null,createdAt:1000,rawStatus:null as string|null,completeOnLaunch:false,mtime:1,listGate:null as ReturnType<typeof deferred>|null,listEntered:null as ReturnType<typeof deferred>|null,created:{} as Record<string,number>,files:{} as Record<string,string>, toolGate:null as ReturnType<typeof deferred>|null, toolEntered:null as ReturnType<typeof deferred>|null}
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
     return ok(text)
   }
   if(argv[1]==='run'){if(w.completeOnLaunch)w.states.flo_a='completed';return ok('{"runId":"flo_a","detached":true,"status":"started"}')}
   return ok('{"ok":true}')
 })
 return {w,clock}
}



for(const unrelatedFirst of [false,true])test(`A12 a new unrelated workflow cannot consume discovery, unrelatedFirst=${unrelatedFirst}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 w.output='Command running in background with ID: bash123'
 await $.tool.call({tool:'Bash',command:'sleep 2 && flowition run wanted.mjs --json',run_in_background:true})
 w.questions=[{qid:'q0',t:100_100,question:'Need input'}]
 if(unrelatedFirst){w.states.flo_other='running';w.files.flo_other='unrelated.mjs';w.created.flo_other=100_100;w.mtime++;await clock.advance(2500)}
 w.states.flo_wanted='running';w.files.flo_wanted='wanted.mjs';w.created.flo_wanted=unrelatedFirst?102_500:100_000;w.mtime++
 await clock.advance(30_000)
 await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect({wanted:w.toasts.filter(t=>t==='flo_wanted asks: Need input').length,other:w.toasts.filter(t=>t==='flo_other asks: Need input').length}).toEqual({wanted:1,other:0})
 await ui.unmount()
})

for(const surface of ['terminal','desktop'] as const)for(const inThread of [false,true])test(`A19 auto-attachment resets navigation, surface=${surface}, inThread=${inThread}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'running',flo_b:'running'};w.agents=[{index:0,label:'Writer',state:'running'}];w.transcript=jsonl([{kind:'text',text:'old run transcript'}])
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE(surface))
 if(inThread){if(surface==='terminal')await ui.press({key:'agent:0'});else{await ui.pointer({in:'agentcard:0',type:'down',x:1,y:0,button:'left'});await ui.pointer({in:'agentcard:0',type:'up',x:1,y:0,button:'left'})}}
 w.output='started detached run flo_b';w.agents=[];w.transcript=''
 await $.tool.call({tool:'Bash',command:'flowition run b.mjs --detach'})
 // A new launch should open the new run's view, not agent 0 inherited from run A.
 if(surface==='terminal')await ui.press({key:'refresh'});else{await ui.pointer({in:'refresh',type:'down',x:1,y:0,button:'left'});await ui.pointer({in:'refresh',type:'up',x:1,y:0,button:'left'})}
 expect(await ui.find({key:'tab:agents'})).toBeDefined()
 await ui.unmount()
})

for(const switchRun of [false,true])test(`An answer submitted for A cannot land in B, switchRun=${switchRun}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'running',flo_b:'running'};w.questions=[{qid:'q0',question:'Proceed?',t:1000}]
 const gate=deferred(),entered=deferred()
 on('ui.input',async($,e,next)=>{if(e.kind==='submit'){entered.resolve();await gate.promise};return next(e)})
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'))
 const input=ui.input({key:'answer:q0:0:flo_a:1000',text:'Answer intended for A'})
 await entered.promise
 if(switchRun){await $.command.run(flo('flo_b'));await ui.redraw()}
 gate.resolve();await input.catch(err=>{if(!switchRun)throw err})
 const answers=w.calls.filter(a=>a[1]==='answer')
 expect(answers).toHaveLength(switchRun?0:1)
 if(!switchRun)expect(answers[0]?.[2]).toBe('flo_a')
 await ui.unmount()
})

// Exact strings from 2.1.293's YQn Bash result formatter; these are different arms
// of the same backgroundTaskId result declared by claude-code.d.ts.
for(const how of ['explicit','timeout','user','message'] as const)test(`A17 new --json run attaches when Bash backgrounds it via ${how}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 const notes={
  explicit:'Command running in background with ID: bash123. Output is being written to: /tmp/bash123.output.',
  timeout:'Command did not complete within its 120s timeout and was moved to the background (ID: bash123). Output is being written to: /tmp/bash123.output.',
  user:'Command was manually backgrounded by user with ID: bash123. Output is being written to: /tmp/bash123.output.',
  message:'Command was moved to the background (ID: bash123) so that a message that arrived while it was running can reach you; it was not interrupted. Output is being written to: /tmp/bash123.output.'
 }
 w.output=notes[how]
 w.toolResult={stdout:'',stderr:'',interrupted:false,backgroundTaskId:'bash123',...(how==='timeout'?{timedOutAfterMs:120000}:how==='user'?{backgroundedByUser:true}:how==='message'?{backgroundedToDeliverMessage:true}:{})}
 // The non-explicit cases spend time in the foreground first. Polling can observe
 // the question while Bash is still pending; backgrounding must still attach it.
 const gate=deferred();w.toolGate=gate;w.toolEntered=deferred()
 const launching=$.tool.call({tool:'Bash',command:'flowition run w.mjs --json'})
 await w.toolEntered.promise
 w.states.flo_new='running';w.questions=[{qid:'q0',t:100_000,question:'Need input'}];w.mtime++
 if(how!=='explicit')await clock.advance(how==='timeout'?120_000:5000)
 gate.resolve();await launching
 await clock.advance(30_000)
 expect(w.toasts.filter(t=>t==='flo_new asks: Need input')).toHaveLength(1)
 await ui.unmount()
})

for(const persisted of [false,true])test(`A18 foreground JSON result still attaches when Bash persists it, persisted=${persisted}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 const stdout=JSON.stringify({runId:'flo_new',status:'completed',result:'Review report. '.repeat(persisted?5000:2)})
 // 2.1.293's Bash mapper formats persisted output through eke: a 2000-char preview.
 w.output=persisted?`<persisted-output>\nOutput too large (73.3KB). Full output saved to: /tmp/tool-results/report.txt\n\nPreview (first 2KB):\n${stdout.slice(0,2000)}\n...\n</persisted-output>`:stdout
 w.toolResult={stdout:stdout.slice(0,30000),stderr:'',interrupted:false,...(persisted?{persistedOutputPath:'/tmp/tool-results/report.txt',persistedOutputSize:stdout.length}:{})}
 w.states.flo_new='completed';w.mtime++
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --json'})
 await clock.advance(30_000)
 expect(w.toasts.filter(t=>t==='flo_new completed')).toHaveLength(1)
 await ui.unmount()
})
