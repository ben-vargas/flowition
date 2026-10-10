// Auto-attach: which runs a Bash (or MCP) launch opens in the pane, and when.
import { expect, mock, test } from 'claude-code/testing'
import { setup, flo, PANE, deferred, setupNewRun, setupResume } from './test-kit'

// The CLI lists each run with its own workflow file's basename (as launched).
const FILES_ASTRA_R4:Record<string,string>={flo_0:'workflow0.mjs',flo_1:'workflow1.mjs'}

// The CLI lists each run with its own workflow file's basename (as launched).
const FILES_ASTRA_R5:Record<string,string>={flo_new:'new.mjs'}

const CASES_SOL2_R1 = {"ordinary": "\nrun flo_actual: completed\nThe referenced run needs review.\n", "event": "\nrun flo_actual: completed\nFailure analysis:\n```text\n▶ run flo_reference — failed: adapter refused\n```\nTry again after fixing credentials.\n", "bare": "\nrun flo_actual: completed\nRelated run:\nrun flo_reference\n", "detached": "\nrun flo_actual: completed\nPrior launch output:\n```text\nstarted detached run flo_reference\n  status: flowition status flo_reference\n```\n", "blank": "\nrun flo_actual: completed\nRelated run output:\n\nrun flo_reference: failed\nadapter refused\n"} as const;

// (astra)
for (const discovered of [false,true]) {
  test(`A2 discovery overlap: listed before attach = ${discovered}`,async($,on)=>{
    const {w}=setupNewRun(on)
    w.states.flo_old='running';w.gatedId='flo_old'
    await $.command.run(flo('flo_old'))
    const ui=await $.ui.mount(PANE('terminal'))
    if(discovered) w.states.flo_new='running'
    w.gate=deferred();w.entered=deferred()
    const poll=ui.press({key:'refresh'})
    await w.entered.promise
    await $.tool.call({tool:'Bash',command:'flowition run demo.workflow.mjs --detach'})
    w.states.flo_new='completed'
    w.gate.resolve();await poll;w.gate=null
    await ui.press({key:'refresh'})
    expect(w.toasts.filter(t=>t.includes('flo_new')&&t.includes('completed'))).toHaveLength(1)
    await ui.unmount()
  })
}

// (astra)
test('A6: plain foreground resume output attaches its run',async($,on)=>{
  const {w}=setupNewRun(on)
  await $.command.run(flo(''))
  // Exact event/final-line shapes emitted by EventSink and cli.js case resume.
  w.output='▶ run flo_old — resumed\n▶ run flo_old — completed\n\nrun flo_old: completed\nok\n'
  await $.tool.call({tool:'Bash',command:'flowition resume flo_old'})
  await $.command.run(flo('flo_old')); const ui=await $.ui.mount(PANE('terminal')); expect(await ui.find({text:/launched here/})).toBeDefined(); await ui.unmount()
})

// (astra)
test('A6: backgrounded foreground resume attaches despite old createdAt',async($,on)=>{
  const {w,clock}=setupNewRun(on)
  await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
  w.output='Command running in background with ID: abc'
  ;(w as {duringBash?:()=>void}).duringBash=()=>{w.states.flo_old='running'}
  await $.tool.call({tool:'Bash',command:'flowition resume flo_old'})
  await clock.advance(20_000)
  await $.command.run(flo('flo_old')); const ui=await $.ui.mount(PANE('terminal')); expect(await ui.find({text:/launched here/})).toBeDefined(); await ui.unmount()
})

// (astra)
test('A2 discovery overlap also permanently suppresses a pending question toast',async($,on)=>{
  const {w}=setupNewRun(on)
  w.states.flo_old='running';w.gatedId='flo_old'
  await $.command.run(flo('flo_old'));const ui=await $.ui.mount(PANE('terminal'))
  w.states.flo_new='running';w.gate=deferred();w.entered=deferred()
  const poll=ui.press({key:'refresh'});await w.entered.promise
  await $.tool.call({tool:'Bash',command:'flowition run demo.workflow.mjs --detach'})
  w.questions=[{qid:'q0',question:'Proceed?',t:100_010}]
  w.gate.resolve();await poll;w.gate=null
  await ui.press({key:'refresh'});await ui.press({key:'refresh'})
  expect(w.toasts.filter(t=>t.includes('flo_new asks: Proceed?'))).toHaveLength(1)
  await ui.unmount()
})

