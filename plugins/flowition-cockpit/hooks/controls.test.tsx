// Controls and forms: Start, Resume, answers, the launcher's args and folder, navigation.
import { expect, mock, test } from 'claude-code/testing'
import { setup, flo, PANE, jsonl, deferred, setupNewRun, setupResume } from './test-kit'
import { prestartEvent, statuses } from './fixtures'

// (astra)
for (const surface of ['terminal', 'desktop'] as const) {
  test(`A8: Enter uses submitted args while a prior change is still persisting (${surface})`,async($,on)=>{
    const {w,clock}=setupNewRun(on)
    const gate=deferred(),entered=deferred()
    let hold=false
    on('state.set',{plugin:'flowition-cockpit',key:'launch'},async($,e,next)=>{
      if(hold && e.value?.args==='{"target":"B"}') {entered.resolve();await gate.promise}
      return next(e)
    })
    await $.command.run(flo(''))
    const ui=await $.ui.mount(PANE(surface))
    const press=async(key:string)=>{if(surface==='terminal')return ui.press({key});await ui.pointer({in:key,type:'down',x:1,y:0,button:'left'});await ui.pointer({in:key,type:'up',x:1,y:0,button:'left'})}
    const file='/home/t/.flowition/workflows/demo.workflow.mjs'
    await press('new');await press(surface==='terminal'?`wf-pick:${file}`:`wf:${file}`)
    await ui.input({key:`launch-args:${file}:0`,text:'{"target":"A"}',kind:'change'})
    hold=true
    const edit=ui.input({key:`launch-args:${file}:0`,text:'{"target":"B"}',kind:'change'})
    await entered.promise
    const submit=ui.input({key:`launch-args:${file}:0`,text:'{"target":"B"}',kind:'submit'})
    await clock.settle()
    hold=false;gate.resolve();await Promise.all([edit,submit])
    // (Since round 17 the launch also pins its folder with --cwd: not what this checks.)
    expect(w.calls.filter(c=>c.startsWith('run ')).map(c=>c.replace(/ --cwd \S+/,''))).toEqual([`run ${file} --args {"target":"B"} --detach --json`])
    await ui.unmount()
  })
}

// (astra-r3)
for(const initialEvent of ['started','failed'])test(`A9: a run with a journal can resume when its first event is ${initialEvent}`,async($,on)=>{
  const {w}=setupResume(on)
  w.states={flo_old:'failed'}
  w.head=initialEvent==='started'?JSON.stringify({t:1,type:'run',state:'started',workflowFile:'/w.mjs'}):JSON.stringify({t:1,type:'run',runId:'flo_old',state:'failed',error:'workflow module failed to load: transient network failure'})
  await $.command.run(flo('flo_old'));const ui=await $.ui.mount(PANE('terminal'))
  await ui.press({key:'resume'});await ui.press({key:'resume-yes'})
  expect(w.calls.filter(a=>a[1]==='run'||a[1]==='resume')).toHaveLength(1)
  await ui.unmount()
})

// (astra-r3)
test('A9: real CLI failed pre-start run with readable journal meta offers a resume that cannot launch',async($,on)=>{
  const {w}=setupResume(on);w.states={flo_prestart:'failed'};w.rawStatuses={flo_prestart:statuses.flo_prestart};w.head=prestartEvent;w.events=prestartEvent
  await $.command.run(flo('flo_prestart'));const ui=await $.ui.mount(PANE('terminal'))
  await ui.press({key:'resume'});await ui.press({key:'resume-yes'})
  expect(w.toasts.some(t=>t.includes('its first event names no workflow file'))).toBe(false)
  await ui.unmount()
})

