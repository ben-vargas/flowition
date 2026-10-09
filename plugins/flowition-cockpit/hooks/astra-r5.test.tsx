// Regressions from the gpt-6-astra (xhigh) review loop, round 5: Astra's reproductions, as written.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { extractRunIds, launchesIn } from './lib'

const ok=(stdout:string)=>({value:{exitCode:0,stdout,stderr:'',isStdoutTruncated:false,isStderrTruncated:false}})
const flo=(args:string)=>({command:'flo',args,origin:{kind:'composer' as const},presentation:{isFullscreen:true,columns:160}})
const PANE=(surface:'terminal'|'desktop')=>({plugin:'flowition-cockpit',surface,component:'Pane',requestId:'flo',props:{title:'Flowition',isFocused:false,bodyColumns:100,placement:'dock',scroll:{offset:0,bodyRows:30},view:{}},viewport:{columns:160,rows:40}}) as const
const jsonl=(rows:object[])=>rows.map(r=>JSON.stringify(r)+'\n').join('')
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}
function setup(on:On){
 const clock=mock.clock(on,{now:100_000})
 const w={states:{flo_a:'failed'} as Record<string,string>,toasts:[] as string[],calls:[] as string[][],output:'started detached run flo_a',questions:[] as object[],agents:[] as object[],events:'',transcript:'',gate:null as ReturnType<typeof deferred>|null,entered:null as ReturnType<typeof deferred>|null,createdAt:1000,rawStatus:null as string|null,completeOnLaunch:false,mtime:1,listGate:null as ReturnType<typeof deferred>|null,listEntered:null as ReturnType<typeof deferred>|null,created:{} as Record<string,number>}
 mock.env(on,{HOME:'/home/t',FLOWITION_HOME:'/home/t/.flowition',FLOWITION_BIN:'/bin/flowition',PATH:'/usr/bin'})
 on('session.start',($,e)=>({cwd:e.cwd}));on('command.register',($,e)=>({value:{command:e.name}}))
 on('fs.stat',($,e)=>({value:{kind:'file',size:e.path.includes('/agents/')?w.transcript.length:e.path.endsWith('events.jsonl')?w.events.length:0,mtimeMs:w.mtime,isLink:false}}))
 on('fs.list',()=>({value:[]}));on('ui.open',()=>({value:{isPlaced:true}}));on('ui.panes',()=>({value:[]}));on('ui.status',()=>({value:undefined}));on('ui.log',()=>({value:undefined}));on('ui.scroll',()=>({}))
 on('ui.toast',($,e)=>{w.toasts.push(e.text);return {value:undefined}})
 on('tool.call',{tool:'Bash'},()=>({result:w.output,text:w.output}))
 on('process.run',async($,e)=>{
   const argv=[...e.argv];w.calls.push(argv)
   if(argv[0]==='head')return ok(JSON.stringify({t:1,type:'run',state:'started',workflowFile:'/w.mjs'}))
   if(argv[0]==='/bin/sh'){const s=argv[5]?.includes('/agents/')?w.transcript:w.events;const from=Number(argv[4])-1;return ok(s.slice(from,from+Number(argv[6])))}
   if(argv[1]==='runs'){const text=JSON.stringify(Object.entries(w.states).map(([runId,state])=>({runId,state,file:'w.mjs',createdAt:w.created[runId]??w.createdAt})).sort((a,b)=>b.createdAt-a.createdAt)); const gate=w.listGate;w.listGate=null;if(gate){w.listEntered?.resolve();await gate.promise};return ok(text)}
   if(argv[1]==='status'){
     const runId=argv[2]!;const text=w.rawStatus??JSON.stringify({runId,state:w.states[runId],result:null,phases:[],agents:w.agents,steps:[],questions:w.questions,live:{ok:true,questions:w.questions}})
     const gate=w.gate;w.gate=null;if(gate){w.entered?.resolve();await gate.promise}
     return ok(text)
   }
   if(argv[1]==='run'){if(w.completeOnLaunch)w.states.flo_a='completed';return ok('{"runId":"flo_a","detached":true,"status":"started"}')}
   return ok('{"ok":true}')
 })
 return {w,clock}
}

