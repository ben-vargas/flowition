// Regressions from the gpt-6.1-sol (xhigh) review loop, third pass, round 2: Sol's reproduction, as written.
// A compound command's doubtful ids share its launches: one taken uses its launch up for the next.
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






for (const surface of ['terminal', 'desktop'] as const) for (const quoted of [false,true]) for(const format of ['plain','json'] as const) test(`A14 doubtful launch inventory consumed ${surface}/${format}/quoted=${quoted}`, async ($, on) => {
  let attached: string[] = []; let selected: string | null = null;
  on('state.set', { plugin:'flowition-cockpit',key:'attached' }, ($,e,next)=>{attached=e.value;return next(e)});
  on('state.set', { plugin:'flowition-cockpit',key:'selected' }, ($,e,next)=>{selected=e.value;return next(e)});
  const {w,clock}=setup(on); w.states={};
  await $.session.start({cwd:'/home/t',surface,isInteractive:true});
  const ui=await $.ui.mount(PANE(surface));
  const press=async(key:string)=>{if(surface==='terminal')await ui.press({key});else{await ui.pointer({in:key,type:'down',x:1,y:0,button:'left'});await ui.pointer({in:key,type:'up',x:1,y:0,button:'left'});}};
  await press('refresh');
  const quote=format==='plain'?'\n▶ run flo_unrelated — started\n':JSON.stringify({runId:'flo_unrelated',status:'running',result:'Another session run'})+'\n';
  w.output=quoted?(format==='plain'?"\nrun flo_first: completed\nFirst report\n\nrun flo_second: completed\nSecond report\n\n▶ run flo_unrelated — started\n\n":"\nrun flo_first: completed\nFirst report\n\nrun flo_second: completed\nSecond report\n{\"runId\":\"flo_unrelated\",\"status\":\"running\",\"result\":\"Another session run\"}\n\n"):"\nrun flo_first: completed\nFirst report\n\nrun flo_second: completed\nSecond report\n";
  w.toolResult={stdout:w.output,stderr:'',interrupted:false};
  w.bashAction=()=>{
    w.states={flo_first:'completed',flo_second:'completed',flo_unrelated:'running'};
    w.files={flo_first:'first.mjs',flo_second:'report.mjs',flo_unrelated:'report.mjs'};
    w.created={flo_first:100_000,flo_second:101_000,flo_unrelated:102_000};w.mtime++;
  };
  w.questions=[{qid:'q0',t:102_003,question:'Approve other session work?'}];
  w.toolGate=deferred();w.toolEntered=deferred();const gate=w.toolGate;
  const call=$.tool.call({tool:'Bash',command:'flowition run first.mjs --quiet; flowition run report.mjs --quiet'});
  await w.toolEntered.promise;await clock.advance(5_000);gate.resolve();await call;
  await press('refresh'); await clock.advance(30_000); await press('refresh');
  expect({attached,selected,wrongToast:w.toasts.some(t=>t.startsWith('flo_unrelated asks:'))}).toEqual({attached:['flo_first','flo_second'],selected:'flo_second',wrongToast:false});
  await ui.unmount();
});

// Order: a later doubtful id waits for the command's earlier ones, so a quoted run listed
// first cannot take the launch an actual run, listed a poll later, accounts for.
for (const surface of ['terminal', 'desktop'] as const) test(`A14 doubtful ids are judged in output order: ${surface}`, async ($, on) => {
  let attached: string[] = []
  on('state.set', { plugin: 'flowition-cockpit', key: 'attached' }, ($, e, next) => { attached = e.value; return next(e) })
  const { w, clock } = setup(on); w.states = {}
  await $.session.start({ cwd: '/home/t', surface, isInteractive: true })
  const ui = await $.ui.mount(PANE(surface))
  const press = async (key: string) => { if (surface === 'terminal') await ui.press({ key }); else { await ui.pointer({ in: key, type: 'down', x: 1, y: 0, button: 'left' }); await ui.pointer({ in: key, type: 'up', x: 1, y: 0, button: 'left' }) } }
  await press('refresh')
  w.output = '\nrun flo_first: completed\nFirst report\n\nrun flo_second: completed\nSecond report\n\n▶ run flo_unrelated — started\n'
  w.toolResult = { stdout: w.output, stderr: '', interrupted: false }
  // The listing has the quoted run before it has the second launch's.
  w.bashAction = () => {
    w.states = { flo_first: 'completed', flo_unrelated: 'running' }
    w.files = { flo_first: 'first.mjs', flo_unrelated: 'report.mjs' }
    w.created = { flo_first: 100_000, flo_unrelated: 100_500 }; w.mtime++
  }
  await $.tool.call({ tool: 'Bash', command: 'flowition run first.mjs --quiet; flowition run report.mjs --quiet' })
  await press('refresh'); await clock.advance(30_000); await press('refresh')
  w.states.flo_second = 'completed'; w.files.flo_second = 'report.mjs'; w.created.flo_second = 100_200; w.mtime++
  await clock.advance(30_000); await press('refresh'); await clock.advance(30_000); await press('refresh')
  expect(attached).toEqual(['flo_first', 'flo_second'])
  await ui.unmount()
})