// (astra-r7)
for(const surface of ['terminal','desktop'] as const)for(const inThread of [false,true])test(`A19 auto-attachment resets navigation, surface=${surface}, inThread=${inThread}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'running',flo_b:'running'};w.agents=[{index:0,label:'Writer',state:'running'}];w.transcript=jsonl([{kind:'text',text:'old run transcript'}])
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE(surface))
 if(inThread){if(surface==='terminal')await ui.press({key:'agent:0'});else{await ui.pointer({in:'agentcard:0',type:'down',x:1,y:0,button:'left'});await ui.pointer({in:'agentcard:0',type:'up',x:1,y:0,button:'left'})}}
 w.output='started detached run flo_b';w.agents=[];w.transcript=''
 await $.tool.call({tool:'Bash',command:'flowition run b.mjs --detach'})
 // A new launch should open the new run's view, not agent 0 inherited from run A.
 if(surface==='terminal')await ui.press({key:'refresh'});else{await ui.pointer({in:'refresh',type:'down',x:1,y:0,button:'left'});await ui.pointer({in:'refresh',type:'up',x:1,y:0,button:'left'})}
 expect(await ui.find({key:'tab:agents'})).toBeDefined()
 await ui.unmount()
})

// (astra-r7)
for(const switchRun of [false,true])test(`An answer submitted for A cannot land in B, switchRun=${switchRun}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'running',flo_b:'running'};w.questions=[{qid:'q0',question:'Proceed?',t:1000}]
 const gate=deferred(),entered=deferred()
 on('ui.input',async($,e,next)=>{if(e.kind==='submit'){entered.resolve();await gate.promise};return next(e)})
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'))
 const input=ui.input({key:'answer:q0:0:flo_a:1000',text:'Answer intended for A'})
 await entered.promise
 if(switchRun){await $.command.run(flo('flo_b'));await ui.redraw()}
 gate.resolve();await input.catch(err=>{if(!switchRun)throw err})
 const answers=w.calls.filter(a=>a[1]==='answer')
 expect(answers).toHaveLength(switchRun?0:1)
 if(!switchRun)expect(answers[0]?.[2]).toBe('flo_a')
 await ui.unmount()
})

// (astra-r14)
for(const overlap of [false,true])test(`A23 Enter with argument change pending overlap=${overlap}`,async($,on)=>{
 const {w,clock}=setup(on);w.states={};w.workflows=[{name:'w.mjs',kind:'file',size:10,mtimeMs:1}]
 const gate=deferred(),entered=deferred();let armed=overlap
 on('state.set',{plugin:'flowition-cockpit',key:'launch'},async($,e,next)=>{
  if(armed&&e.value?.args==='{"target":"staging"}'){armed=false;entered.resolve();await gate.promise}
  return next(e)
 })
 await $.command.run(flo(''));const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'new'});await ui.press({key:'wf-pick:/home/t/.flowition/workflows/w.mjs'})
 const edit=ui.input({key:'launch-args:/home/t/.flowition/workflows/w.mjs:0',text:'{"target":"staging"}',kind:'change'})
 if(overlap)await entered.promise;else await edit
 w.launchEntered=deferred()
 const submit=ui.input({key:'launch-args:/home/t/.flowition/workflows/w.mjs:0',text:'{"target":"staging"}',kind:'submit'})
 await clock.settle()
 gate.resolve();await edit;await submit
 const calls=w.calls.filter(a=>a[1]==='run')
 expect(calls).toHaveLength(1)
 expect(calls[0]).toContain('--args')
 expect(calls[0]).toContain('{"target":"staging"}')
 await ui.unmount()
})

// (astra-r17)
// Every external operation is mocked. No workflow or Bash command is actually started.
for(const surface of ['terminal','desktop'] as const)for(const changed of [false,true])test(`A24 launch confirmation after cwd change surface=${surface} changed=${changed}`,async($,on)=>{
 const {w}=setup(on);w.states={};w.workflows=[{name:'w.mjs',kind:'file',mtimeMs:1,size:1,isLink:false}];
 await $.session.start({cwd:w.cwd,surface,isInteractive:true});const ui=await $.ui.mount(PANE(surface));
 const press=async(key:string)=>{if(surface==='terminal')await ui.press({key});else{await ui.pointer({in:key,type:'down',x:1,y:0,button:'left'});await ui.pointer({in:key,type:'up',x:1,y:0,button:'left'});}};
 await press('new');await press('launch-close');
 // A normal foreground Bash cd changes the session cwd; process.run's default follows it.
 if(changed){w.bashAction=()=>{w.cwd='/home/t/project-b'};await $.tool.call({tool:'Bash',command:'cd /home/t/project-b'});w.bashAction=null;}
 await press('new');await press(surface==='terminal'?'wf-pick:/home/t/.flowition/workflows/w.mjs':'wf:/home/t/.flowition/workflows/w.mjs');
 const confirmation=(await ui.find({text:/Its agents run with full permissions/}))?.text??'';
 await press('launch-start');
 expect(w.launchCwds).toEqual([changed?'/home/t/project-b':'/home/t/project-a']);
 expect(confirmation).toContain(w.launchCwds[0]!);
 await ui.unmount();
});

