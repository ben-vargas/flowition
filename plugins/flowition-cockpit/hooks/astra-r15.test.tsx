// Regressions from the gpt-6-astra (xhigh) review loop, round 15: Astra's reproductions, as written.
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
 const w={isError:false,bashAction:null as (()=>void)|null,workflows:[] as any[],launchEntered:null as ReturnType<typeof deferred>|null,cacheStates:[] as string[],armAfterStatus:false,gateAfterStatus:false,states:{flo_a:'failed'} as Record<string,string>,toasts:[] as string[],calls:[] as string[][],output:'started detached run flo_a',toolResult:null as any,questions:[] as object[],agents:[] as object[],events:'',transcript:'',gate:null as ReturnType<typeof deferred>|null,entered:null as ReturnType<typeof deferred>|null,createdAt:1000,rawStatus:null as string|null,completeOnLaunch:false,mtime:1,listGate:null as ReturnType<typeof deferred>|null,listEntered:null as ReturnType<typeof deferred>|null,created:{} as Record<string,number>,files:{} as Record<string,string>, toolGate:null as ReturnType<typeof deferred>|null, toolEntered:null as ReturnType<typeof deferred>|null}
 mock.env(on,{HOME:'/home/t',FLOWITION_HOME:'/home/t/.flowition',FLOWITION_BIN:'/bin/flowition',PATH:'/usr/bin'})
 on('session.start',($,e)=>({cwd:e.cwd}));on('command.register',($,e)=>({value:{command:e.name}}))
 on('fs.stat',($,e)=>({value:{kind:'file',size:e.path.includes('/agents/')?w.transcript.length:e.path.endsWith('events.jsonl')?w.events.length:0,mtimeMs:w.mtime,isLink:false}}))
 on('state.set',{plugin:'flowition-cockpit',key:'details'},($,e,next)=>{w.cacheStates.push(e.value.flo_a?.state??'empty');return next(e)})
 on('fs.list',($,e)=>({value:e.path.endsWith('/workflows')?w.workflows:[]}));on('ui.open',()=>({value:{isPlaced:true}}));on('ui.panes',()=>({value:[]}));on('ui.status',()=>({value:undefined}));on('ui.log',()=>({value:undefined}));on('ui.scroll',()=>({}))
 on('ui.toast',($,e)=>{w.toasts.push(e.text);return {value:undefined}})
 on('tool.call',{tool:'Bash'},async()=>{const gate=w.toolGate;w.toolGate=null;if(gate){w.toolEntered?.resolve();await gate.promise};w.bashAction?.();return w.isError?{result:w.toolResult??w.output,text:w.output,isError:true as const}:{result:w.toolResult??w.output,text:w.output}})
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




for(const failed of [false,true])test(`A15 mixed foreground launches, second failed=${failed}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'})
 w.output='\nrun flo_first: completed\nReport first\n'+JSON.stringify(failed?{runId:'flo_second',status:'failed',error:'checks failed'}:{runId:'flo_second',status:'completed',result:'Report second'})+'\n';
 w.isError=failed;w.toolResult=failed?'Exit code 1\n'+w.output:{stdout:w.output,stderr:'',interrupted:false};
 await $.tool.call({tool:'Bash',command:'flowition run first.mjs --quiet && flowition run second.mjs --json'})
 w.states={flo_first:'completed',flo_second:failed?'failed':'completed'};w.created={flo_first:100_000,flo_second:100_000};w.files={flo_first:'first.mjs',flo_second:'second.mjs'};w.mtime++
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_first completed')).toHaveLength(1)
 expect(w.toasts.filter(t=>t===`flo_second ${failed?'failed':'completed'}`)).toHaveLength(1)
 await ui.unmount()
})

for(const failed of [false,true])test(`A15 mixed foreground resume, resumed attempt failed=${failed}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_second:'failed'};
 w.events=jsonl([{t:1000,type:'run',runId:'flo_second',state:'started'},{t:2000,type:'run',runId:'flo_second',state:'failed'}]);
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'})
 w.output='\nrun flo_first: completed\nReport first\n'+JSON.stringify(failed?{runId:'flo_second',status:'failed',error:'checks failed'}:{runId:'flo_second',status:'completed',result:'Report second'})+'\n';
 w.isError=failed;w.toolResult=failed?'Exit code 1\n'+w.output:{stdout:w.output,stderr:'',interrupted:false};
 w.bashAction=()=>{w.states={flo_first:'completed',flo_second:failed?'failed':'completed'};w.created.flo_first=100_000;w.events+=jsonl([{t:100_000,type:'run',runId:'flo_second',state:'resumed'},{t:100_001,type:'run',runId:'flo_second',state:failed?'failed':'completed'}]);w.mtime++}
 await $.tool.call({tool:'Bash',command:'flowition run first.mjs --quiet && flowition resume flo_second --json'})
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t===`flo_second ${failed?'failed':'completed'}`)).toHaveLength(1)
 await ui.unmount()
})