// (astra-r3)
test('A2: a real pending Bash launch lets polling commit the question before tool.call returns',async($,on)=>{
  const {w,clock}=setupResume(on);delete w.states.flo_new
  await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
  await $.command.run(flo('flo_old'));const ui=await $.ui.mount(PANE('terminal'))
  w.toolGate=deferred();w.toolEntered=deferred();w.output='Command running in background with ID: abc'
  const launching=$.tool.call({tool:'Bash',command:'flowition resume flo_new'})
  await w.toolEntered.promise
  w.states.flo_new='running';w.questions=[{qid:'q0',question:'Ship it?',t:100_001}]
  const polling=ui.press({key:'refresh'})
  await clock.settle()
  w.toolGate.resolve();await Promise.all([launching,polling])
  await clock.advance(10_000)
  expect(w.toasts.filter(t=>t==='flo_new asks: Ship it?')).toHaveLength(1)
  await ui.unmount()
})

// (astra-r4)
for(const launches of [1,2])test(`A12: every background launch attaches, count=${launches}`,async($,on)=>{
 const {w,clock}=setup(on, { files: FILES_ASTRA_R4 });w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 w.output='Command running in background with ID: bash123'
 for(let i=0;i<launches;i++)await $.tool.call({tool:'Bash',command:`flowition run workflow${i}.mjs`})
 for(let i=0;i<launches;i++)w.states[`flo_${i}`]='running'
 w.questions=[{t:100_110,qid:'q0',question:'Need input'}]
 await ui.press({key:'refresh'});await clock.advance(5000)
 expect(w.toasts.filter(t=>t.endsWith('asks: Need input'))).toHaveLength(launches)
 await ui.unmount()
})

// (astra-r4)
for(const structuredResult of [false,true])test(`A14: foreground auto-attach chooses launched run, structuredResult=${structuredResult}`,async($,on)=>{
 const {w}=setup(on, { files: FILES_ASTRA_R4 });w.states={flo_actual:'completed',flo_reference:'completed'}
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 w.output='\nrun flo_actual: completed\n'+(structuredResult?JSON.stringify({runId:'flo_reference',message:'CI run analyzed'}):'done')+'\n'
 await $.tool.call({tool:'Bash',command:'flowition run analyze.workflow.mjs'})
 await ui.press({key:'refresh'})
 expect(await ui.find({text:/flo_actual · launched here/})).toBeDefined()
 await ui.unmount()
})

// (astra-r5)
for(const recentOther of [false,true])test(`A12 background matching does not consume another session run, recentOther=${recentOther}`,async($,on)=>{
 const {w}=setup(on, { files: FILES_ASTRA_R5 });w.states=recentOther?{flo_other:'running'}:{};w.created={flo_other:98_000,flo_new:100_000}
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 w.output='Command running in background with ID: bash123'
 await $.tool.call({tool:'Bash',command:'flowition run new.mjs'})
 w.states.flo_new='running';w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_new asks: Need input')).toHaveLength(1)
 await ui.unmount()
})