// (astra-r18)
// No real tool/process/fs operation is dispatched by these tests.
for(const surface of ['terminal','desktop'] as const)for(const changed of [false,true])test(`A24 folder changes with form already open, ${surface}, changed=${changed}`,async($,on)=>{
 const {w}=setup(on);w.states={};w.workflows=[{name:'w.mjs',kind:'file',mtimeMs:1,size:1,isLink:false}];
 await $.session.start({cwd:w.cwd,surface,isInteractive:true});const ui=await $.ui.mount(PANE(surface));
 const press=async(key:string)=>{if(surface==='terminal')await ui.press({key});else{await ui.pointer({in:key,type:'down',x:1,y:0,button:'left'});await ui.pointer({in:key,type:'up',x:1,y:0,button:'left'});}};
 await press('new');await press(surface==='terminal'?'wf-pick:/home/t/.flowition/workflows/w.mjs':'wf:/home/t/.flowition/workflows/w.mjs');
 const confirmation=(await ui.find({text:/Its agents run with full permissions/}))?.text??'';
 if(changed){w.bashAction=()=>{w.cwd='/home/t/project-b'};await $.tool.call({tool:'Bash',command:'cd /home/t/project-b'});w.bashAction=null;}
 await press('launch-start');
 expect(w.launchCwds).toEqual(['/home/t/project-a']);expect(confirmation).toContain('/home/t/project-a');await ui.unmount();
});

// (astra-r18)
test('A24 pwd refusal uses the explicit session-folder fallback',async($,on)=>{
 const {w}=setup(on);w.states={};w.workflows=[{name:'w.mjs',kind:'file',mtimeMs:1,size:1,isLink:false}];w.cwd='DENIED';
 await $.session.start({cwd:'/home/t',surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));await ui.press({key:'new'});await ui.press({key:'wf-pick:/home/t/.flowition/workflows/w.mjs'});
 expect((await ui.find({text:/Its agents run with full permissions/}))?.text??'').toContain('this session’s folder');
 w.cwd='/home/t/project-b';await ui.press({key:'launch-start'});expect(w.launchCwds).toEqual(['/home/t/project-b']);expect(w.calls.find(a=>a[1]==='run')?.includes('--cwd')).toBe(false);await ui.unmount();
});

