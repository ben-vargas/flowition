// Regressions from the gpt-6-astra (xhigh) review loop, round 13: Astra's reproductions, as written.
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
 const w={cacheStates:[] as string[],armAfterStatus:false,gateAfterStatus:false,states:{flo_a:'failed'} as Record<string,string>,toasts:[] as string[],calls:[] as string[][],output:'started detached run flo_a',toolResult:null as any,questions:[] as object[],agents:[] as object[],events:'',transcript:'',gate:null as ReturnType<typeof deferred>|null,entered:null as ReturnType<typeof deferred>|null,createdAt:1000,rawStatus:null as string|null,completeOnLaunch:false,mtime:1,listGate:null as ReturnType<typeof deferred>|null,listEntered:null as ReturnType<typeof deferred>|null,created:{} as Record<string,number>,files:{} as Record<string,string>, toolGate:null as ReturnType<typeof deferred>|null, toolEntered:null as ReturnType<typeof deferred>|null}
 mock.env(on,{HOME:'/home/t',FLOWITION_HOME:'/home/t/.flowition',FLOWITION_BIN:'/bin/flowition',PATH:'/usr/bin'})
 on('session.start',($,e)=>({cwd:e.cwd}));on('command.register',($,e)=>({value:{command:e.name}}))
 on('fs.stat',($,e)=>({value:{kind:'file',size:e.path.includes('/agents/')?w.transcript.length:e.path.endsWith('events.jsonl')?w.events.length:0,mtimeMs:w.mtime,isLink:false}}))
 on('state.set',{plugin:'flowition-cockpit',key:'details'},($,e,next)=>{w.cacheStates.push(e.value.flo_a?.state??'empty');return next(e)})
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



// Output framing must let a later foreground --json run name itself.
for(const mixed of [false,true])test(`A15 mixed foreground output formats mixed=${mixed}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'})
 const first=mixed?'\nrun flo_first: completed\nReport first\n':JSON.stringify({runId:'flo_first',status:'completed',result:'Report first'})+'\n'
 w.output=first+JSON.stringify({runId:'flo_second',status:'completed',result:'Report second'})+'\n'
 w.toolResult={stdout:w.output,stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command:`flowition run first.mjs ${mixed?'--quiet':'--json'} && flowition run second.mjs --json`})
 w.states={flo_first:'completed',flo_second:'completed'};w.mtime++
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_first completed')).toHaveLength(1)
 expect(w.toasts.filter(t=>t==='flo_second completed')).toHaveLength(1)
 await ui.unmount()
})
for(const fresh of [true,false])test(`A20 skipped resume with an out-of-date listing fresh=${fresh}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_other:'failed'}
 w.events=jsonl([{t:1000,type:'run',runId:'flo_other',state:'started'},{t:2000,type:'run',runId:'flo_other',state:'failed'}]);
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'})
 // Another session resumed before this Bash call; no growth AFTER the call.
 w.states.flo_other='running';w.events+=jsonl([{t:99_999,type:'run',runId:'flo_other',state:'resumed'}]);w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 if(fresh)await ui.press({key:'refresh'})
 w.output='';w.toolResult={stdout:'',stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command:'state=running; if [ "$state" = failed ]; then flowition resume flo_other --json; fi'})
 await clock.advance(65_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_other asks: Need input')).toHaveLength(0)
 expect((await ui.find({key:'header'}))?.text??'').not.toContain('launched here')
 await ui.unmount()
})
// At hot reload, session.start resets the display cache while attached survives.
for(const reload of [false,true])test(`A22 completion across cache reset on session.start reload=${reload}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_a:'running'}
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 w.output='started detached run flo_a';await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
 const ui=await $.ui.mount(PANE('terminal'))
 await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.cacheStates[w.cacheStates.length-1]).toBe('running')
 w.toasts=[];w.states.flo_a='completed'
 if(reload)await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await ui.press({key:'refresh'});await ui.press({key:'refresh'});await clock.advance(30_000)
 const notices=w.toasts.filter(t=>t==='flo_a completed')
 await ui.unmount()
 expect(notices).toHaveLength(1)
})
// Current phase must not carry across a run-attempt opening before phase() is reached.
for(const resumed of [false,true])test(`A21 resume before reaching any current phase resumed=${resumed}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'running'}
 w.questions=[{qid:'q0',t:4500,question:'Ready to begin?'}]
 w.events=jsonl([{t:1000,type:'run',state:'started',phases:[{title:'Approval'},{title:'Release'}]},
 ...(resumed?[{t:2000,type:'phase',phaseIndex:1,title:'Release'},{t:3000,type:'run',state:'failed'},{t:4000,type:'run',state:'resumed'}]:[])])
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'tab:phases'})
 const phase=(await ui.find({key:'phase:1'}))?.text??''
 expect(phase).not.toContain('● running')
 expect((await ui.find({key:'t:phase'}))?.text??'').not.toContain('Release')
 await ui.unmount()
})

// These bytes were produced by src/cli.js main() with ONLY runWorkflow stubbed.
test('A15 real CLI formatter output keeps both foreground identities',()=>{expect(extractRunIds("\nrun flo_first: completed\nReport first.mjs\n{\"runId\":\"flo_second\",\"status\":\"completed\",\"result\":\"Report second.mjs\"}\n")).toEqual(['flo_first','flo_second'])})
