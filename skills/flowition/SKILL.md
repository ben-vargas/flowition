---
name: flowition
description: Author and run deterministic multi-CLI agent workflows with the `flowition` CLI (short alias `flo`) — plain-JS files that orchestrate real coding-agent CLIs (claude, codex, amp, droid, opencode, pi, cursor, grok) via agent()/spawn()/parallel()/pipeline(). Use when a task is big enough to decompose and run in parallel, when you want independent perspectives or adversarial verification before committing, when the work is too large for one context (broad audits, migrations, multi-source research, exhaustive reviews), or when you want a cross-model panel — different CLIs and model families on the same question. Covers the file shape, the toolkit, adapters and models, structured output, determinism, resume, mid-run steering, the browser viewer (with tailnet links), and every CLI command.
metadata:
  type: reference
---

# flowition

> This copy is distributed via ~/.ai-skills and may lag the installed flowition package. If authoring details seem off, run `flowition guide`; the installed `index.d.ts` and implementation are decisive on exact types and behavior.

Run a workflow file that orchestrates multiple agents deterministically. `flowition run <file.workflow.js>` executes the file; runs persist to `~/.flowition/runs/<id>/` and print a runId. Each uncached `agent()` call runs a real CLI agent — **claude, codex, amp, droid, opencode, pi, cursor, or grok** — and you pick the adapter per call; `mock` is the deterministic in-process test adapter. The engine exposes schemas, steering, resume, transcripts, and budgets consistently while each adapter supplies the capabilities listed below. The CLI installs as `flowition` with `flo` as a short alias; requires Node >= 18.17 and zero runtime dependencies (each real adapter you use needs its CLI installed and authenticated — `flowition doctor` reports which executables are found).

A workflow structures work across many agents — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before committing), to take on scale one context can't hold (migrations, audits, broad sweeps), or to get decorrelated errors (the same question put to two model families). When you write one, the right move is often **hybrid**: scout first (list the files, scope the diff) to discover the work-list, then write a workflow to pipeline over it.

## The workflow file

A workflow is a plain ES module — no source transform, no vm. It exports `meta` and a default async function that receives the toolkit:

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files, verify findings',
  phases: [{ title: 'Review' }, { title: 'Verify' }],   // optional, documentation only
}