// (astra-r5)
for(const launches of [1,2])for(const asJson of [false,true])test(`A15 every explicit launch in one Bash result is attached, count=${launches}, json=${asJson}`,async($,on)=>{
 const {w}=setup(on, { files: FILES_ASTRA_R5 });w.states={}
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

// (astra-r6)
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

// (astra-r6)
for(const launches of [1,2])test(`A15 every explicit resume in a backgrounded Bash call attaches, count=${launches}`,async($,on)=>{
 const {w,clock}=setup(on);const ids=Array.from({length:launches},(_,i)=>`flo_${i}`)
 w.states=Object.fromEntries(ids.map(id=>[id,'failed']));w.createdAt=1000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 w.output='Command running in background with ID: bash123'
 // The resumes make their runs live while the command runs (not before it).
 ;(w as {duringBash?:()=>void}).duringBash=()=>{for(const id of ids)w.states[id]='running'}
 w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await $.tool.call({tool:'Bash',command:ids.map(id=>`flowition resume ${id} --json`).join(' & ')+' & wait'})
 await ui.press({key:'refresh'});await clock.advance(30_000)
 expect(w.toasts.filter(t=>t.endsWith('asks: Need input'))).toHaveLength(launches)
 await ui.unmount()
})

// (astra-r7)
for(const unrelatedFirst of [false,true])test(`A12 a new unrelated workflow cannot consume discovery, unrelatedFirst=${unrelatedFirst}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 w.output='Command running in background with ID: bash123'
 await $.tool.call({tool:'Bash',command:'sleep 2 && flowition run wanted.mjs --json',run_in_background:true})
 w.questions=[{qid:'q0',t:100_100,question:'Need input'}]
 if(unrelatedFirst){w.states.flo_other='running';w.files.flo_other='unrelated.mjs';w.created.flo_other=100_100;w.mtime++;await clock.advance(2500)}
 w.states.flo_wanted='running';w.files.flo_wanted='wanted.mjs';w.created.flo_wanted=unrelatedFirst?102_500:100_000;w.mtime++
 await clock.advance(30_000)
 await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect({wanted:w.toasts.filter(t=>t==='flo_wanted asks: Need input').length,other:w.toasts.filter(t=>t==='flo_other asks: Need input').length}).toEqual({wanted:1,other:0})
 await ui.unmount()
})

// (astra-r7)
// Exact strings from 2.1.293's YQn Bash result formatter; these are different arms
// of the same backgroundTaskId result declared by claude-code.d.ts.
for(const how of ['explicit','timeout','user','message'] as const)test(`A17 new --json run attaches when Bash backgrounds it via ${how}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 const notes={
  explicit:'Command running in background with ID: bash123. Output is being written to: /tmp/bash123.output.',
  timeout:'Command did not complete within its 120s timeout and was moved to the background (ID: bash123). Output is being written to: /tmp/bash123.output.',
  user:'Command was manually backgrounded by user with ID: bash123. Output is being written to: /tmp/bash123.output.',
  message:'Command was moved to the background (ID: bash123) so that a message that arrived while it was running can reach you; it was not interrupted. Output is being written to: /tmp/bash123.output.'
 }
 w.output=notes[how]
 w.toolResult={stdout:'',stderr:'',interrupted:false,backgroundTaskId:'bash123',...(how==='timeout'?{timedOutAfterMs:120000}:how==='user'?{backgroundedByUser:true}:how==='message'?{backgroundedToDeliverMessage:true}:{})}
 // The non-explicit cases spend time in the foreground first. Polling can observe
 // the question while Bash is still pending; backgrounding must still attach it.
 const gate=deferred();w.toolGate=gate;w.toolEntered=deferred()
 const launching=$.tool.call({tool:'Bash',command:'flowition run w.mjs --json'})
 await w.toolEntered.promise
 w.states.flo_new='running';w.questions=[{qid:'q0',t:100_000,question:'Need input'}];w.mtime++
 if(how!=='explicit')await clock.advance(how==='timeout'?120_000:5000)
 gate.resolve();await launching
 await clock.advance(30_000)
 expect(w.toasts.filter(t=>t==='flo_new asks: Need input')).toHaveLength(1)
 await ui.unmount()
})

// (astra-r7)
for(const persisted of [false,true])test(`A18 foreground JSON result still attaches when Bash persists it, persisted=${persisted}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'))
 const stdout=JSON.stringify({runId:'flo_new',status:'completed',result:'Review report. '.repeat(persisted?5000:2)})
 // 2.1.293's Bash mapper formats persisted output through eke: a 2000-char preview.
 w.output=persisted?`<persisted-output>\nOutput too large (73.3KB). Full output saved to: /tmp/tool-results/report.txt\n\nPreview (first 2KB):\n${stdout.slice(0,2000)}\n...\n</persisted-output>`:stdout
 w.toolResult={stdout:stdout.slice(0,30000),stderr:'',interrupted:false,...(persisted?{persistedOutputPath:'/tmp/tool-results/report.txt',persistedOutputSize:stdout.length}:{})}
 w.states.flo_new='completed';w.mtime++
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --json'})
 await clock.advance(30_000)
 expect(w.toasts.filter(t=>t==='flo_new completed')).toHaveLength(1)
 await ui.unmount()
})

// (astra-r8)
for(const [name,command,file] of [
 ['plain','flowition run wanted.mjs --json','wanted.mjs'],
 ['option-first','flowition run --json wanted.mjs','wanted.mjs'],
 ['space-path','flowition run "/my workflows/wanted.mjs" --json','wanted.mjs'],
 ['quoted-name','flowition run "my workflow.mjs" --json','my workflow.mjs'],
] as const)test(`A20 background workflow extraction ${name}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output='Command running in background with ID: task1';w.toolResult={stdout:'',stderr:'',interrupted:false,backgroundTaskId:'task1'}
 await $.tool.call({tool:'Bash',command})
 w.states={flo_new:'running'};w.files={flo_new:file};w.mtime++;w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_new asks: Need input')).toHaveLength(1)
 await ui.unmount()
})