for(const kind of ['completed','question'])for(const overlap of [false,true])test(`A2 listing overlap=${overlap}, notification=${kind}`,async($,on)=>{
 const {w}=setup(on)
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'))
 w.states.flo_new=kind==='completed'?'completed':'running'
 w.questions=kind==='question'?[{qid:'q0',t:100_000,question:'Need input'}]:[]
 let polling:Promise<unknown>|null=null;let gate:ReturnType<typeof deferred>|null=null
 if(overlap){gate=deferred();w.listGate=gate;w.listEntered=deferred();polling=ui.press({key:'refresh'});await w.listEntered.promise}
 w.output='started detached run flo_new'
 await $.tool.call({tool:'Bash',command:'flowition run new.mjs --detach'})
 if(gate){gate.resolve();await polling}
 await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>kind==='completed'?t==='flo_new completed':t==='flo_new asks: Need input')).toHaveLength(1)
 await ui.unmount()
})
for(const recentOther of [false,true])test(`A12 background matching does not consume another session run, recentOther=${recentOther}`,async($,on)=>{
 const {w}=setup(on);w.states=recentOther?{flo_other:'running'}:{};w.created={flo_other:98_000,flo_new:100_000}
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 w.output='Command running in background with ID: bash123'
 await $.tool.call({tool:'Bash',command:'flowition run new.mjs'})
 w.states.flo_new='running';w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_new asks: Need input')).toHaveLength(1)
 await ui.unmount()
})

for(const resumed of [false,true])test(`A13 timeline stops abandoned lane, resumed=${resumed}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:resumed?'running':'stale'}
 w.agents=[{t:4000,index:0,key:'k0',label:'old worker',adapter:'codex',state:'running',outputTokens:1200,lastOutputAt:4000}]
 w.events=jsonl([{t:10,type:'run',state:'started'},{t:1000,type:'agent',index:0,label:'old worker',state:'running'}, {t:4000,type:'agent',index:0,state:'progress',outputTokens:1200,lastOutputAt:4000},...(resumed?[{t:8000,type:'run',state:'resumed'}]:[])])
 w.rawStatus=JSON.stringify({runId:'flo_a',state:w.states.flo_a,agents:w.agents,result:null,phases:[],steps:[],questions:[],live:resumed?{ok:true,agents:[],questions:[]}:null})
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'))
 expect(await ui.find({key:'steer:flo_a:0'})).toBeUndefined()
 await ui.press({key:'tab:timeline'})
 expect((await ui.find({key:'lane:a:0'}))?.text).toMatch(/3s$/)
 await ui.unmount()
})

for(const kind of ['completed','question'])test(`A2 listing overlap on the actual poll timer, notification=${kind}`,async($,on)=>{
 const {w,clock}=setup(on)
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'))
 w.states.flo_new=kind==='completed'?'completed':'running';w.mtime++
 w.questions=kind==='question'?[{qid:'q0',t:100_000,question:'Need input'}]:[]
 const gate=deferred();w.listGate=gate;w.listEntered=deferred()
 const polling=clock.advance(2500);await w.listEntered.promise
 w.output='started detached run flo_new'
 await $.tool.call({tool:'Bash',command:'flowition run new.mjs --detach'})
 gate.resolve();await polling
 await clock.advance(30_000)
 expect(w.toasts.filter(t=>kind==='completed'?t==='flo_new completed':t==='flo_new asks: Need input')).toHaveLength(1)
 await ui.unmount()
})

for(const launches of [1,2])for(const asJson of [false,true])test(`A15 every explicit launch in one Bash result is attached, count=${launches}, json=${asJson}`,async($,on)=>{
 const {w}=setup(on);w.states={}
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 const ids=Array.from({length:launches},(_,i)=>`flo_${i}`)
 w.output=ids.map(runId=>asJson?JSON.stringify({runId,detached:true,status:'started'}):`started detached run ${runId}\n  status: flowition status ${runId}\n  follow: flowition tail ${runId} -f`).join('\n')
 for(const id of ids)w.states[id]='running'
 w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await $.tool.call({tool:'Bash',command:ids.map((_,i)=>`flowition run workflow${i}.mjs --detach${asJson?' --json':''}`).join(' && ')})
 await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t.endsWith('asks: Need input'))).toHaveLength(launches)
 await ui.unmount()
})

test('A15: a launch output yields every run it names, and no id from a workflow result after them', () => {
  // Two detached launches; a foreground run whose result prints run-like lines and JSON.
  expect(extractRunIds('started detached run flo_1\n{"runId":"flo_2","detached":true,"status":"started"}\n', 2)).toEqual(['flo_1', 'flo_2'])
  const foreground = '▶ run flo_x — started\nrun flo_x: completed\nrun tests: passed\n{"runId":"flo_ref","message":"CI run analyzed"}\n'
  expect(extractRunIds(foreground, 2)).toEqual(['flo_x'])
  // At most as many as the command launched.
  expect(extractRunIds('started detached run flo_1\nstarted detached run flo_2\n', 1)).toEqual(['flo_1'])
  expect(launchesIn('flowition run a/one.mjs --detach && flo run two.mjs; flowition run w.mjs --resume flo_9 --detach')).toEqual({ files: ['one.mjs', 'two.mjs', null], count: 3 })
})