export default async function ({ agent, spawn, step, parallel, pipeline, phase, log,
                                 ask, sendTo, args, budget, meta, now, random }) {
  phase('Review')
  const findings = await parallel(AREAS.map((a) => () =>
    agent(`Review ${a} for bugs.`, { schema: FINDINGS, label: `review:${a}` })))
  phase('Verify')
  return pipeline(
    findings.filter((f) => f !== null).flatMap((f) => f.items),
    (f) => agent(`Adversarially verify: ${f.title}`, { schema: VERDICT }),
  )
}
```

`meta.name` and `meta.description` are required by the TypeScript authoring contract (the runtime accepts absent metadata). `meta.phases` is an outline — execution ignores it and the `flowition status` phase list comes from the `phase()` calls the workflow actually makes, but the viewer uses it to order phases and show declared-but-unreached ones, matched to observed phases by index — declare them in first-entered order or the viewer mislabels. `meta.argsSchema` (optional) is an input contract for `--args`, using the same JSON Schema subset as agent output schemas: the effective args are validated before any agent or step executes — fresh runs and resumes alike — and a violation fails the run with the schema paths that missed. No defaults are merged; the toolkit's `args` stays verbatim.

Two file-level gotchas that waste real time:
- **Workflow files are ES modules.** Node decides how to parse a `.js` file from the nearest package.json — it needs `"type": "module"`, or name the file `.mjs`, or the workflow fails to load.
- **`node --check file.workflow.js` before launching.** An unescaped backtick inside a template-literal prompt is a real and easy failure; catch it in one second instead of after a spawn.

## Where the workflow file lives (durability and organization)

A workflow file is pure input — every run's own record (journal, events, transcripts,
result) always lands in `$FLOWITION_HOME/runs/<runId>/` no matter where the file came
from. But the file stays load-bearing after launch: `flowition resume` re-executes it and
refuses unless the file and its local imports are byte-identical, and the journal stores
the file's hash, not its source. A workflow authored in an OS temp dir or session
scratchpad therefore costs you two things when that dir is cleaned: any interrupted run
becomes unresumable, and the program text that produced a recorded run is gone.

- **Author durable workflows in `~/.flowition/workflows/<project>/`**, where `<project>`
  is the basename of the directory the run targets (its `--cwd`): workflows operating on
  `~/work/api-server` live in `~/.flowition/workflows/api-server/`. A workflow that is
  project tooling worth versioning and sharing belongs in the target repo instead — the
  same rules below still apply to it.
- **Name by purpose; iterate by NEW FILE, never by edit**: `<purpose>.workflow.mjs`,
  then `<purpose>-r2.workflow.mjs`, `-r3`, … Resume refuses a changed hash by design, so
  editing a file that has a run you might still resume strands that run. Leave prior
  revisions in place until their runs are terminal and will never be resumed.
- **Always `.mjs` under `~/.flowition/workflows/`** — there is no package.json there, so
  a `.js` file parses as CommonJS and fails to load.
- **Side files read at module load** (findings lists, args files) live next to the
  workflow and follow the same immutability rule. Their content is not hash-checked, but
  it typically feeds prompts, and prompts feed resume keys — changing one silently turns
  a replay into a re-run.
- Truly disposable one-shots may live anywhere, accepting that they are unresumable and
  unrecoverable once their directory is cleaned.

## The toolkit

- **agent(prompt, opts?) → Promise<string | JSONValue>** — run an agent via the selected adapter; resolves to its final text, or the validated JSON value when `opts.schema` is set. opts: `adapter` (`'claude' | 'codex' | 'amp' | 'droid' | 'opencode' | 'pi' | 'cursor' | 'grok' | 'mock'`, default: the run's `--adapter`), `model` (model id for that CLI; on amp it selects an agent *mode* — see Adapters), `mode` (amp-only alias of model), `effort` (`'none'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max'`, mapped per adapter; grok maps onto `--reasoning-effort` `low|medium|high|xhigh` and omitted effort defaults to `high`; cursor REJECTS effort — see Adapters), `system` (system prompt: native flag on claude/droid/pi/grok; amp/codex/opencode/cursor get it prepended to the first turn of a fresh session), `schema` (JSON Schema forced on the final answer), `cwd`, `label` (display label, also a `sendTo()`/`flowition send` target — keep labels UNIQUE among live agents: duplicates overwrite the steering map, and purely numeric labels lose to agent-index lookup), `phase` (assign this agent to a named phase group, overriding the ambient `phase()` — use inside `parallel()`/`pipeline()` stages, where the ambient phase can lag; observational only, never part of the resume key), `key` (explicit resume-cache key, unique per run), `stallMs` (kill the current turn after this long with no provider output; default 30 minutes). A directly-awaited failed agent throws; inside `parallel()`/`pipeline()` an agent-process failure degrades that item to `null` while workflow errors and other exceptions still reject.
- **spawn(prompt, opts?) → { done, send(msg) }** — `agent()` returning immediately with a steerable handle. `done` is the final-result promise; `send()` live-injects into claude/amp/mock mid-turn, and queues a session-resume follow-up turn for codex/droid/opencode/pi/cursor/grok. See Mid-run communication for the send verdicts.
- **parallel(thunks) → Promise<Array<thunk result | null>>** — run thunks concurrently. This is a BARRIER on the success path: all thunks are awaited, and agent failures become `null` in their original positions; `.filter((x) => x !== null)` before using the results — not `.filter(Boolean)`, since a schema may legitimately return `false`, `0`, or `""`. Workflow errors and non-agent exceptions reject IMMEDIATELY (`Promise.all`) — if you catch that rejection, sibling thunks are still running. Pass **thunks** (`() => agent(...)`), never already-started promises. At most 4096 thunks.
- **pipeline(items, ...stages) → Promise<Array<last-stage result | null>>** — run each item through all stages independently, NO barrier between stages; with no stages it returns `Promise<Item[]>`. Every stage callback receives `(prev, originalItem, index)` — use originalItem/index in later stages to label work without threading context through stage 1's return value. An agent failure or an intentional `null` drops that item to `null` and skips its remaining stages; workflow errors and non-agent exceptions reject. At most 4096 items.
- **step(name, args?, fn) → Promise<JSONValue>** — durable local code (git commands, file writes, API calls). A completed callback's JSON result is journaled and REPLAYED on resume instead of re-executing; incomplete or failed attempts re-run. `name` + canonicalized `args` form the resume identity — changed args = a different step — and steps use their own per-branch counter, so adding/removing one never shifts agent resume keys. Args and result must be plain JSON (`undefined`/functions/`NaN`/`BigInt`/cycles are rejected loudly); a void callback resolves to `null`. The guarantee is durable memoization, NOT exactly-once: a crash between the callback's external effect and its completion record re-runs it on resume — make callbacks idempotent (or carry an idempotency key in args). A FAILED step re-runs on resume; its error propagates to your code unchanged. At most 10000 `step()` calls per execution attempt (replayed calls count; the counter resets on resume).
- **phase(title) / log(message) → void** — progress structure; phases show in `flowition status` and both appear in `flowition tail`.
- **ask(question, opts?) → Promise<string>** — block the workflow on operator input; `opts` is `{ id?: string }`. Unanswered questions show in `flowition status`; answer with `flowition answer <runId> <qid> "<text>"` (generated ids are q0, q1, … on the root branch and gain a branch suffix under fan-out; explicit ids must be unique per run). Answers are journaled and replay on resume.
- **sendTo(indexOrLabel, message) → Exclude<SendVerdict, 'pending'> | false** — steer one of your own live agents from workflow code; returns `false` when no live agent matches.
- **args** — the `--args '<json>'` / `--args-file <f>` value, verbatim (undefined if not provided). Use to parameterize a workflow.
- **budget** — `{ total, spent(), remaining() }`, the `--budget N` output-token ceiling. **Advisory, not a hard wall**: admission checks *settled* spend only, so everything concurrently in flight can admit against the same stale total and collectively overshoot; `spent()`/`remaining()` likewise lag in-flight usage. `total` is null / `remaining()` is Infinity with no ceiling — guard loops on `budget.total`. Spend (including failed and cancelled agents) is journaled and restored on resume.
- **meta** — the workflow module's exported `meta` object, or `{}` when none was exported.
- **now() / random()** — journal-seeded deterministic time/RNG; use instead of `Date.now()`/`Math.random()` (which break resume). Note `now()` is replay-stable but not a wall clock — within one branch, differences between two values count calls, not elapsed milliseconds.