// (astra-r8)
for(const shellBackground of [false,true])test(`A17 shell-managed background launch, shellBackground=${shellBackground}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.createdAt=100_000
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true})
 const ui=await $.ui.mount(PANE('terminal'))
 w.output=shellBackground?'':'Command running in background with ID: task1'
 w.toolResult={stdout:'',stderr:'',interrupted:false,...(shellBackground?{}:{backgroundTaskId:'task1'})}
 await $.tool.call({tool:'Bash',command:shellBackground?'flowition run w.mjs --json > /tmp/w.log 2>&1 &':'flowition run w.mjs --json',...(!shellBackground?{run_in_background:true}:{})})
 w.states={flo_new:'running'};w.mtime++;w.questions=[{qid:'q0',t:100_000,question:'Need input'}]
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'})
 expect(w.toasts.filter(t=>t==='flo_new asks: Need input')).toHaveLength(1)
 await ui.unmount()
})

// (astra-r16)
for(const failed of [false,true])test(`A17 background workflow followed by wait exits failed=${failed}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'refresh'});
 w.isError=failed;w.output=failed?'Exit code 1':'';w.toolResult=failed?'Exit code 1':{stdout:'',stderr:'',interrupted:false};
 w.bashAction=()=>{w.states={flo_new:failed?'failed':'completed'};w.created.flo_new=100_000;w.mtime++};
 await $.tool.call({tool:'Bash',command:'flowition run w.mjs --json > /tmp/workflow.log 2>&1 & pid=$!; wait "$pid"'});
 await clock.advance(30_000);await ui.press({key:'refresh'});await ui.press({key:'refresh'});
 expect(w.toasts.filter(t=>t===`flo_new ${failed?'failed':'completed'}`)).toHaveLength(1);await ui.unmount();
});

// (astra-r18)
for(const refusal of [false,true])test(`An attachment state refusal cannot replay Bash, refused=${refusal}`,async($,on)=>{
 const {w}=setup(on);w.states={};let bashCalls=0;w.bashAction=()=>{bashCalls++};let armed=false;
 on('state.set',{plugin:'flowition-cockpit',key:'attached'},($,e,next)=>armed&&refusal?{deny:'state refused'}:next(e));
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});armed=true;
 const result=await $.tool.call({tool:'Bash',command:'flowition run w.mjs --detach'});
 expect(bashCalls).toBe(1);expect(result.text).toContain('flo_a');
});

// (sol2-r1)
for (const surface of ['terminal','desktop'] as const) for (const [kind,output] of Object.entries(CASES_SOL2_R1)) test(`A14 quoted CLI output stays in the report: ${surface}/${kind}`, async ($,on)=>{
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
