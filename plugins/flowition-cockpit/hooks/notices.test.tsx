// Notices: completion and question toasts, wakes, and the attach/poll races around them; spend across attempts.
import { expect, mock, test } from 'claude-code/testing'
import { setup, ok, flo, PANE, jsonl, deferred, setupResume } from './test-kit'
import { emptyTimeline, foldTimeline, lifetimeWorkers, parseStatus } from './lib'
import { liveEvents, liveStatus, spendEvents, statuses } from './fixtures'

// The CLI lists each run with its own workflow file's basename (as launched).
const FILES_ASTRA_R4:Record<string,string>={flo_0:'workflow0.mjs',flo_1:'workflow1.mjs'}

// The CLI lists each run with its own workflow file's basename (as launched).
const FILES_ASTRA_R5:Record<string,string>={flo_new:'new.mjs'}

// (astra-r3)
for(const cached of [false,true])test(`A2: auto-attach after a poll committed the pending question, cached=${cached}`,async($,on)=>{
  const {w}=setupResume(on)
  w.questions=[{qid:'q0',question:'Ship it?',t:100_001}]
  if(!cached)delete w.states.flo_new
  await $.command.run(flo('flo_old'));const ui=await $.ui.mount(PANE('terminal'))
  w.states.flo_new='running'
  await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
  await ui.press({key:'refresh'});await ui.press({key:'refresh'})
  expect(w.toasts.filter(t=>t==='flo_new asks: Ship it?')).toHaveLength(1)
  await ui.unmount()
})

// (astra-r3)
for(const cached of [false,true])test(`A2: auto-attach after a poll committed completion, cached=${cached}`,async($,on)=>{
  const {w}=setupResume(on)
  if(!cached)delete w.states.flo_new
  await $.command.run(flo('flo_old'));const ui=await $.ui.mount(PANE('terminal'))
  w.states.flo_new='completed'
  if(cached)await ui.press({key:'refresh'})
  await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
  await ui.press({key:'refresh'});await ui.press({key:'refresh'})
  expect(w.toasts.filter(t=>t==='flo_new completed')).toHaveLength(1)
  await ui.unmount()
})

// (astra-r3)
test('A11: known output from a crashed attempt survives resume and final usage of a later attempt',async()=>{
  const events=jsonl([{t:100,type:'run',state:'started'},{t:110,type:'agent',index:0,state:'queued'},{t:120,type:'agent',index:0,state:'running'},{t:150,type:'agent',index:0,state:'progress',outputTokens:1200,lastOutputAt:150},{t:200,type:'run',state:'resumed'},{t:210,type:'agent',index:0,state:'queued'},{t:220,type:'agent',index:0,state:'running'},{t:250,type:'agent',index:0,state:'done',usage:{output:300,cost:0.03},outputTokens:300},{t:260,type:'run',state:'completed'}])
  const timeline=foldTimeline(emptyTimeline('flo_old'),events)
  const d=parseStatus(JSON.stringify({runId:'flo_old',state:'completed',agents:[{index:0,state:'done',t:250,usage:{output:300,cost:0.03},outputTokens:300,lastOutputAt:245}]}),300)
  expect(lifetimeWorkers(d.workers,timeline.lanes)[0]?.outputTokens).toBe(1500)
})

// (astra-r3)
test('A11: real CLI status and complete events hide 1200 crash-window tokens in the pane',async($,on)=>{
  const {w}=setupResume(on);w.states={flo_spend:'completed'};w.rawStatuses={flo_spend:statuses.flo_spend};w.events=spendEvents
  await $.command.run(flo('flo_spend'));const ui=await $.ui.mount(PANE('terminal'))
  expect((await ui.find({key:'t:tokens'}))?.text).toBe('Output1.5k tokens')
  await ui.unmount()
})

// (astra-r4)
for(const overlap of [false,true])test(`A2: watched resume retains its new notification baseline, overlap=${overlap}`,async($,on)=>{
 const {w}=setup(on, { files: FILES_ASTRA_R4 })
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'))
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
 await ui.press({key:'refresh'});w.toasts.length=0
 let polling:Promise<unknown>|null=null;let gate:ReturnType<typeof deferred>|null=null
 if(overlap){gate=deferred();w.gate=gate;w.entered=deferred();polling=ui.press({key:'refresh'});await w.entered.promise}
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --resume flo_a --detach'})
 w.states.flo_a='completed'
 if(gate){gate.resolve();await polling}
 await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(1)
 await ui.unmount()
})

