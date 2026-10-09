// Regressions from the gpt-6-astra (xhigh) review loop, round 11: Astra's reproductions, as written.
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



for(const count of [1,2])test(`A15 named loop launches count=${count}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output=Array.from({length:count},(_,i)=>`started detached run flo_${i}`).join('\n')
 w.toolResult={stdout:w.output,stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command:count===1?'flowition run w.mjs --detach':`for topic in alpha beta; do flowition run w.mjs --args "{\\"topic\\":\\"$topic\\"}" --detach; done`})
 w.states=Object.fromEntries(Array.from({length:count},(_,i)=>[`flo_${i}`,'running']));w.mtime++
 w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t.endsWith('asks: Need input'))).toHaveLength(count)
 await ui.unmount()
})
for(const skipped of [false,true])test(`A20 resume execution must be observed skipped=${skipped}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_other:'running'};w.questions=[{qid:'q0',t:1000,question:'Need input'}]
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output=skipped?'':'run flo_other: completed';w.toolResult={stdout:w.output,stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command:skipped?'if false; then flowition resume flo_other --json; fi':'flowition resume flo_other --json'})
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_other asks: Need input')).toHaveLength(skipped?0:1)
 await ui.unmount()
})
for(const finished of [false,true])test(`A21 phase waiting on question finished=${finished}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:finished?'completed':'running'}
 w.questions=finished?[]:[{qid:'q0',t:2000,question:'Approve deployment?'}]
 w.events=jsonl([{t:1000,type:'run',state:'started',phases:[{title:'Approval'}]},{t:1500,type:'phase',phaseIndex:0,title:'Approval'},...(finished?[{t:3000,type:'run',state:'completed'}]:[])])
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'tab:phases'})
 const phase=(await ui.find({key:'phase:0'}))?.text??''
 if(finished)expect(phase).toContain('● done');else expect(phase).not.toContain('● done')
 await ui.unmount()
})
for(const background of [false,true])test(`A15 loop output JSON names both launches background=${background}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output=[0,1].map(i=>JSON.stringify({runId:`flo_${i}`,detached:true,status:'started'})).join('\n')
 w.toolResult={stdout:w.output,stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command:`for topic in alpha beta; do flowition run w.mjs --detach --json ${background?'& ':''}done${background?'; wait':''}`.replace('--json done','--json; done')})
 w.states={flo_0:'running',flo_1:'running'};w.mtime++;w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t.endsWith('asks: Need input'))).toHaveLength(2)
 await ui.unmount()
})
for(const skipped of [false,true])test(`A20 conditional retry from actual JSON run states skipped=${skipped}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_other:'completed'}
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output=skipped?'':JSON.stringify({runId:'flo_other',status:'completed',result:'done'});w.toolResult={stdout:w.output,stderr:'',interrupted:false}
 const condition=skipped?'completed':'failed'
 await $.tool.call({tool:'Bash',command:`state=${condition}; if [ "$state" = failed ]; then flowition resume flo_other --json; fi`})
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_other completed')).toHaveLength(skipped?0:1)
 const selected=(await ui.find({key:'header'}))?.text??''
 expect(selected.includes('launched here')).toBe(!skipped)
 await ui.unmount()
})
for(const dynamic of [false,true])test(`A12 fully named background plus foreground variable dynamic=${dynamic}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output='started detached run flo_back\nstarted detached run flo_front'
 w.toolResult={stdout:w.output,stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command:`WF=front.mjs; flowition run back.mjs --detach & flowition run ${dynamic?'"$WF"':'front.mjs'} --detach; wait`})
 w.states={flo_back:'running',flo_front:'running'};w.files={flo_back:'back.mjs',flo_front:'front.mjs'};w.mtime++
 w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(5000)
 w.states.flo_elsewhere='running';w.files.flo_elsewhere='back.mjs';w.created.flo_elsewhere=105_000;w.mtime++
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_back asks: Need input')).toHaveLength(1)
 expect(w.toasts.filter(t=>t==='flo_front asks: Need input')).toHaveLength(1)
 expect(w.toasts.filter(t=>t==='flo_elsewhere asks: Need input')).toHaveLength(0)
 await ui.unmount()
})
