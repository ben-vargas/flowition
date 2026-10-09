// Regressions from the gpt-6.1-sol (xhigh) review loop, third pass, round 1: Sol's reproduction, as written.
// A foreground run's result quoting CLI lines (event, run, detached-launch, blank-set-off) names no launch.
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





const CASES = {"ordinary": "\nrun flo_actual: completed\nThe referenced run needs review.\n", "event": "\nrun flo_actual: completed\nFailure analysis:\n```text\n▶ run flo_reference — failed: adapter refused\n```\nTry again after fixing credentials.\n", "bare": "\nrun flo_actual: completed\nRelated run:\nrun flo_reference\n", "detached": "\nrun flo_actual: completed\nPrior launch output:\n```text\nstarted detached run flo_reference\n  status: flowition status flo_reference\n```\n", "blank": "\nrun flo_actual: completed\nRelated run output:\n\nrun flo_reference: failed\nadapter refused\n"} as const;
for (const surface of ['terminal','desktop'] as const) for (const [kind,output] of Object.entries(CASES)) test(`A14 quoted CLI output stays in the report: ${surface}/${kind}`, async ($,on)=>{
 let attached: string[] = []; let selected: string | null = null;
 on('state.set',{plugin:'flowition-cockpit',key:'attached'},($,e,next)=>{attached=e.value;return next(e)});
 on('state.set',{plugin:'flowition-cockpit',key:'selected'},($,e,next)=>{selected=e.value;return next(e)});
 const {w,clock}=setup(on); w.states={flo_reference:'running'}; w.files.flo_reference='other.mjs';
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});
 const ui=await $.ui.mount(PANE(surface));
 const press=async(key:string)=>{if(surface==='terminal')await ui.press({key});else{await ui.pointer({in:key,type:'down',x:1,y:0,button:'left'});await ui.pointer({in:key,type:'up',x:1,y:0,button:'left'});}};
 await press('refresh');
 w.output=output; w.toolResult={stdout:output,stderr:'',interrupted:false};
 w.bashAction=()=>{w.states.flo_actual='completed';w.files.flo_actual='report.mjs';w.created.flo_actual=100_000;w.mtime++};
 w.questions=[{qid:'q0',t:100_001,question:'Need approval for unrelated run'}];
 await $.tool.call({tool:'Bash',command:'flowition run report.mjs --quiet'});
 await press('refresh'); await clock.advance(30_000); await press('refresh');
 expect({kind,attached,selected,wrongToast:w.toasts.some(t=>t.startsWith('flo_reference asks:'))}).toEqual({kind,attached:['flo_actual'],selected:'flo_actual',wrongToast:false});
 await ui.unmount();
});

// The other side of A14: a later run's lines in the same output read like a result quoting
// the CLI, so they are judged on evidence. A loop's or a compound command's own new runs still
// attach; a run created meanwhile that no launch of the command accounts for does not.
const SCENARIOS = {
  loop: { command: 'for t in x y; do flowition run w.mjs --quiet; done', runs: { flo_one: 'w.mjs', flo_two: 'w.mjs' }, output: '\nrun flo_one: completed\nreport one\n\nrun flo_two: completed\nreport two\n', attached: ['flo_one', 'flo_two'] },
  compound: { command: 'flowition run a.mjs --quiet; flowition run b.mjs --detach', runs: { flo_one: 'a.mjs', flo_two: 'b.mjs' }, output: '\nrun flo_one: completed\nreport one\nstarted detached run flo_two\n  status: flowition status flo_two\n', attached: ['flo_one', 'flo_two'] },
  quotedNewRun: { command: 'flowition run report.mjs --quiet', runs: { flo_one: 'report.mjs', flo_two: 'other.mjs' }, output: '\nrun flo_one: completed\nSee also:\n\nrun flo_two: running\n', attached: ['flo_one'] },
  loopQuotesOldRun: { command: 'for t in x y; do flowition run w.mjs --quiet; done', runs: { flo_one: 'w.mjs' }, output: '\nrun flo_one: completed\nreport one\n\nrun flo_reference: failed\n', attached: ['flo_one'] },
} as const
for (const surface of ['terminal', 'desktop'] as const) for (const [kind, sc] of Object.entries(SCENARIOS)) test(`A14 later launches in one output attach on evidence: ${surface}/${kind}`, async ($, on) => {
  let attached: string[] = []
  on('state.set', { plugin: 'flowition-cockpit', key: 'attached' }, ($, e, next) => { attached = e.value; return next(e) })
  const { w, clock } = setup(on); w.states = { flo_reference: 'failed' }; w.files.flo_reference = 'w.mjs'
  await $.session.start({ cwd: '/home/t', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE(surface))
  const press = async (key: string) => { if (surface === 'terminal') await ui.press({ key }); else { await ui.pointer({ in: key, type: 'down', x: 1, y: 0, button: 'left' }); await ui.pointer({ in: key, type: 'up', x: 1, y: 0, button: 'left' }) } }
  await press('refresh')
  w.output = sc.output; w.toolResult = { stdout: sc.output, stderr: '', interrupted: false }
  w.bashAction = () => { for (const [id, file] of Object.entries(sc.runs)) { w.states[id] = 'completed'; w.files[id] = file; w.created[id] = 100_000 } w.mtime++ }
  await $.tool.call({ tool: 'Bash', command: sc.command })
  await press('refresh'); await clock.advance(30_000); await press('refresh')
  expect({ kind, attached }).toEqual({ kind, attached: [...sc.attached] })
  await ui.unmount()
})
