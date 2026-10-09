// Regressions from the gpt-6-astra (xhigh) review loop, round 6: Astra's reproductions, as written.
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { extractRunIds, launchesIn, parseTranscript, appendEvents, emptyTimeline, foldTimeline, parseStatus, lifetimeWorkers, laneText, laneSvg } from './lib'

const ok=(stdout:string)=>({value:{exitCode:0,stdout,stderr:'',isStdoutTruncated:false,isStderrTruncated:false}})
const flo=(args:string)=>({command:'flo',args,origin:{kind:'composer' as const},presentation:{isFullscreen:true,columns:160}})
const PANE=(surface:'terminal'|'desktop')=>({plugin:'flowition-cockpit',surface,component:'Pane',requestId:'flo',props:{title:'Flowition',isFocused:false,bodyColumns:100,placement:'dock',scroll:{offset:0,bodyRows:30},view:{}},viewport:{columns:160,rows:40}}) as const
const jsonl=(rows:object[])=>rows.map(r=>JSON.stringify(r)+'\n').join('')
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r});return {promise,resolve}}
function setup(on:On){
 const clock=mock.clock(on,{now:100_000})
 const w={states:{flo_a:'failed'} as Record<string,string>,toasts:[] as string[],calls:[] as string[][],output:'started detached run flo_a',questions:[] as object[],agents:[] as object[],events:'',transcript:'',gate:null as ReturnType<typeof deferred>|null,entered:null as ReturnType<typeof deferred>|null,createdAt:1000,rawStatus:null as string|null,completeOnLaunch:false,mtime:1,listGate:null as ReturnType<typeof deferred>|null,listEntered:null as ReturnType<typeof deferred>|null,created:{} as Record<string,number>, toolGate:null as ReturnType<typeof deferred>|null, toolEntered:null as ReturnType<typeof deferred>|null}
 mock.env(on,{HOME:'/home/t',FLOWITION_HOME:'/home/t/.flowition',FLOWITION_BIN:'/bin/flowition',PATH:'/usr/bin'})
 on('session.start',($,e)=>({cwd:e.cwd}));on('command.register',($,e)=>({value:{command:e.name}}))
 on('fs.stat',($,e)=>({value:{kind:'file',size:e.path.includes('/agents/')?w.transcript.length:e.path.endsWith('events.jsonl')?w.events.length:0,mtimeMs:w.mtime,isLink:false}}))
 on('fs.list',()=>({value:[]}));on('ui.open',()=>({value:{isPlaced:true}}));on('ui.panes',()=>({value:[]}));on('ui.status',()=>({value:undefined}));on('ui.log',()=>({value:undefined}));on('ui.scroll',()=>({}))
 on('ui.toast',($,e)=>{w.toasts.push(e.text);return {value:undefined}})
 on('tool.call',{tool:'Bash'},async()=>{const gate=w.toolGate;w.toolGate=null;if(gate){w.toolEntered?.resolve();await gate.promise};return {result:w.output,text:w.output}})
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


for(const listedWhilePending of [false,true])test(`A12 background attachment when poll lists its run while Bash pending=${listedWhilePending}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 w.output='Command running in background with ID: bash123'
 const gate=deferred();w.toolGate=gate;w.toolEntered=deferred()
 const launching=$.tool.call({tool:'Bash',command:'flowition run w.mjs --json'})
 await w.toolEntered.promise
 w.states.flo_new='running';w.mtime++;w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 if(listedWhilePending)await clock.advance(5000)
 gate.resolve();await launching
 await clock.advance(30_000)
 await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_new asks: Need input')).toHaveLength(1)
 await ui.unmount()
})

for(const launches of [1,2])test(`A15 every explicit resume in a backgrounded Bash call attaches, count=${launches}`,async($,on)=>{
 const {w,clock}=setup(on);const ids=Array.from({length:launches},(_,i)=>`flo_${i}`)
 w.states=Object.fromEntries(ids.map(id=>[id,'failed']));w.createdAt=1000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 w.output='Command running in background with ID: bash123'
 for(const id of ids)w.states[id]='running'
 w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await $.tool.call({tool:'Bash',command:ids.map(id=>`flowition resume ${id} --json`).join(' & ')+' & wait'})
 await ui.press({key:'refresh'});await clock.advance(30_000)
 expect(w.toasts.filter(t=>t.endsWith('asks: Need input'))).toHaveLength(launches)
 await ui.unmount()
})


for(const resumed of [false,true])test(`A13 an abandoned QUEUED lane stops waiting at its last event, resumed=${resumed}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:resumed?'running':'stale'}
 w.agents=[{t:1000,index:0,key:'k0',label:'old queued worker',adapter:'codex',state:'queued'}]
 w.events=jsonl([{t:10,type:'run',state:'started'},{t:1000,type:'agent',index:0,label:'old queued worker',state:'queued'},...(resumed?[{t:8000,type:'run',state:'resumed'}]:[])])
 w.rawStatus=JSON.stringify({runId:'flo_a',state:w.states.flo_a,agents:w.agents,result:null,phases:[],steps:[],questions:[],live:resumed?{ok:true,agents:[],questions:[]}:null})
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('desktop'))
 await ui.pointer({in:'tab:timeline',type:'down',x:1,y:0,button:'left'})
 await ui.pointer({in:'tab:timeline',type:'up',x:1,y:0,button:'left'})
 const lane=await ui.find({key:'lane:a:0'})
 expect(lane?.text).toContain('interrupted')
 const svg=(await ui.findAll({type:'Svg'})).find(s=>String(s.props.alt).startsWith('old queued worker:'))
 expect(svg).toBeDefined()
 const width=Number(/width="([0-9.]+)" height="8" fill="url/.exec(String(svg?.props.source))?.[1])
 expect(width).toBeLessThanOrEqual(1)
 await ui.unmount()
})

for(const surface of ['terminal','desktop'] as const)test(`A16 run list renders its status badges on ${surface}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'failed'}
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE(surface))
 const badges=surface==='terminal'?await ui.findAll({type:'Text',text:/● failed/}):(await ui.findAll({type:'Svg'})).filter(x=>x.props.alt==='failed')
 expect(badges).toHaveLength(1)
 await ui.unmount()
})
for(const surface of ['terminal','desktop'] as const)test(`A16 timeline renders an actual agent bar on ${surface}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'completed'}
 w.agents=[{t:5000,index:0,key:'k0',label:'worker',state:'done'}]
 w.events=jsonl([{t:1000,type:'run',state:'started'},{t:2000,type:'agent',index:0,label:'worker',state:'queued'},{t:3000,type:'agent',index:0,state:'running'},{t:5000,type:'agent',index:0,state:'done'},{t:6000,type:'run',state:'completed'}])
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE(surface))
 if(surface==='terminal')await ui.press({key:'tab:timeline'})
 else{await ui.pointer({in:'tab:timeline',type:'down',x:1,y:0,button:'left'});await ui.pointer({in:'tab:timeline',type:'up',x:1,y:0,button:'left'})}
 const bars=surface==='terminal'?await ui.findAll({type:'Text',text:/█/}):(await ui.findAll({type:'Svg'})).filter(x=>String(x.props.alt).startsWith('worker: done'))
 expect(bars.length).toBeGreaterThan(0)
 await ui.unmount()
})
