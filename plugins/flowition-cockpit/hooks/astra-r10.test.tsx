// Regressions from the gpt-6-astra (xhigh) review loop, round 10: Astra's reproductions, as written.
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



for(const provisional of [false,true])test(`A12 named launch first appears without journal metadata, provisional=${provisional}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output='started detached run flo_here';w.toolResult={stdout:w.output,stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach & wait'})
 w.states={flo_here:provisional?'unknown':'running'};w.files.flo_here=provisional?'?':'w.mjs';w.created.flo_here=provisional?0:100_000;w.mtime++
 await clock.advance(5000)
 w.states.flo_here='running';w.files.flo_here='w.mjs';w.created.flo_here=100_000;w.mtime++
 w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(5000)
 w.states.flo_elsewhere='running';w.created.flo_elsewhere=110_000;w.mtime++
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_here asks: Need input')).toHaveLength(1)
 expect(w.toasts.filter(t=>t==='flo_elsewhere asks: Need input')).toHaveLength(0)
 await ui.unmount()
})
for(const sameFile of [false,true])test(`A15 shell background slow plus named foreground fast, sameFile=${sameFile}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output='started detached run flo_fast';w.toolResult={stdout:w.output,stderr:'',interrupted:false}
 const fast=sameFile?'w.mjs':'fast.mjs'
 await $.tool.call({tool:'Bash',command:`flowition run w.mjs --args '{"topic":"slow"}' --json >/tmp/slow.log 2>&1 & flowition run ${fast} --args '{"topic":"fast"}' --detach`})
 w.states={flo_slow:'running',flo_fast:'running'};w.files={flo_slow:'w.mjs',flo_fast:fast};w.mtime++
 w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_slow asks: Need input')).toHaveLength(1)
 expect(w.toasts.filter(t=>t==='flo_fast asks: Need input')).toHaveLength(1)
 await ui.unmount()
})
for(const [name,command] of [
 ['plain','flowition run w.mjs --json >/tmp/w.log &'],
 ['and-list','flowition run w.mjs --json >/tmp/w.log && echo finished &'],
 ['subshell','(flowition run w.mjs --json) >/tmp/w.log &'],
 ['pipeline','flowition run w.mjs --json | cat >/tmp/w.log &'],
] as const)test(`A17 shell backgrounds whole command list ${name}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output='';w.toolResult={stdout:'',stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command})
 w.states={flo_new:'running'};w.mtime++;w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_new asks: Need input')).toHaveLength(1)
 await ui.unmount()
})
for(const [name,command] of [
 ['plain','flowition run w.mjs --json'],
 ['conditional','if test -f w.mjs; then flowition run w.mjs --json; fi'],
 ['loop','for topic in alpha beta; do flowition run w.mjs --args "{\\"topic\\":\\"$topic\\"}" --json; done'],
] as const)test(`A20 compound shell launch ${name}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output='Command was moved to the background (ID: task1)';w.toolResult={stdout:'',stderr:'',interrupted:false,backgroundTaskId:'task1'}
 await $.tool.call({tool:'Bash',command})
 w.states={flo_new:'running'};w.mtime++;w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_new asks: Need input')).toHaveLength(1)
 await ui.unmount()
})
for(const heredoc of [false,true])test(`A20 commands in quoted here-doc are not executions, heredoc=${heredoc}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_unrelated:'running'};w.createdAt=1000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output='';w.toolResult={stdout:'',stderr:'',interrupted:false}
 await $.tool.call({tool:'Bash',command:heredoc?"cat <<'EOF' >/tmp/repro.sh\nflowition resume flo_unrelated\nEOF":"printf '%s\\n' 'flowition resume flo_unrelated' >/tmp/repro.sh"})
 w.questions=[{qid:'q0',t:100_000,question:'Need input'}];w.mtime++
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_unrelated asks: Need input')).toHaveLength(0)
 await ui.unmount()
})

test('A17/A20: launches read from the shell\'s structure', () => {
  const of = (c: string) => launchesIn(c).invocations.map((v) => [v.file, v.isBackground])
  // `&` backgrounds its whole and-or list, groups and pipelines included.
  expect(of('(flowition run a.mjs --json) >/tmp/l &')).toEqual([['a.mjs', true]])
  expect(of('cd w && flowition run a.mjs --json &')).toEqual([['a.mjs', true]])
  expect(of('flowition run a.mjs --json | tee /tmp/l &')).toEqual([['a.mjs', true]])
  expect(of('{ flowition run a.mjs; flowition run b.mjs; } & flowition run c.mjs')).toEqual([['a.mjs', true], ['b.mjs', true], ['c.mjs', false]])
  // A redirection's & is no background.
  expect(of('flowition run a.mjs --json >/tmp/l 2>&1')).toEqual([['a.mjs', false]])
  // Compound commands run their bodies; a heredoc body runs nothing.
  expect(of('if true; then flowition run a.mjs; fi')).toEqual([['a.mjs', false]])
  expect(of('for t in x y; do flowition run "w.mjs" --args "{}" & done')).toEqual([['w.mjs', true]])
  expect(of("cat > /tmp/notes <<'EOF'\nflowition resume flo_x\nEOF\nflowition run b.mjs")).toEqual([['b.mjs', false]])
})
