// Regressions from the gpt-6-astra (xhigh) review loop, round 19, on Astra's harness.
// except A25's, rewritten without the terminal internals Astra extracted (see the note there).
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
 const w={cwd:'/home/t/project-a',launchCwds:[] as string[],threadGate:null as ReturnType<typeof deferred>|null,threadEntered:null as ReturnType<typeof deferred>|null,isError:false,bashAction:null as (()=>void)|null,workflows:[] as any[],launchEntered:null as ReturnType<typeof deferred>|null,cacheStates:[] as string[],armAfterStatus:false,gateAfterStatus:false,states:{flo_a:'failed'} as Record<string,string>,toasts:[] as string[],calls:[] as string[][],output:'started detached run flo_a',toolResult:null as any,questions:[] as object[],agents:[] as object[],events:'',transcript:'',gate:null as ReturnType<typeof deferred>|null,entered:null as ReturnType<typeof deferred>|null,createdAt:1000,rawStatus:null as string|null,completeOnLaunch:false,mtime:1,listGate:null as ReturnType<typeof deferred>|null,listEntered:null as ReturnType<typeof deferred>|null,created:{} as Record<string,number>,files:{} as Record<string,string>, toolGate:null as ReturnType<typeof deferred>|null, toolEntered:null as ReturnType<typeof deferred>|null}
 mock.env(on,{HOME:'/home/t',FLOWITION_HOME:'/home/t/.flowition',FLOWITION_BIN:'/bin/flowition',PATH:'/usr/bin'})
 on('session.start',($,e)=>({cwd:e.cwd}));on('command.register',($,e)=>({value:{command:e.name}}))
 on('fs.stat',($,e)=>({value:{kind:'file',size:e.path.includes('/agents/')?w.transcript.length:e.path.endsWith('events.jsonl')?w.events.length:0,mtimeMs:w.mtime,isLink:false}}))
 on('state.set',{plugin:'flowition-cockpit',key:'details'},($,e,next)=>{w.cacheStates.push(e.value.flo_a?.state??'empty');return next(e)})
 on('fs.list',($,e)=>({value:e.path.endsWith('/workflows')?w.workflows:[]}));on('ui.open',()=>({value:{isPlaced:true}}));on('ui.panes',()=>({value:[]}));on('ui.status',()=>({value:undefined}));on('ui.log',()=>({value:undefined}));on('ui.scroll',()=>({}))
 on('ui.toast',($,e)=>{w.toasts.push(e.text);return {value:undefined}})
 on('tool.call',{tool:'Bash'},async()=>{const gate=w.toolGate;w.toolGate=null;if(gate){w.toolEntered?.resolve();await gate.promise};w.bashAction?.();return w.isError?{result:w.toolResult??w.output,text:w.output,isError:true as const}:{result:w.toolResult??w.output,text:w.output}})
 on('process.run',async($,e)=>{
   const argv=[...e.argv];w.calls.push(argv)
   if(argv[0]==='pwd')return w.cwd === 'DENIED' ? {deny:'pwd refused'} : ok(w.cwd+'\n');
   if(argv[0]==='head')return ok(JSON.stringify({t:1,type:'run',state:'started',workflowFile:'/w.mjs'}))
   if(argv[0]==='/bin/sh'){const s=argv[5]?.includes('/agents/')?w.transcript:w.events;const from=Number(argv[4])-1;const result=ok(s.slice(from,from+Number(argv[6])));if(w.threadGate && argv[5]?.includes('/agents/0.jsonl')){const gate=w.threadGate;w.threadGate=null;w.threadEntered?.resolve();await gate.promise;}return result}
   if(argv[1]==='runs'){const text=JSON.stringify(Object.entries(w.states).map(([runId,state])=>({runId,state,file:w.files[runId]??'w.mjs',createdAt:w.created[runId]??w.createdAt})).sort((a,b)=>b.createdAt-a.createdAt)); const gate=w.listGate;w.listGate=null;if(gate){w.listEntered?.resolve();await gate.promise};return ok(text)}
   if(argv[1]==='status'){
     const runId=argv[2]!;const text=w.rawStatus??JSON.stringify({runId,state:w.states[runId],result:null,phases:[],agents:w.agents,steps:[],questions:w.questions,live:{ok:true,questions:w.questions}})
     const gate=w.gate;w.gate=null;if(gate){w.entered?.resolve();await gate.promise}
     if(w.armAfterStatus){w.armAfterStatus=false;w.gateAfterStatus=true}
     return ok(text)
   }
   if(argv[1]==='run'){w.launchCwds.push(argv.includes('--cwd')?argv[argv.indexOf('--cwd')+1]!:(e.init?.cwd??w.cwd));w.launchEntered?.resolve();if(w.completeOnLaunch)w.states.flo_a='completed';return ok('{"runId":"flo_a","detached":true,"status":"started"}')}
   return ok('{"ok":true}')
 })
 return {w,clock}
}







// A26: the args field is bound to the form's args, so what it shows is what Start and Enter
// launch with, after switching workflows and back or reopening the form. (Astra reproduced the
// mismatch with the terminal's own field buffer; that code is not copied here: the field's value
// is the property the terminal draws from.)
for(const mode of ['unchanged','switch-back','reopen'] as const)for(const submit of ['enter','button'] as const)test(`A26 the args field shows what launches: ${mode}, ${submit}`,async($,on)=>{
 const {w}=setup(on);w.states={};w.workflows=['deploy.mjs','other.mjs'].map(name=>({name,kind:'file',mtimeMs:1,size:1,isLink:false}));
 await $.session.start({cwd:w.cwd,surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));
 const press=(key:string)=>ui.press({key});const pick=(name:string)=>press(`wf-pick:/home/t/.flowition/workflows/${name}`);
 await press('new');await pick('deploy.mjs');
 const field=async()=>(await ui.findAll({type:'Input'})).find(f=>f.key?.startsWith('launch-args:'))!;
 const draft='{"environment":"staging","dryRun":true}';
 await ui.input({key:(await field()).key!,text:draft,kind:'change'});
 if(mode==='switch-back'){await pick('other.mjs');await pick('deploy.mjs')}
 if(mode==='reopen'){await press('launch-close');await press('new');await pick('deploy.mjs')}
 const shown=String((await field()).props.value??'');
 w.calls=[];
 if(submit==='enter')await ui.input({key:(await field()).key!,text:shown});else await press('launch-start');
 const call=w.calls.find(a=>a[1]==='run')!;
 const sent=call.includes('--args')?call[call.indexOf('--args')+1]:'';
 expect({mode,shown,sent}).toEqual({mode,shown:mode==='unchanged'?draft:'',sent:mode==='unchanged'?draft:''});
 await ui.unmount();
});