An agent's final text is the return value. For structured output, use `schema` — validation happens engine-side and, when a resumable session id is available, one corrective follow-up turn is attempted on a mismatch.

Concurrent agents are capped at 8 per run by default (override with `--concurrency N`) — excess calls queue and run as slots free. A single run/resume engine invocation accepts at most 1000 `agent()` calls, a runaway-loop backstop.

## pipeline() vs parallel()

DEFAULT TO pipeline(). Only reach for a barrier (parallel between stages) when you genuinely need ALL prior-stage results together. With pipeline, item A can be in stage 3 while item B is still in stage 1, avoiding a stage-wide wait.

A barrier is correct ONLY when stage N needs cross-item context from all of stage N−1:
- Dedup/merge across the full result set before expensive downstream work
- Early-exit if the total count is zero ("0 bugs found → skip verification entirely")
- Stage N's prompt references "the other findings" for comparison

A barrier is NOT justified by:
- "I need to flatten/map/filter first" — do it inside a pipeline stage: `pipeline(items, stageA, r => transform(r), stageB)`
- "The stages are conceptually separate" — that's what pipeline() models. Separate stages ≠ synchronized stages.
- "It's cleaner code" — barrier latency is real. If 5 finders run and the slowest takes 3× the fastest, a barrier wastes 2/3 of the fast finders' idle time.

