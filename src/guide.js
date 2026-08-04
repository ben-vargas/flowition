export const GUIDE = `# flowition workflow authoring guide

A workflow is a plain-JS ES module:

    export const meta = {
      name: 'review-changes',
      description: 'Review changed files, verify findings',
      phases: [{ title: 'Review' }, { title: 'Verify' }],
      argsSchema: {          // optional input contract for --args (same JSON
        type: 'object',      // Schema subset as agent output schemas); invalid
        properties: { target: { type: 'string' } },  // args fail the run BEFORE
        required: ['target'],                        // any agent or step starts
        additionalProperties: false,
      },
    }

    export default async function ({ agent, spawn, step, parallel, pipeline, phase, log, ask, sendTo, args, budget, now, random }) {
      phase('Review')
      const findings = await parallel(AREAS.map((a) => () =>
        agent('Review ' + a + ' for bugs.', { schema: FINDINGS, label: 'review:' + a })))
      phase('Verify')
      const verified = await pipeline(
        findings.filter(Boolean).flatMap((f) => f.items),
        (f) => agent('Adversarially verify: ' + f.title, { schema: VERDICT }),
      )
      return { verified }
    }

## Toolkit

agent(prompt, opts) -> Promise<string | object>
  Spawns a real CLI agent. Returns final text, or the validated object when opts.schema
  (a JSON Schema) is set. opts:
    adapter   'claude' | 'codex' | 'amp' | 'droid' | 'opencode' | 'pi' | 'mock'
              (default: the run's --adapter)
    model     model id for that CLI. amp has no model flag: for amp, model (or mode)
              selects an *agent mode* — builtin low/medium/high/ultra or any custom
              mode installed in ~/.config/amp/plugins, matched by key or label
              (e.g. 'claude-fable-xhi' or 'Claude Fable xhi'). \`flowition doctor\` lists them.
    mode      amp only — explicit agent-mode selector (alias of model for amp)
    effort    'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max' — mapped per adapter
              (on amp, effort picks a builtin mode unless model/mode is given)
    system    system prompt: a native flag on claude/droid/pi (--append-system-prompt);
              amp/codex/opencode have no such flag, so flowition prepends it to the first
              turn of a fresh session as a delimited [system instructions]/[task]
              preamble (session-resume follow-up turns already carry it)
    schema    JSON Schema forced on the final answer (native on claude/codex, prompt-
              contract + validation + one corrective turn elsewhere). The built-in
              validator implements ONLY: type (incl. type arrays), required,
              properties, additionalProperties (boolean), items (single schema),
              enum, const, minimum, maximum, minLength, maxLength, minItems,
              maxItems, anyOf — plus inert annotations (title, description,
              default, examples, $comment, $schema, $id). Any other keyword
              (pattern, oneOf, multipleOf, format, …) is REJECTED loudly at
              validation time, at any nesting depth — never silently ignored.
              Caution: codex
              enforces OpenAI's strict subset — every property must appear in
              'required'; express optional fields as nullable, e.g. {type:['string','null']}
    cwd       working directory for the agent
    label     display label (also addressable by \`flowition send <run> <label>\`)
    key       explicit resume-cache key (must be unique per run)
  A directly-awaited failed agent throws; inside parallel()/pipeline() a failure
  degrades that item to null (filter with .filter(Boolean)).

spawn(prompt, opts) -> { done: Promise, send(msg) }
  Like agent() but returns immediately with a steerable handle. send() live-injects
  into claude/amp mid-run; for codex/droid/opencode/pi it queues and is delivered as
  a session-resume follow-up turn after the current turn ends.
  Delivery is deliver-or-declare: if the provider session cannot take a follow-up
  turn, queued messages are terminally declared undeliverable (journaled done +
  transcript drop notice) instead of delivered; live-injected messages are only
  marked delivered when the carrying turn completes.
  send()/sendTo() return a SEND-TIME verdict — branch on it:
    'live'      injected into the running process now
    'queued'    accepted; will be delivered via the next follow-up turn
    'replayed'  resume re-send absorbed idempotently — the session already has it
    'dropped'   refused at send time: the agent had already settled (or the spawn
                handle's agent replayed from cache) — nothing was accepted
    'pending'   accepted by a spawn handle before the agent was admitted
    false       sendTo() target is not live (no agent at that index/label)
  The verdict is about acceptance, not final fate: a send accepted as 'queued'
  can still prove undeliverable later (no resumable session for a follow-up
  turn) — it is then DECLARED dropped at the final drain (journaled mail-done
  dropped:true + a transcript notice), it does not retroactively re-report.

step(name, args?, fn) -> Promise<JSON>
  Durable local code (side effects, git commands, file writes). A completed
  callback's JSON result is journaled and REPLAYED on resume instead of
  re-executing; incomplete or failed attempts re-run.
  name + canonicalized args form the resume identity — changed args = a different
  step. Steps use their own per-branch counter, so adding/removing one never shifts
  agent resume keys. Args and result must be plain JSON (undefined/functions/NaN/
  BigInt/cycles are rejected loudly); a void callback resolves to null.
  Guarantee: durable memoization, NOT exactly-once — a crash between the callback's
  external effect and its completion record re-runs it on resume, so make callbacks
  idempotent (or carry an idempotency key in args). A FAILED step re-runs on resume
  like any unfinished work; its error propagates to your code unchanged.

parallel(thunks) -> Promise<any[]>     BARRIER: all results together; failures -> null.
pipeline(items, ...stages)             NO barrier between stages; each stage gets
                                       (prev, originalItem, index); prefer this.
phase(title) / log(msg)                progress structure for status/tail.
ask(question, {id?}) -> Promise<string>
  Blocks the workflow on operator input. Shown by \`flowition status\`; answered with
  \`flowition answer <runId> <qid> "<text>"\`. Answers are journaled and replay on resume.
sendTo(indexOrLabel, msg)              steer one of your own live agents from workflow code.
args                                   the --args JSON, verbatim.
budget                                 { total, spent(), remaining() } output-token ceiling (--budget).
                                       Advisory: checked before each agent is admitted, so one
                                       in-flight agent can overshoot. Persisted; restored on resume.
now() / random()                       deterministic; use instead of Date.now()/Math.random().

## Rules
- Never use Date.now()/Math.random() in workflow code — they break resume replay; use now()/random().
- Wrap side effects (git, file writes, network calls) in step() so resume replays them
  instead of re-executing; keep the callbacks idempotent.
- Prefer pipeline() over parallel(); use a barrier only when a stage needs ALL prior results.
- Every agent runs with full permissions (no sandbox) — write prompts accordingly.
- Agents you spawn get FLOWITION_RUN_ID / FLOWITION_AGENT_INDEX / FLOWITION_BIN env vars and may
  report progress upward with: flowition post "message".

## Running
  flowition run flow.workflow.js --args '{"target":"src/"}' --adapter codex --model gpt-5.2
  flowition run flow.workflow.js --detach     # background; then: flowition status/tail/result
  flowition resume <runId>                    # replay completed agents from the journal;
                                         # interrupted agents CONTINUE their provider
                                         # session (claude/codex/amp/droid/opencode/pi)
  flowition status <runId> / flowition tail <runId> [-f] [--agent N]
  flowition send <runId> <agent> "msg" / flowition cancel <runId> [--agent N]
`