// (astra-r18)
for(const error of [false,true])test(`No controls run just because render runs, errors=${error}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:error?'failed':'running'};w.questions=[{qid:'q0',t:5000,question:'Approve deployment?'}];
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('desktop'));w.calls=[];
 for(let i=0;i<5;i++)await ui.redraw();
 expect(w.calls.filter(a=>['answer','send','cancel','run','rm'].includes(a[1]??''))).toHaveLength(0);await ui.unmount();
});

// (astra-r18)
// The testing kit drives input handlers, but not the terminal's typed-text store.
// Use that store's actual extracted functions to carry a draft through the real
// plugin's drawings, then submit exactly what the terminal would submit.
// A25 (draft answers crossing runs): the terminal keeps a typed draft per field key, so the
// answer field's key is its run's and its question event's. (Astra reproduced the carry-over
// with the terminal's own field-buffer code; that is not copied here.)
for(const switchRun of [false,true])test(`A25 an answer field is its run's and question's, switchRun=${switchRun}`,async($,on)=>{
 const {w}=setup(on);w.states={flo_a:'running',flo_b:'running'};w.questions=[{qid:'q0',t:1000,question:'Approve staging?'}];
 await $.command.run(flo('flo_a'));const ui=await $.ui.mount(PANE('terminal'));
 const key=async()=>(await ui.findAll({type:'Input'})).find(x=>x.key?.startsWith('answer:'))?.key;
 const before=await key();
 await ui.input({key:before!,text:'Yes, staging only',kind:'change'});
 if(switchRun){w.output='started detached run flo_b';w.questions=[{qid:'q0',t:2000,question:'Approve production?'}];await $.tool.call({tool:'Bash',command:'flowition run production.mjs --detach'});await ui.press({key:'refresh'})}
 const after=await key();
 expect([before?.includes(':flo_a:'),after!==before]).toEqual([true,switchRun]);
 if(switchRun)expect(after?.includes(':flo_b:')).toBe(true);
 await ui.unmount();
});

// (astra-r19)
// A26: the args field is bound to the form's args, so what it shows is what Start and Enter
// launch with, after switching workflows and back or reopening the form. (Astra reproduced the
// mismatch with the terminal's own field buffer; that code is not copied here: the field's value
// is the property the terminal draws from.)
for(const mode of ['unchanged','switch-back','reopen'] as const)for(const submit of ['enter','button'] as const)test(`A26 the args field shows what launches: ${mode}, ${submit}`,async($,on)=>{
 const {w}=setup(on);w.states={};w.workflows=['deploy.mjs','other.mjs'].map(name=>({name,kind:'file',mtimeMs:1,size:1,isLink:false}));
 await $.session.start({cwd:w.cwd,surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));
 const press=(key:string)=>ui.press({key});const pick=(name:string)=>press(`wf-pick:/home/t/.flowition/workflows/${name}`);
 await press('new');await pick('deploy.mjs');
 const field=async()=>(await ui.findAll({type:'Input'})).find(f=>f.key?.startsWith('launch-args:'))!;
 const draft='{"environment":"staging","dryRun":true}';
 await ui.input({key:(await field()).key!,text:draft,kind:'change'});
 if(mode==='switch-back'){await pick('other.mjs');await pick('deploy.mjs')}
 if(mode==='reopen'){await press('launch-close');await press('new');await pick('deploy.mjs')}
 const shown=String((await field()).props.value??'');
 w.calls=[];
 if(submit==='enter')await ui.input({key:(await field()).key!,text:shown});else await press('launch-start');
 const call=w.calls.find(a=>a[1]==='run')!;
 const sent=call.includes('--args')?call[call.indexOf('--args')+1]:'';
 expect({mode,shown,sent}).toEqual({mode,shown:mode==='unchanged'?draft:'',sent:mode==='unchanged'?draft:''});
 await ui.unmount();
});

// (astra-r20)
// A26 (error path): a launch that fails draws the args field afresh (a new key) with the
// args the form still holds, so a surface that cleared the field on submit shows them, and a
// retry launches exactly what is shown. (Astra reproduced the clearing with the terminal's own
// field buffer; that code is not copied here.)
for(const failure of ['cli','invalid-json'] as const)for(const retry of ['enter','button'] as const)test(`A26 a failed launch keeps the field and the retry consistent: ${failure}, retry=${retry}`,async($,on)=>{
 const {w}=setup(on);w.states={};w.workflows=['deploy.mjs'].map(name=>({name,kind:'file',mtimeMs:1,size:1,isLink:false}));
 await $.session.start({cwd:w.cwd,surface:'terminal',isInteractive:true});const ui=await $.ui.mount(PANE('terminal'));
 await ui.press({key:'new'});await ui.press({key:'wf-pick:/home/t/.flowition/workflows/deploy.mjs'});
 const field=async()=>(await ui.findAll({type:'Input'})).find(f=>f.key?.startsWith('launch-args:'))!;
 const args=failure==='cli'?'{"environment":"staging"}':'{"environment":';
 if(failure==='cli')w.failStarts=1;
 const first=await field();
 await ui.input({key:first.key!,text:args,kind:'change'});
 await ui.input({key:first.key!,text:args});
 const after=await field();
 // Drawn afresh, showing the args the form holds.
 expect([after.key!==first.key,after.props.value]).toEqual([true,args]);
 if(failure==='invalid-json')return void (await ui.unmount());
 w.calls=[];
 if(retry==='enter')await ui.input({key:after.key!,text:String(after.props.value)});else await ui.press({key:'launch-start'});
 const call=w.calls.find(a=>a[1]==='run')!;
 expect(call[call.indexOf('--args')+1]).toBe(args);
 await ui.unmount();
});

// Resume and Replay start once: a second confirmation, or one pressed while the first
// still reads the run's metadata, starts nothing more, and the pane says it is starting.
for (const surface of ['terminal', 'desktop'] as const) for (const state of ['failed', 'completed']) test(`Resume/Replay starts once: ${surface}/${state}`, async ($, on) => {
  const { w } = setup(on)
  w.states = { flo_a: state }
  await $.session.start({ cwd: '/home/t', surface, isInteractive: true })
  await $.command.run(flo('flo_a'))
  const ui = await $.ui.mount(PANE(surface))
  const press = async (key: string) => {
    if (surface === 'terminal') return ui.press({ key })
    await ui.pointer({ in: key, type: 'down', x: 1, y: 0, button: 'left' })
    await ui.pointer({ in: key, type: 'up', x: 1, y: 0, button: 'left' })
  }
  await press('resume')
  w.headGate = deferred()
  w.headEntered = deferred()
  const gate = w.headGate
  const first = press('resume-yes')
  const second = press('resume-yes').catch(() => undefined)
  await w.headEntered.promise
  await ui.redraw()
  expect(await ui.find({ text: state === 'completed' ? 'Replaying…' : 'Resuming…' })).toBeDefined()
  expect(await ui.find({ key: 'resume' })).toBeUndefined()
  w.launchEntered = deferred()
  gate.resolve()
  await Promise.all([first, second, w.launchEntered.promise])
  await ui.redraw()
  expect(w.calls.filter((a) => a[1] === 'run' && a.includes('--resume'))).toHaveLength(1)
  await ui.unmount()
})
