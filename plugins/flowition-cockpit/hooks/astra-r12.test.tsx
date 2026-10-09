// Regressions from the gpt-6-astra (xhigh) review loop, round 12: Astra's reproductions, as written.
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
 const w={armAfterStatus:false,gateAfterStatus:false,states:{flo_a:'failed'} as Record<string,string>,toasts:[] as string[],calls:[] as string[][],output:'started detached run flo_a',toolResult:null as any,questions:[] as object[],agents:[] as object[],events:'',transcript:'',gate:null as ReturnType<typeof deferred>|null,entered:null as ReturnType<typeof deferred>|null,createdAt:1000,rawStatus:null as string|null,completeOnLaunch:false,mtime:1,listGate:null as ReturnType<typeof deferred>|null,listEntered:null as ReturnType<typeof deferred>|null,created:{} as Record<string,number>,files:{} as Record<string,string>, toolGate:null as ReturnType<typeof deferred>|null, toolEntered:null as ReturnType<typeof deferred>|null}
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
     if(w.armAfterStatus){w.armAfterStatus=false;w.gateAfterStatus=true}
     return ok(text)
   }
   if(argv[1]==='run'){if(w.completeOnLaunch)w.states.flo_a='completed';return ok('{"runId":"flo_a","detached":true,"status":"started"}')}
   return ok('{"ok":true}')
 })
 return {w,clock}
}



// A running run's ordinary progress does not prove that a conditional resume ran.
for(const grew of [false,true])test(`A20 skipped resume while existing run progresses grew=${grew}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_other:'running'}
 w.events=jsonl([{t:1000,type:'run',runId:'flo_other',state:'started'}]);w.questions=[{qid:'q0',t:1100,question:'Need input'}]
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'})
 w.output='';w.toolResult={stdout:'',stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command:'state=running; if [ "$state" = failed ]; then flowition resume flo_other --json; fi'})
 if(grew)w.events+=jsonl([{t:100_100,type:'agent',index:0,state:'progress',outputTokens:20,lastOutputAt:100_100}])
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_other asks: Need input')).toHaveLength(0)
 expect((await ui.find({key:'header'}))?.text??'').not.toContain('launched here')
 await ui.unmount()
})
// A foreground workflow's result is arbitrary text, including a one-line JSON report.
for(const report of [false,true])test(`A14 a foreground JSON-string report does not attach its referenced run report=${report}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_reference:'running'};w.questions=[{qid:'q0',t:1100,question:'Need input'}]
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'})
 w.output='run flo_actual: completed\n'+(report?JSON.stringify({runId:'flo_reference',status:'completed',message:'Run analyzed'}):'Run analyzed')
 w.toolResult={stdout:w.output,stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command:'flowition run report.mjs'})
 w.states.flo_actual='completed';w.mtime++
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_actual completed')).toHaveLength(1)
 expect(w.toasts.filter(t=>t==='flo_reference asks: Need input')).toHaveLength(0)
 await ui.unmount()
})
for(const [name,text] of [
 ['plain','run flo_actual: completed\nRun analyzed'],
 ['json','run flo_actual: completed\n{"runId":"flo_reference","status":"completed"}'],
 ['text','run flo_actual: completed\nrun flo_reference: completed'],
] as const)test(`A14 extraction result boundary ${name}`,()=>{expect(extractRunIds(text)).toEqual(['flo_actual'])})
// Resume re-enters phase 0; the former attempt's phase 1 is not the current phase.
for(const resumed of [false,true])test(`A21 resumed empty approval phase resumed=${resumed}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'running'}
 w.questions=[{qid:'q0',t:4500,question:'Approve deployment?'}]
 w.events=jsonl([{t:1000,type:'run',state:'started',phases:[{title:'Approval'},{title:'Release'}]},
 {t:1500,type:'phase',phaseIndex:0,title:'Approval'},
 ...(resumed?[{t:2000,type:'phase',phaseIndex:1,title:'Release'},{t:3000,type:'run',state:'failed'},
 {t:4000,type:'run',state:'resumed'},{t:4500,type:'phase',phaseIndex:0,title:'Approval'}]:[])])
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'tab:phases'})
 const phase=(await ui.find({key:'phase:0'}))?.text??''
 expect(phase).toContain('● running')
 await ui.unmount()
})

// A CI/report runId need not name any local flowition run: it still steals selection.
for(const withStatus of [false,true])test(`A14 JSON report with external CI id withStatus=${withStatus}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'})
 const report={runId:'12345',...(withStatus?{status:'completed'}:{}),message:'CI run analyzed'}
 w.output='run flo_actual: completed\n'+JSON.stringify(report)
 w.toolResult={stdout:w.output,stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command:'flowition run report.mjs'})
 w.states.flo_actual='completed';w.mtime++
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect((await ui.find({key:'header'}))?.text??'').toContain('flo_actual')
 await ui.unmount()
})

test('A14/A15: a foreground loop names each run the CLI sets off, not run lines inside a result', () => {
  // Two foreground runs in a loop: the CLI writes "\nrun <id>: <status>\n" then the result.
  expect(extractRunIds('\nrun flo_a: completed\nreport a\nrun flo_ref: completed\n\nrun flo_b: failed\nreport b\n')).toEqual(['flo_a', 'flo_b'])
})
