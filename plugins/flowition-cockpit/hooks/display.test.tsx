// What the pane draws: threads, timelines, phases, badges and bars, abandoned work.
import { expect, mock, test } from 'claude-code/testing'
import { setup, flo, PANE, jsonl, deferred, setupNewRun, setupResume } from './test-kit'
import { boundThread } from './lib'
import { phaseEvents, phaseStatus } from './fixtures'

// (astra)
for(const fragmented of [false,true]) test(`A5: same long reply keeps its newest text (fragmented=${fragmented})`,async($,on)=>{
  const {w}=setupNewRun(on)
  w.states.flo_old='running';w.agents=[{index:0,label:'Writer',state:'running'}]
  const text='x'.repeat(9000)+'FINAL RECOMMENDATION'; const chunks=fragmented?[text.slice(0,4000),text.slice(4000,8000),text.slice(8000)]:[text]; w.transcript=chunks.map((text,i)=>JSON.stringify({t:i+1,kind:'text',text})+'\n').join('')
  await $.command.run(flo('flo_old'))
  const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'agent:0'})
  expect((await ui.findAll({type:'Markdown'})).map(m=>m.text).join('').includes('FINAL RECOMMENDATION')).toBe(true)
  await ui.unmount()
})

// (astra)
for(const redacted of [false,true]) test(`A7: visible reasoning survives (adjacent redaction=${redacted})`,async($,on)=>{
  const {w}=setupNewRun(on)
  w.states.flo_old='running';w.agents=[{index:0,label:'Writer',state:'running'}]
  w.transcript=[{t:1,kind:'reasoning',text:'Visible reasoning'}, ...(redacted?[{t:2,kind:'reasoning',text:'',redacted:true}]:[])].map(x=>JSON.stringify(x)).join('\n')+'\n'
  await $.command.run(flo('flo_old'))
  const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'agent:0'})
  expect(await ui.find({text:/Visible reasoning/})).toBeDefined()
  await ui.unmount()
})

// (astra)
test('A5: a thread past $.state\'s room drops its oldest events, keeping the newest', async () => {
  const ev = (seq: number) => ({ seq, t: seq, kind: 'text', text: 'x'.repeat(20_000), name: null, summary: null, input: null, output: null, isError: false, toolId: null, toolUseId: null, redacted: false, attempt: null })
  const all = Array.from({ length: 200 }, (_, i) => ev(i))
  const kept = boundThread(all)
  expect([kept.isCut, JSON.stringify(kept.events).length <= 2_500_000, kept.events.at(-1)?.seq]).toEqual([true, true, 199])
})

// (astra-r3)
test('A10: a new attempt must not show the previous attempt\'s unanswered tool call as running',async($,on)=>{
  const {w}=setupResume(on);w.states={flo_old:'running'};w.agents=[{index:0,label:'Worker',adapter:'codex',state:'running'}]
  w.transcript=jsonl([{t:1,kind:'meta',prompt:'p',attempt:1},{t:2,kind:'tool',name:'Bash',id:'old',input:{command:'OLD interrupted tool'}},{t:3,kind:'status',text:'failed: provider gone'},{t:4,kind:'attempt',n:2},{t:5,kind:'meta',prompt:'p',attempt:2},{t:6,kind:'tool',name:'Bash',id:'new',input:{command:'NEW current tool'}}])
  await $.command.run(flo('flo_old'));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'agent:0'})
  expect(await ui.findAll({type:'Text',text:'running…'})).toHaveLength(1)
  await ui.unmount()
})

// (astra-r6)
for(const surface of ['terminal','desktop'] as const)test(`A16 run list renders its status badges on ${surface}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'failed'}
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE(surface))
 const badges=surface==='terminal'?await ui.findAll({type:'Text',text:/● failed/}):(await ui.findAll({type:'Svg'})).filter(x=>x.props.alt==='failed')
 expect(badges).toHaveLength(1)
 await ui.unmount()
})

// (astra-r6)
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

// (astra-r11)
for(const finished of [false,true])test(`A21 phase waiting on question finished=${finished}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:finished?'completed':'running'}
 w.questions=finished?[]:[{qid:'q0',t:2000,question:'Approve deployment?'}]
 w.events=jsonl([{t:1000,type:'run',state:'started',phases:[{title:'Approval'}]},{t:1500,type:'phase',phaseIndex:0,title:'Approval'},...(finished?[{t:3000,type:'run',state:'completed'}]:[])])
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'tab:phases'})
 const phase=(await ui.find({key:'phase:0'}))?.text??''
 if(finished)expect(phase).toContain('● done');else expect(phase).not.toContain('● done')
 await ui.unmount()
})

