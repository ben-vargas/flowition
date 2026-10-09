// Regressions from the gpt-6-astra (xhigh) review loop, round 16: Astra's reproductions, as written.
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
 const w={threadGate:null as ReturnType<typeof deferred>|null,threadEntered:null as ReturnType<typeof deferred>|null,isError:false,bashAction:null as (()=>void)|null,workflows:[] as any[],launchEntered:null as ReturnType<typeof deferred>|null,cacheStates:[] as string[],armAfterStatus:false,gateAfterStatus:false,states:{flo_a:'failed'} as Record<string,string>,toasts:[] as string[],calls:[] as string[][],output:'started detached run flo_a',toolResult:null as any,questions:[] as object[],agents:[] as object[],events:'',transcript:'',gate:null as ReturnType<typeof deferred>|null,entered:null as ReturnType<typeof deferred>|null,createdAt:1000,rawStatus:null as string|null,completeOnLaunch:false,mtime:1,listGate:null as ReturnType<typeof deferred>|null,listEntered:null as ReturnType<typeof deferred>|null,created:{} as Record<string,number>,files:{} as Record<string,string>, toolGate:null as ReturnType<typeof deferred>|null, toolEntered:null as ReturnType<typeof deferred>|null}
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
   if(argv[0]==='/bin/sh'){const s=argv[5]?.includes('/agents/')?w.transcript:w.events;const from=Number(argv[4])-1;const result=ok(s.slice(from,from+Number(argv[6])));if(w.threadGate && argv[5]?.includes('/agents/0.jsonl')){const gate=w.threadGate;w.threadGate=null;w.threadEntered?.resolve();await gate.promise;}return result}
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




for(const failed of [false,true])test(`A17 background workflow followed by wait exits failed=${failed}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'});
 w.isError=failed;w.output=failed?'Exit code 1':'';w.toolResult=failed?'Exit code 1':{stdout:'',stderr:'',interrupted:false};
 w.bashAction=()=>{w.states={flo_new:failed?'failed':'completed'};w.created.flo_new=100_000;w.mtime++};
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --json > /tmp/workflow.log 2>&1 & pid=$!; wait "$pid"'});
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'});
 expect(w.toasts.filter(t=>t===`flo_new ${failed?'failed':'completed'}`)).toHaveLength(1);await ui.unmount();
});
for(const failed of [false,true])test(`A17 background launch survives later shell failure=${failed}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'});
 w.isError=failed;w.output=failed?'Exit code 1':'';w.toolResult=failed?'Exit code 1':{stdout:'',stderr:'',interrupted:false};
 await $.tool.call({tool:'Bash',command:`flowition run w.mjs --json > /tmp/workflow.log 2>&1 & ${failed?'false':'true'}`});
 w.states={flo_new:'running'};w.created.flo_new=100_000;w.questions=[{qid:'q0',t:100_001,question:'Need input'}];w.mtime++;
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'});
 expect(w.toasts.filter(t=>t==='flo_new asks: Need input')).toHaveLength(1);await ui.unmount();
});


for(const overlap of [false,true])test(`Core control: thread read racing navigation recovers overlap=${overlap}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_a:'running'};w.agents=[{index:0,label:'First',state:'running'},{index:1,label:'Second',state:'running'}];
 w.transcript=jsonl([{t:1001,kind:'text',text:'First reply'}]);
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'agent:0'});
 w.transcript+=jsonl([{t:2000,kind:'text',text:' more'}]);
 if(overlap){w.threadGate=deferred();w.threadEntered=deferred();}
 const gate=w.threadGate;const refreshing=ui.press({key:'refresh'});
 if(overlap){await w.threadEntered!.promise;await $.command.run(flo('flo_a'));await ui.press({key:'agent:1'});gate!.resolve();}await refreshing;
 if(!overlap){await $.command.run(flo('flo_a'));await ui.press({key:'agent:1'});}
 await clock.advance(5000);expect((await ui.find({key:'events'}))?.text??'').toContain('First reply');expect((await ui.find({key:'header'}))?.text??'').toContain('Second');await ui.unmount();
});