Smell test: if you wrote `const a = await parallel(...)`, then a plain transform of `a` with no cross-item dependency, then another `parallel(...)` over the result — that middle transform doesn't need the barrier. Rewrite as a pipeline with the transform inside a stage. When in doubt: pipeline.

## Adapters and models

Every `agent()` runs under an adapter. Omit `adapter` to inherit the run's `--adapter` (default `claude`); set it per call when you want a specific CLI — a cross-model verify pass, a panel of different model families, or a step that plays to one CLI's strengths. `model` is the model id for that CLI (e.g. `{ adapter: 'codex', model: 'gpt-5.2' }`); omit it for the CLI's own default.

| adapter  | steering | resume vehicle                | schema mode |
|----------|----------|-------------------------------|-------------|
| claude   | live     | `claude -p --resume <sid>`    | native      |
| amp      | live     | `amp threads continue <id>`   | prompt      |
| codex    | turn     | `codex exec resume <tid>`     | native-file |
| droid    | turn     | `droid exec -s <sid>`         | prompt      |
| opencode | turn     | `opencode run --session <id>` | prompt      |
| pi       | turn     | `pi --session-id <uuid>`      | prompt      |
| cursor   | turn     | `cursor-agent -p --resume <sid>` | prompt   |
| grok     | turn     | `grok --resume <sid>`         | native      |
| mock     | live     | in-process test session       | prompt      |

**The amp quirk: amp selects agent MODES, not models.** A mode bundles model + prompt + tools. On amp, `model` (or its alias `mode`) resolves against the builtin modes — low/medium/high/ultra — and any custom modes installed as amp plugins in `~/.config/amp/plugins`, matched by key or label (e.g. `'claude-fable-xhi'` or `'Claude Fable xhi'`). `effort` picks a builtin mode unless model/mode is given. `flowition doctor` lists what's discovered.

**The cursor quirk: effort lives in the model id.** cursor has no effort flag — reasoning effort is encoded into the model id itself (`gpt-5.6-sol-xhigh`, `gpt-5.4-mini-medium`, or bracket overrides like `claude-opus-4-8[effort=high]`), so `effort` on a cursor agent is rejected at `agent()` time; pick a model id that carries the effort you want (`cursor-agent --list-models` lists them).