// (astra-r13)
// Current phase must not carry across a run-attempt opening before phase() is reached.
for(const resumed of [false,true])test(`A21 resume before reaching any current phase resumed=${resumed}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'running'}
 w.questions=[{qid:'q0',t:4500,question:'Ready to begin?'}]
 w.events=jsonl([{t:1000,type:'run',state:'started',phases:[{title:'Approval'},{title:'Release'}]},
 ...(resumed?[{t:2000,type:'phase',phaseIndex:1,title:'Release'},{t:3000,type:'run',state:'failed'},{t:4000,type:'run',state:'resumed'}]:[])])
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'tab:phases'})
 const phase=(await ui.find({key:'phase:1'}))?.text??''
 expect(phase).not.toContain('● running')
 expect((await ui.find({key:'t:phase'}))?.text??'').not.toContain('Release')
 await ui.unmount()
})

// (astra-r14)
for(const realStatus of [false,true])test(`A21 before first phase of resumed attempt real CLI status=${realStatus}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'running'};w.events=phaseEvents
 if(realStatus)w.rawStatus=phaseStatus
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'tab:phases'})
 expect((await ui.find({key:'phase:1'}))?.text??'').not.toContain('● running')
 expect((await ui.find({key:'t:phase'}))?.text??'').not.toContain('Release')
 await ui.unmount()
})

// (astra-r15)
for(const withWorker of [false,true])test(`Accepted parity control: phase badge rolls up workers, withWorker=${withWorker}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'running'};w.questions=[{qid:'q0',t:4000,question:'Approve release?'}];
 w.agents=withWorker?[{index:0,label:'Prepare',state:'done',phase:'Approval',phaseIndex:0,t:3000,usage:{output:100},durationMs:1000}]:[];
 w.events=jsonl([{t:1000,type:'run',state:'started',phases:[{title:'Approval'},{title:'Release'}]},{t:1500,type:'phase',phaseIndex:0,title:'Approval'},
 ...(withWorker?[{t:2000,type:'agent',index:0,label:'Prepare',state:'running',phaseIndex:0},{t:3000,type:'agent',index:0,label:'Prepare',state:'done',phaseIndex:0,usage:{output:100}}]:[]),{t:4000,type:'question',qid:'q0',question:'Approve release?'}]);
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'tab:phases'});
 // The reference viewer explicitly rolls up agents here; not a finding.
 expect((await ui.find({key:'phase:0'}))?.text??'').toContain(withWorker?'● done':'● running');await ui.unmount();
})

// (astra-r16)
for(const overlap of [false,true])test(`Core control: thread read racing navigation recovers overlap=${overlap}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={flo_a:'running'};w.agents=[{index:0,label:'First',state:'running'},{index:1,label:'Second',state:'running'}];
 w.transcript=jsonl([{t:1001,kind:'text',text:'First reply'}]);
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'agent:0'});
 w.transcript+=jsonl([{t:2000,kind:'text',text:' more'}]);
 if(overlap){w.threadGate=deferred();w.threadEntered=deferred();}
 const gate=w.threadGate;const refreshing=ui.press({key:'refresh'});
 if(overlap){await w.threadEntered!.promise;await $.command.run(flo('flo_a'));await ui.press({key:'agent:1'});gate!.resolve();}await refreshing;
 if(!overlap){await $.command.run(flo('flo_a'));await ui.press({key:'agent:1'});}
 await clock.advance(5000);expect((await ui.find({key:'events'}))?.text??'').toContain('First reply');expect((await ui.find({key:'header'}))?.text??'').toContain('Second');await ui.unmount();
});