// (astra-r4)
for(const isResumed of [false,true])test(`A13: an abandoned agent does not become live before its new attempt, resumed=${isResumed}`,async($,on)=>{
 const {w}=setup(on, { files: FILES_ASTRA_R4 });w.states={flo_a:isResumed?'running':'stale'}
 w.agents=[{t:150,index:0,key:'k0',label:'old worker',adapter:'codex',state:'running',outputTokens:1200,lastOutputAt:150}]
 w.events=jsonl([{t:10,type:'run',state:'started'},{t:100,type:'agent',index:0,state:'running'},{t:150,type:'agent',index:0,state:'progress',outputTokens:1200,lastOutputAt:150},...(isResumed?[{t:200,type:'run',state:'resumed'},{t:210,type:'question',qid:'q0',question:'Proceed?'}]:[])])
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'))
 expect(await ui.find({key:'steer:flo_a:0'})).toBeUndefined()
 await ui.unmount()
})

// (astra-r4)
for(const overlap of [false,true])test(`A2: pane Resume preserves baseline against in-flight status, overlap=${overlap}`,async($,on)=>{
 const {w,clock}=setup(on, { files: FILES_ASTRA_R4 })
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'))
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
 await ui.press({key:'refresh'});w.toasts.length=0
 await ui.press({key:'resume'})
 let polling:Promise<unknown>|null=null;let gate:ReturnType<typeof deferred>|null=null
 if(overlap){gate=deferred();w.gate=gate;w.entered=deferred();polling=ui.press({key:'refresh'});await w.entered.promise}
 w.completeOnLaunch=true
 const launching=ui.press({key:'resume-yes'})
 await clock.settle()
 if(gate)gate.resolve()
 await Promise.all([launching,polling])
 await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(1)
 await ui.unmount()
})

// (astra-r4)
test('A13: real CLI reports zero live agents; old worker must not offer live steering',async($,on)=>{
 const {w}=setup(on, { files: FILES_ASTRA_R4 });w.states={flo_a:'running'};w.rawStatus=liveStatus;w.events=liveEvents
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'))
 expect(await ui.find({key:'steer:flo_a:0'})).toBeUndefined()
 await ui.unmount()
})