**The grok quirk: `--reasoning-effort` is a closed set.** grok is the Grok Build CLI (binary `grok`; `grok models` lists model ids, `grok login` authenticates). grok 1.0.3 accepts only `low|medium|high|xhigh`: flowition maps `none`/`minimal` → `low` and `max` → `xhigh`, and omitted effort always passes `--reasoning-effort high` (grok's own default). `system` rides grok's native `--rules`, which appends to grok's system prompt rather than replacing it.

**The pi quirk: always provider-qualify the model.** pi's `--model` is a *pattern* matched against a multi-provider catalog — a bare id can be ambiguous (`gpt-*` ids exist under both `openai-codex` and `opencode`) or miss entirely, failing the agent at spawn and the workflow with it. Always write `provider/id`: `{ adapter: 'pi', model: 'anthropic/claude-fable-5' }`, `'anthropic/claude-opus-5'`, `'openai-codex/gpt-5.6-sol'`. `pi --list-models` prints the catalog.

**Every real CLI agent runs with FULL PERMISSIONS and no sandboxing** — flowition invokes each CLI with its most permissive flags. Agents can read, write, and execute anything the invoking user can. Write prompts accordingly, and only run workflows whose prompts you trust. Agent execution is also at-least-once, like `step()`: a retryable stall re-runs the agent once automatically, and resume nudges an interrupted agent to redo interrupted work — prompt side-effecting agents for idempotency.

## Structured output

`schema` uses the CLI's native mechanism where one exists (claude and grok `--json-schema`, codex `--output-schema`) and a prompt contract plus loose JSON parsing elsewhere. All modes re-validate engine-side; when a resumable session id is available, a failure triggers one corrective follow-up turn before the agent fails with `schema_invalid`. The schema may describe any JSON root type, not only an object.

The built-in validator implements ONLY this subset: `type` (incl. type arrays), `required`, `properties`, `additionalProperties` (boolean form), `items` (single schema), `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `minItems`, `maxItems`, `anyOf` — plus inert annotations (`title`, `description`, `default`, `examples`, `$comment`, `$schema`, `$id`). Any other keyword (`pattern`, `oneOf`, `multipleOf`, `format`, …) is REJECTED loudly at validation time, at any nesting depth — never silently ignored.

**Codex caveat:** OpenAI's strict mode requires every property to appear in `required` — express optional fields as nullable, e.g. `{ "type": ["string", "null"] }`. If a schema might run on codex, write it that way from the start.

## Determinism and resume

- Use the injected `now()` / `random()` instead of `Date.now()` / `Math.random()` — they are journal-seeded with per-branch substreams, so replay is stable.
- Pass **thunks** to `parallel()` — an already-started promise is rejected, after its work may already have escaped the branch's journal ordering.
- Every `agent()` call gets a chained positional resume key derived from its branch-local index, prompt, and keyed spec (`adapter`, `model`, `mode`, `effort`, `system`, `schema`, `cwd`), so replay is stable regardless of completion order; `key` overrides it when you need an explicit identity.

`flowition resume <runId>` replays completed agents and completed `step()` results from the journal instantly and re-runs the rest — and an interrupted agent whose provider session id was journaled **continues that session** with an "interrupted, finish the task" nudge rather than starting over. Undelivered steering mail is restored, `ask()` answers replay, and the budget ceiling is restored.

Resume refuses — loudly, rather than silently forking history — when:
- the workflow file **or any local-path import** (`./`, `../`, absolute, `file:`) changed — byte-for-byte hash of the module graph; bare package imports are treated as environment and NOT hashed, so a dependency update can change replayed logic without refusal,
- the args differ, or
- the workflow contains constructs the import scanner cannot follow statically (`eval`, `Function(`, computed dynamic imports/requires, or another scanner-conservative construct). Fresh runs are never affected by those constructs.

To iterate on an edited workflow, start a fresh run — resume recovers an interrupted run of the *same* file. `flowition resume` restores the journaled `--adapter`/`--model`/`--effort`/`--cwd`/`--args` and rejects overrides of them; its documented invocation options are `--concurrency`, `--budget`, and `--json`.

**Cross-run result seeding:** when you *edited* the workflow (so resume refuses), `flowition run <edited-file> --seed-from <oldRunId>` reuses the old run's completed agent results as a candidate cache — unchanged `agent()` calls replay instantly (derived keys don't hash the file), edited calls run fresh. Seeded hits cost zero budget, are written durably into the new run's journal (the old run can be deleted afterwards), and show as "seeded from run …" in status. Never seeded: `step()` results, explicit-`key` agents, `ask()` answers, sessions, steered results. The source must be a settled run (a failed run's completed agents seed fine); fresh runs only — it cannot combine with `--resume`. The match key is position (branch + call ordinal) plus prompt plus keyed spec — editing `label`/`phase`/`stallMs` still hits, reordering calls misses, and nothing pins args or world state, so a hit can reuse stale output when the environment changed underneath it; change the prompt or set `key` to force re-execution. The steered-result exclusion is source-side only: steering newly added in the edited workflow doesn't invalidate a hit — queued `spawn().send()` mail is dropped with a warning, and `sendTo()` just returns `false`. It's cache reuse, not resume: use it for research/pure-result agents, not agents whose correctness depends on side effects.

## Mid-run communication

From workflow code:
- `spawn()` gives you a handle mid-run: `h.send('focus on the auth module')`, then `await h.done`.
- `sendTo(indexOrLabel, msg)` steers any of your live agents by index or label.

`send()`/`sendTo()` return a SEND-TIME verdict — branch on it: `'live'` (injected into the running process now), `'queued'` (delivered as the next follow-up turn), `'replayed'` (resume re-send absorbed idempotently), or `'dropped'` (refused — the agent had already settled). A spawn handle's `send()` can additionally return `'pending'` before its agent is admitted; `sendTo()` instead returns `false` when no live agent matches. The verdict is about acceptance, not final fate: `'queued'` mail can still prove undeliverable later and is then declared dropped in the journal and transcript. `agent()`/`done` resolve only after every accepted message has been consumed or terminally declared dropped.

From the terminal (yours, or another agent's):
```sh
flowition send <runId> <agentIndexOrLabel> "narrow the scope to src/api"
flowition answer <runId> q0 "ship it"        # unblock a workflow ask()
flowition cancel <runId> --agent 3           # cancel one agent, not the run
```

Agents *inside* a run receive `FLOWITION_RUN_ID` / `FLOWITION_AGENT_INDEX` / `FLOWITION_BIN` and can report progress upward with `flowition post "message"` — tell them so in the prompt if you want progress reports.

## Viewer (how the user monitors a run)

`flowition viewer` serves a browser UI for this home's runs, loopback-only, and prints an authenticated URL. The `#` fragment is bootstrap-only (browsers never send it in requests), but the SPA then attaches the tokens to every API call — `Authorization` header, and the read token in the SSE query string — so a link is only as private as its transport (loopback, or the tailnet's WireGuard encryption). **When you launch a run for a user, hand back a clickable deep link — `<origin>/#/run/<runId>?t=<token>` — as the way to watch it; don't give them bash monitoring commands** (keep `status`/`tail` for your own programmatic checks). A foreground TTY run auto-starts a viewer and prints its deep link; detached/`--json`/`--quiet`/`--no-viewer`/MCP runs never do — get the base URL from `flowition viewer --print-url` (a live instance must exist) and substitute the `/run/<runId>` route. Read-only by default: send/answer/cancel/resume/delete return 403 unless the server was *started* with `--control[=send,answer,cancel,resume,delete]`; the control token exists only in that process. Viewer URLs are sensitive — the read token exposes every run's prompts, transcripts, and results; the control token steers full-permission agents.

**Tailnet access — assume Tailscale is in use.** The viewer stays on loopback; other machines reach it through Tailscale Serve. `--tailscale-origin` requires an explicit fixed `--port` (Serve proxies to one local port):

```sh
flowition viewer --port 4646 --tailscale-origin https://<machine>.<tailnet>.ts.net
tailscale serve --bg 4646
```

The banner and `--print-url` then give both a local and a tailnet URL — prefer the tailnet one when handing out links; it works from any of the user's devices. A non-443 origin port must match the serve flag (`:8443` ↔ `tailscale serve --bg --https=8443 4646`). `tailscale serve` only, never `funnel` — public Funnel requests are refused, and the same tokens still apply on the tailnet path.

## CLI commands

```
flowition run <file.workflow.js> [--args '<json>' | --args-file <f>]
              [--adapter a] [--model m] [--effort e] [--cwd dir]
              [--concurrency N] [--budget N] [--resume <runId>] [--seed-from <runId>]
              [--detach] [--json]
flowition resume <runId> [--concurrency N] [--budget N] [--json]
flowition runs [--json]                      List runs, newest first
flowition status <runId> [--json]            Phases, per-agent state, open ask()s, queued mail, spend
flowition tail <runId> [-f] [--agent N]      Run narrative, or one agent's transcript
flowition send <runId> <agent> <msg…>        Steer a live agent by index or label
flowition answer <runId> <qid> <text…>       Answer a workflow ask()
flowition cancel <runId> [--agent N]         Cancel one agent or the whole run
flowition post <msg…>                        Agent→operator progress (FLOWITION_* env, or --run/--agent)
flowition result <runId> [--wait [seconds]]  Print the final result; --wait blocks (default 3600s)
flowition rm [<runId>] [--purge]             Trash a run (recoverable 7 days); --purge empties the trash (valid alone)
flowition prune [--older-than N] [--purge]   Trash terminal runs older than N days and/or purge trash (needs ≥1 flag)
flowition viewer [--port N] [--control[=caps]] [--open] [--print-url] [--stop]
                 [--tailscale-origin https://<machine>.<tailnet>.ts.net[:port]]
flowition doctor                             Adapter CLIs: found, versions, capabilities, amp modes
flowition guide                              Print the authoring contract (written for agents)
flowition mcp                                Serve flowition as an MCP stdio server
```

`flowition mcp` exposes these MCP stdio tools: `flowition_run` (detached → runId), `flowition_status`, `flowition_result` with optional wait, `flowition_send`, `flowition_answer`, `flowition_cancel`, `flowition_resume`, `flowition_runs`, and `flowition_guide`.

## Running a workflow for a user (from an agent)

- **Detach long runs; never hold a foreground process.** `flowition run … --detach` prints a runId and returns immediately. Give the user a viewer deep link to watch it (see Viewer — prefer the tailnet URL); use `flowition status <id>` / `flowition tail <id> -f` for your own checks.
- **Block with `flowition result <id> --wait`, never sleep-poll.** It returns the moment a result exists (waits up to 3600s by default, `--wait 300` to bound it).
- `--json` on run/resume/status/tail/result gives machine-readable output.
- Before launching: `node --check` the file, and confirm the ES-module situation (`"type": "module"` in the nearest package.json, or a `.mjs` filename).
- `flowition doctor` before a multi-adapter run — it checks each CLI's `--version` and reports steering/resume/schema capabilities (plus discovered amp modes). It does not verify authentication.
- Remember agents run with full permissions in the workflow's cwd. Don't point a workflow you haven't read at a machine you care about.

## A complete example

Pipeline + schema + per-call adapter selection: review dimensions fan out on the run's adapter, each finding is adversarially verified on codex the moment its review completes (no barrier), then one synthesis agent writes the report.

```js
// review.workflow.mjs — real run: flowition run review.workflow.mjs --args '{"target":"src/"}' --detach
// free smoke test: flowition run review.workflow.mjs --args '{"target":"src/","mock":true}' --adapter mock
export const meta = {
  name: 'review-verify',
  description: 'Review a target across dimensions, adversarially verify on a second model family',
  phases: [{ title: 'Review & Verify' }, { title: 'Report' }],
}

const FINDINGS = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          detail: { type: 'string' },
        },
        required: ['title', 'file', 'detail'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
}

const VERDICT = {
  type: 'object',
  properties: { real: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['real', 'reason'],   // codex strict mode: every property listed
  additionalProperties: false,
}

export default async function ({ agent, pipeline, parallel, phase, log, args }) {
  const target = (args && args.target) || 'src/'
  const mock = args && args.mock === true
  const prompt = (real, fixture) => mock
    ? `${typeof fixture === 'string' ? 'ECHO' : 'JSON'} ${typeof fixture === 'string' ? fixture : JSON.stringify(fixture)}`
    : real
  const DIMENSIONS = ['correctness bugs', 'error handling', 'concurrency hazards']

  phase('Review & Verify')
  const results = await pipeline(
    DIMENSIONS,
    (dim) => agent(
      prompt(
        `Review ${target} for ${dim}. Report only concrete, evidenced findings.`,
        { items: [{ title: `Mock ${dim}`, file: 'mock.js', detail: 'Mock finding' }] },
      ),
      { schema: FINDINGS, label: `review:${dim}` },              // inherits the run's adapter
    ),
    (review, dim) => parallel(review.items.map((f, vi) => () =>
      agent(
        prompt(
          `Try to REFUTE this finding in ${target}: ${f.title} — ${f.detail} (${f.file}). Default to real=false if uncertain.`,
          { real: true, reason: 'Mock verification' },
        ),
        { adapter: mock ? 'mock' : 'codex', schema: VERDICT, label: `verify:${dim}:${vi}` },   // index keeps live labels unique
      ).then((v) => ({ ...f, dimension: dim, real: v.real, reason: v.reason })))),
  )
  const confirmed = results.filter((r) => r !== null).flat().filter((f) => f !== null && f.real)
  log(`${confirmed.length} findings survived cross-model verification`)

  phase('Report')
  return agent(
    prompt(
      `Write a prioritized review report from these verified findings:\n${JSON.stringify(confirmed, null, 2)}`,
      'Mock report',
    ),
  )
}
```

The inner `parallel()` is per-item fan-out (verify all of one dimension's findings concurrently), not a cross-dimension barrier — dimension one's findings can be verified while dimension three is still reviewing.