for(const recent of [false,true])test(`A14 a report names an already-listed run created recently=${recent}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_ref:'running'};w.created.flo_ref=recent?99_500:90_000;w.files.flo_ref='target.mjs';w.questions=[{qid:'q0',t:99_500,question:'Other session asks'}];
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'});
 w.output='\nrun flo_actual: completed\n'+JSON.stringify({runId:'flo_ref',status:'completed',result:'CI run analyzed'})+'\n';w.toolResult={stdout:w.output,stderr:'',interrupted:false};
 await $.tool.call({tool:'Bash',command:'flowition run report.mjs --quiet'});
 w.states.flo_actual='completed';w.created.flo_actual=100_000;w.files.flo_actual='report.mjs';w.mtime++
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'});
 expect(w.toasts.filter(t=>t==='flo_ref asks: Other session asks')).toHaveLength(0);
 expect((await ui.find({key:'header'}))?.text??'').toContain('flo_actual');await ui.unmount();
})

for(const withWorker of [false,true])test(`Accepted parity control: phase badge rolls up workers, withWorker=${withWorker}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'running'};w.questions=[{qid:'q0',t:4000,question:'Approve release?'}];
 w.agents=withWorker?[{index:0,label:'Prepare',state:'done',phase:'Approval',phaseIndex:0,t:3000,usage:{output:100},durationMs:1000}]:[];
 w.events=jsonl([{t:1000,type:'run',state:'started',phases:[{title:'Approval'},{title:'Release'}]},{t:1500,type:'phase',phaseIndex:0,title:'Approval'},
 ...(withWorker?[{t:2000,type:'agent',index:0,label:'Prepare',state:'running',phaseIndex:0},{t:3000,type:'agent',index:0,label:'Prepare',state:'done',phaseIndex:0,usage:{output:100}}]:[]),{t:4000,type:'question',qid:'q0',question:'Approve release?'}]);
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'tab:phases'});
 // The reference viewer explicitly rolls up agents here; not a finding.
 expect((await ui.find({key:'phase:0'}))?.text??'').toContain(withWorker?'● done':'● running');await ui.unmount();
})

for(const mixed of [false,true])test(`A12 fully identified background command has doubtful identity mixed=${mixed}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'});
 const first=mixed?'\nrun flo_first: completed\nReport first\n':JSON.stringify({runId:'flo_first',status:'completed',result:'Report first'})+'\n';
 w.output=first+JSON.stringify({runId:'flo_second',status:'completed',result:'Report second'})+'\n';w.toolResult={stdout:w.output,stderr:'',interrupted:false,backgroundTaskId:'b123'};
 await $.tool.call({tool:'Bash',command:`flowition run first.mjs ${mixed?'--quiet':'--json'} && flowition run second.mjs --json && sleep 60`});
 w.states={flo_first:'completed',flo_second:'completed'};w.created={flo_first:100_000,flo_second:100_001};w.files={flo_first:'first.mjs',flo_second:'second.mjs'};w.mtime++;
 await clock.advance(10_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'});
 expect(w.toasts.filter(t=>t==='flo_second completed')).toHaveLength(1);
 w.states.flo_unrelated='running';w.created.flo_unrelated=110_000;w.files.flo_unrelated='second.mjs';w.questions=[{qid:'q0',t:110_000,question:'Other session asks'}];w.mtime++;
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'});
 expect(w.toasts.filter(t=>t==='flo_unrelated asks: Other session asks')).toHaveLength(0);await ui.unmount();
})

for(const otherNew of [false,true])test(`A14 report refers to another session run created during report=${otherNew}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'});
 w.output='\nrun flo_actual: completed\n'+JSON.stringify(otherNew?{runId:'flo_ref',status:'completed',result:'CI run analyzed'}:{message:'CI run analyzed'})+'\n';w.toolResult={stdout:w.output,stderr:'',interrupted:false};
 w.toolGate=deferred();w.toolEntered=deferred();const gate=w.toolGate;
 const call=$.tool.call({tool:'Bash',command:'flowition run report.mjs --quiet'});await w.toolEntered.promise;
 await clock.advance(5000);w.states.flo_ref='running';w.created.flo_ref=105_000;w.files.flo_ref='target.mjs';w.questions=[{qid:'q0',t:105_000,question:'Other session asks'}];w.mtime++;
 await clock.advance(5000);gate.resolve();await call;
 w.states.flo_actual='completed';w.created.flo_actual=100_000;w.files.flo_actual='report.mjs';w.mtime++;
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'});
 expect(w.toasts.filter(t=>t==='flo_ref asks: Other session asks')).toHaveLength(0);await ui.unmount();
})
