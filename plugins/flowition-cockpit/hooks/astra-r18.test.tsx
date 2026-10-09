// Regressions from the gpt-6-astra (xhigh) review loop, round 18: Astra's reproductions, as written,
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






// No real tool/process/fs operation is dispatched by these tests.
for(const surface of ['terminal','desktop'] as const)for(const changed of [false,true])test(`A24 folder changes with form already open, ${surface}, changed=${changed}`,async($,on)=>{
 const {w}=setup(on);w.states={};w.workflows=[{name:'w.mjs',kind:'file',mtimeMs:1,size:1,isLink:false}];
 await $.session.start({cwd:w.cwd,surface,isInteractive:true});const ui=await $.ui.mount(PANE(surface));
 const press=async(key:string)=>{if(surface==='terminal')await ui.press({key});else{await ui.pointer({in:key,type:'down',x:1,y:0,button:'left'});await ui.pointer({in:key,type:'up',x:1,y:0,button:'left'});}};
 await press('new');await press(surface==='terminal'?'wf-pick:/home/t/.flowition/workflows/w.mjs':'wf:/home/t/.flowition/workflows/w.mjs');
 const confirmation=(await ui.find({text:/Its agents run with full permissions/}))?.text??'';
 if(changed){w.bashAction=()=>{w.cwd='/home/t/project-b'};await $.tool.call({tool:'Bash',command:'cd /home/t/project-b'});w.bashAction=null;}
 await press('launch-start');
 expect(w.launchCwds).toEqual(['/home/t/project-a']);expect(confirmation).toContain('/home/t/project-a');await ui.unmount();
});

test('A24 pwd refusal uses the explicit session-folder fallback',async($,on)=>{
 const {w}=setup(on);w.states={};w.workflows=[{name:'w.mjs',kind:'file',mtimeMs:1,size:1,isLink:false}];w.cwd='DENIED';
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'new'});await ui.press({key:'wf-pick:/home/t/.flowition/workflows/w.mjs'});
 expect((await ui.find({text:/Its agents run with full permissions/}))?.text??'').toContain('this session’s folder');
 w.cwd='/home/t/project-b';await ui.press({key:'launch-start'});expect(w.launchCwds).toEqual(['/home/t/project-b']);expect(w.calls.find(a=>a[1]==='run')?.includes('--cwd')).toBe(false);await ui.unmount();
});

for(const ended of [false,true])test(`A22 repeated reload preserves notice state, ended=${ended}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_a:'running'};w.questions=[{qid:'q0',t:5000,question:'Continue?'}];
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'});
 const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'});await ui.press({key:'refresh'});expect(w.toasts.filter(t=>t==='flo_a asks: Continue?')).toHaveLength(1);
 if(ended){w.states.flo_a='completed';await ui.press({key:'refresh'});expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(1);}
 w.toasts=[];
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});await ui.press({key:'refresh'});await clock.advance(30_000);
 expect(w.toasts).toHaveLength(0);await ui.unmount();
});

for(const refusal of [false,true])test(`An attachment state refusal cannot replay Bash, refused=${refusal}`,async($,on)=>{
 const {w}=setup(on);w.states={};let bashCalls=0;w.bashAction=()=>{bashCalls++};let armed=false;
 on('state.set',{plugin:'flowition-cockpit',key:'attached'},($,e,next)=>armed&&refusal?{deny:'state refused'}:next(e));
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});armed=true;
 const result=await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'});
 expect(bashCalls).toBe(1);expect(result.text).toContain('flo_a');
});

for(const error of [false,true])test(`No controls run just because render runs, errors=${error}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:error?'failed':'running'};w.questions=[{qid:'q0',t:5000,question:'Approve deployment?'}];
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('desktop'));w.calls=[];
 for(let i=0;i<5;i++)await ui.redraw();
 expect(w.calls.filter(a=>['answer','send','cancel','run','rm'].includes(a[1]??''))).toHaveLength(0);await ui.unmount();
});


// The testing kit drives input handlers, but not the terminal's typed-text store.
// Use that store's actual extracted functions to carry a draft through the real
// plugin's drawings, then submit exactly what the terminal would submit.
// A25 (draft answers crossing runs): the terminal keeps a typed draft per field key, so the
// answer field's key is its run's and its question event's. (Astra reproduced the carry-over
// with the terminal's own field-buffer code; that is not copied here.)
for(const switchRun of [false,true])test(`A25 an answer field is its run's and question's, switchRun=${switchRun}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'running',flo_b:'running'};w.questions=[{qid:'q0',t:1000,question:'Approve staging?'}];
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'));
 const key=async()=>(await ui.findAll({type:'Input'})).find(x=>x.key?.startsWith('answer:'))?.key;
 const before=await key();
 await ui.input({key:before!,text:'Yes, staging only',kind:'change'});
 if(switchRun){w.output='started detached run flo_b';w.questions=[{qid:'q0',t:2000,question:'Approve production?'}];await $.tool.call({tool:'Bash',command:'flowition run production.mjs --detach'});await ui.press({key:'refresh'})}
 const after=await key();
 expect([before?.includes(':flo_a:'),after!==before]).toEqual([true,switchRun]);
 if(switchRun)expect(after?.includes(':flo_b:')).toBe(true);
 await ui.unmount();
});