// (astra-r5)
for(const kind of ['completed','question'])for(const overlap of [false,true])test(`A2 listing overlap=${overlap}, notification=${kind}`,async($,on)=>{
 const {w}=setup(on, { files: FILES_ASTRA_R5 })
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

// (astra-r5)
for(const resumed of [false,true])test(`A13 timeline stops abandoned lane, resumed=${resumed}`,async($,on)=>{
 const {w}=setup(on, { files: FILES_ASTRA_R5 });w.states={flo_a:resumed?'running':'stale'}
 w.agents=[{t:4000,index:0,key:'k0',label:'old worker',adapter:'codex',state:'running',outputTokens:1200,lastOutputAt:4000}]
 w.events=jsonl([{t:10,type:'run',state:'started'},{t:1000,type:'agent',index:0,label:'old worker',state:'running'}, {t:4000,type:'agent',index:0,state:'progress',outputTokens:1200,lastOutputAt:4000},...(resumed?[{t:8000,type:'run',state:'resumed'}]:[])])
 w.rawStatus=JSON.stringify({runId:'flo_a',state:w.states.flo_a,agents:w.agents,result:null,phases:[],steps:[],questions:[],live:resumed?{ok:true,agents:[],questions:[]}:null})
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'))
 expect(await ui.find({key:'steer:flo_a:0'})).toBeUndefined()
 await ui.press({key:'tab:timeline'})
 expect((await ui.find({key:'lane:a:0'}))?.text).toMatch(/3s$/)
 await ui.unmount()
})

// (astra-r5)
for(const kind of ['completed','question'])test(`A2 listing overlap on the actual poll timer, notification=${kind}`,async($,on)=>{
 const {w,clock}=setup(on, { files: FILES_ASTRA_R5 })
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

// (astra-r6)
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

// (astra-r8)
for(const overlap of [false,true])test(`A2 renewed attachment during cache commit, overlap=${overlap}`,async($,on)=>{
 const {w,clock}=setup(on)
 const gate=deferred(),entered=deferred();let armed=false
 on('state.set',{plugin:'flowition-cockpit',key:'details'},async($,e,next)=>{
   if(armed && e.value.flo_a?.workers.length){armed=false;entered.resolve();await gate.promise}
   return next(e)
 })
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
 const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'});w.toasts=[]
 armed=overlap
 // A normal forced poll changes the failed worker's detail, before the user resumes.
 w.agents=[{index:0,label:'Writer',state:'failed',error:'old attempt failed'}]
 let refreshing:Promise<unknown>|undefined
 if(overlap){refreshing=ui.press({key:'refresh'});await entered.promise}
 w.states.flo_a='completed'
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --resume flo_a --detach'})
 gate.resolve();if(refreshing)await refreshing
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(1)
 await ui.unmount()
})

// (astra-r8)
for(const overlap of [false,true])test(`A2 unchanged terminal poll commit/read race, overlap=${overlap}`,async($,on)=>{
 const {w,clock}=setup(on);const gate=deferred(),entered=deferred()
 on('state.get',{plugin:'flowition-cockpit',key:'details'},async($,e,next)=>{
   if(w.gateAfterStatus){w.gateAfterStatus=false;entered.resolve();await gate.promise};return next(e)
 })
 w.agents=[{index:0,label:'Writer',state:'failed',error:'old attempt failed'}]
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
 const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'});w.toasts=[]
 let refreshing:Promise<unknown>|undefined
 if(overlap){w.armAfterStatus=true;refreshing=ui.press({key:'refresh'});await entered.promise}
 w.states.flo_a='completed'
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --resume flo_a --detach'})
 gate.resolve();if(refreshing)await refreshing
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(1)
 await ui.unmount()
})

// (astra-r9)
for(const overlap of [false,true])test(`A2 poll beginning inside renewed attachment, overlap=${overlap}`,async($,on)=>{
 const {w,clock}=setup(on); const attachGate=deferred(),attachEntered=deferred(); let armed=false
 on('state.set',{plugin:'flowition-cockpit',key:'details'},async($,e,next)=>{
   if(armed && e.value.flo_a?.state==='starting'){armed=false;attachEntered.resolve();await attachGate.promise}
   return next(e)
 })
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
 const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'});w.toasts=[]
 armed=overlap;w.states.flo_a='completed'
 const attaching=$.tool.call({tool:'Bash',command:'flowition run w.mjs --resume flo_a --detach'})
 let refreshing:Promise<unknown>|undefined
 if(overlap){
  await attachEntered.promise
  w.gate=deferred();w.entered=deferred()
  const statusGate=w.gate
  refreshing=ui.press({key:'refresh'});await w.entered.promise
  attachGate.resolve();await attaching
  statusGate.resolve();await refreshing
 }else await attaching
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(1)
 await ui.unmount()
})

// (astra-r9)
for(const notification of ['completed','question'] as const)for(const overlap of [false,true])test(`A2 timer begins inside attachment ${notification}, overlap=${overlap}`,async($,on)=>{
 const {w,clock}=setup(on); const attachGate=deferred(),attachEntered=deferred(); let armed=false
 on('state.set',{plugin:'flowition-cockpit',key:'details'},async($,e,next)=>{
   if(armed && e.value.flo_a?.state==='starting'){armed=false;attachEntered.resolve();await attachGate.promise}
   return next(e)
 })
 if(notification==='question'){w.states.flo_a='running';w.questions=[{qid:'q0',t:99_999,question:'Need input'}]}
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 if(notification==='completed')await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
 await ui.press({key:'refresh'});w.toasts=[]
 armed=overlap;if(notification==='completed')w.states.flo_a='completed'
 const attaching=$.tool.call({tool:'Bash',command:notification==='completed'?'flowition resume flo_a':'flowition run w.mjs --detach'})
 if(overlap){
  await attachEntered.promise
  w.gate=deferred();w.entered=deferred(); const statusGate=w.gate
  const polling=clock.advance(2500);await w.entered.promise
  attachGate.resolve();await attaching
  statusGate.resolve();await polling
 }else await attaching
 await clock.advance(30_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t===(notification==='completed'?'flo_a completed':'flo_a asks: Need input'))).toHaveLength(1)
 await ui.unmount()
})

// (astra-r13)
// At hot reload, session.start resets the display cache while attached survives.
for(const reload of [false,true])test(`A22 completion across cache reset on session.start reload=${reload}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_a:'running'}
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 w.output='started detached run flo_a';await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'})
 const ui=await $.ui.mount(PANE('terminal'))
 await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.cacheStates[w.cacheStates.length-1]).toBe('running')
 w.toasts=[];w.states.flo_a='completed'
 if(reload)await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await ui.press({key:'refresh'});await ui.press({key:'refresh'});await clock.advance(30_000)
 const notices=w.toasts.filter(t=>t==='flo_a completed')
 await ui.unmount()
 expect(notices).toHaveLength(1)
})

// (astra-r14)
for(const reload of [false,true])test(`A22 previously announced completion is not repeated reload=${reload}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_a:'running'}
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'})
 w.states.flo_a='completed';await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(1)
 w.toasts=[]
 if(reload)await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await clock.advance(65_000);await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(0)
 await ui.unmount()
})

// (astra-r18)
for(const ended of [false,true])test(`A22 repeated reload preserves notice state, ended=${ended}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_a:'running'};w.questions=[{qid:'q0',t:5000,question:'Continue?'}];
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'});
 const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'});await ui.press({key:'refresh'});expect(w.toasts.filter(t=>t==='flo_a asks: Continue?')).toHaveLength(1);
 if(ended){w.states.flo_a='completed';await ui.press({key:'refresh'});expect(w.toasts.filter(t=>t==='flo_a completed')).toHaveLength(1);}
 w.toasts=[];
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});await ui.press({key:'refresh'});await clock.advance(30_000);
 expect(w.toasts).toHaveLength(0);await ui.unmount();
});
