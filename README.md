# flowition

**flowition** = *flow* (as in workflow) + *-ition* (as in notation): a notation
for agent workflows.

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node: >=18.17](https://img.shields.io/badge/node-%3E%3D18.17-339933.svg)

Deterministic multi-CLI agent workflow engine. Write a plain-JS file that
orchestrates real coding-agent CLIs — **claude, codex, amp, droid, opencode, pi** —
with programmatic control flow, then run it, watch it, steer it mid-run, and
resume it after an interruption.

```js
// review.workflow.js
export const meta = { name: 'review', description: 'cross-provider review' }

export default async function ({ agent, parallel, phase }) {
  phase('Review')
  const [a, b] = await parallel([
    () => agent('Review src/ for bugs. Return the top 3.', { adapter: 'claude', model: 'claude-sonnet-5' }),
    () => agent('Review src/ for bugs. Return the top 3.', { adapter: 'codex', model: 'gpt-5.2' }),
  ])
  phase('Judge')
  return agent(`Merge these two reviews, consensus first:\nA: ${a}\nB: ${b}`, { adapter: 'codex' })
}
```

```
flowition run review.workflow.js
```

The CLI installs as `flowition`, with `flo` as a short alias.

Each `agent()` call spawns a real CLI process with full permissions in your
working directory. Read the [Security](#security) section before running
anything you did not write.

## Why flowition

- **Six CLI families, one DSL.** Every `agent()` call picks its adapter;
  schemas, steering, resume, transcripts, and budgets behave uniformly across all of them.
- **Mid-run communication is first-class.** Steer a running agent from another
  terminal (`flowition send`), from workflow code (`spawn()` handles, `sendTo()`); the
  workflow can block on operator input (`ask()` / `flowition answer`), and agents report
  upward with `flowition post`.
- **Resume continues provider sessions.** Completed agents replay instantly from
  the journal (chained deterministic keys); interrupted agents *continue their
  provider session* where they left off — session ids are journaled per agent.
- **Per-agent control, detached supervision.** Cancel one agent without killing
  the run; run detached and inspect from any other terminal or agent with
  `status` / `tail -f` over a per-run control socket.
- **Both directions.** Flowition invokes agent CLIs, and agent CLIs invoke flowition —
  via the plain CLI (`--json`, `--detach`) or the built-in MCP server (`flowition mcp`).

## Requirements

- Node >= 18.17. Flowition itself has zero runtime dependencies.
- Each adapter you actually use needs its CLI installed and authenticated:
  [claude](https://www.anthropic.com/claude-code) (Claude Code),
  [codex](https://github.com/openai/codex) (OpenAI Codex CLI),
  [amp](https://ampcode.com),
  [droid](https://factory.ai) (Factory),
  [opencode](https://opencode.ai),
  and pi.
  You only need the ones your workflows reference; `flowition doctor` reports which
  are found and what each supports.

## Installation

```
npm i -g flowition
flowition doctor    # verify which adapter CLIs are installed
```

Contributors can install from a clone instead:

```
git clone https://github.com/ben-vargas/flowition.git
cd flowition
npm link        # exposes `flowition` (and `flo`) on PATH
npm test        # root node:test suite; mock adapter, no API credits consumed
```

## Quick start

Save as `hello.workflow.js`:

```js
export const meta = { name: 'hello', description: 'one tiny agent' }

export default async function ({ agent }) {
  return agent('Reply with exactly the single word: pong')
}
```

```sh
flowition run hello.workflow.js                    # foreground, live narration
flowition run hello.workflow.js --adapter codex    # same workflow, different CLI
flowition run hello.workflow.js --detach           # background → prints a runId

flowition status <runId>                 # phases, per-agent state, open questions, spend
flowition tail <runId> -f                # follow the run narrative
flowition tail <runId> --agent 0         # follow one agent's transcript
flowition send <runId> 0 "shorter"       # steer a running agent by index or label
flowition answer <runId> q0 "ship it"    # answer a workflow ask()
flowition cancel <runId> --agent 0       # cancel one agent (omit --agent for the run)
flowition resume <runId>                 # replay finished agents; continue interrupted ones
```

## Viewer

`flowition viewer` starts the v1 browser UI for the runs under
`$FLOWITION_HOME/runs` (default `~/.flowition/runs`). It binds loopback only and
prints an authenticated URL:

```sh
flowition viewer                         # read-only; Ctrl-C stops it
flowition viewer --open                  # also open the URL on macOS/Linux
flowition viewer --port 0                # choose an ephemeral port
flowition viewer --control               # opt in to all five mutations
flowition viewer --control=send,answer   # or grant only a subset
```

The default is deliberately read-only: send, answer, cancel, resume, and delete
routes return 403 until their capability is enabled with `--control`. Starting
with `--control` mints a control token that exists only in that server process.
It cannot be added to an already-running viewer; stop that process and restart
it with `--control`, or use an explicit second `--port`.

For a foreground, non-JSON, non-quiet run in a TTY, `flowition run` discovers or
auto-starts a viewer and prints a verified deep link to the run. Detached, MCP,
`--json`, and `--quiet` runs never auto-start it. Disable this behavior with
`--no-viewer` or `FLOWITION_NO_VIEWER=1`. Auto-started viewers are read-only and
use idle shutdown (15 minutes by default); an explicit server can opt into the
same policy with `--idle-shutdown --idle-timeout <minutes>`.

The printed URL carries the read token, and for a fresh `--control` process the
control token, in the URL fragment. The browser moves them into
`sessionStorage` and removes them from the address bar before routing.
`flowition viewer --print-url` prints a fresh read-only URL for a live instance;
it cannot recover the in-memory control token. Treat a viewer URL as sensitive:
the read token exposes prompts, transcripts, args, and results for this
Flowition home, while the control token can steer full-permission agents and
change run lifecycle state.

### Tailnet access (Tailscale Serve)

The viewer never listens on a non-loopback address, but it can be reached from
your own tailnet through [Tailscale Serve](https://tailscale.com/kb/1312/serve),
which terminates tailnet TLS and proxies to the loopback port:

```sh
flowition viewer --port 4646 --tailscale-origin https://machine.tailnet-name.ts.net
tailscale serve --bg 4646
```

`--tailscale-origin` requires an explicit fixed `--port` and accepts exactly one
canonical HTTPS `*.ts.net` origin. Serve's external HTTPS port defaults to 443;
an origin with a nonstandard port (`https://machine.tailnet-name.ts.net:8443`)
needs the matching flag: `tailscale serve --bg --https=8443 4646`.

The flag teaches the request gates about that one
path: the `.ts.net` name joins the closed Host allowlist, requests for it must
carry Serve's `X-Forwarded-Proto: https`, and anything marked as public Funnel
traffic (`Tailscale-Funnel-Request`) is refused — use `tailscale serve`, never
`tailscale funnel`. Every other gate is unchanged: tailnet requests need the
same bearer token, and mutations still need `--control` plus the control token.
The startup banner prints both the local and the tailnet URL; open the tailnet
one from another machine on your tailnet. All tokens travel in the URL fragment,
which never crosses the network.

The viewer reads the same append-only artifacts used by the CLI and degrades
unknown or older fields instead of requiring a migration. The exact module,
security, packaging, and on-disk contracts are documented in
[ARCHITECTURE.md](ARCHITECTURE.md#viewer).

## Core concepts

### The workflow contract

A workflow is a plain ES module — no source transform, no vm. It exports `meta`
(`name`, `description`, optional `phases`, optional `argsSchema`) and a default
async function that receives the toolkit:

```js
export default async function ({ agent, spawn, step, parallel, pipeline, phase,
                                 log, ask, sendTo, args, budget, now, random }) { … }
```

`agent(prompt, opts)` resolves to the agent's final text, or a validated object
when `opts.schema` is set. Options include `adapter`, `model`, `effort`,
`system`, `schema`, `cwd`, `label`, and `key`. `spawn()` is `agent()` returning
immediately with a steerable handle (`{ done, send }`). `parallel(thunks)` is a
barrier; `pipeline(items, ...stages)` runs each item through stages with no
barrier between them — prefer it. `flowition guide` prints the full authoring
contract, written to be pasted into an agent's context.

### Input contracts

`meta.argsSchema` declares what the run's `--args` value must look like, using
the same JSON Schema subset as agent output schemas (unsupported keywords are
rejected loudly, never silently ignored):

```js
export const meta = {
  name: 'release',
  description: 'cut and publish a release',
  argsSchema: {
    type: 'object',
    properties: { version: { type: 'string', minLength: 1 }, dryRun: { type: 'boolean' } },
    required: ['version'],
    additionalProperties: false,
  },
}
```

The effective args are validated before any agent or step executes — on fresh
runs and resumes alike — and a violation fails the run with the schema paths
that did not match. No defaults are merged: the toolkit's `args` is still the
`--args` value verbatim.

### Durable steps

`step(name, args, fn)` runs local code — git commands, file writes, API calls —
as a journaled unit of work. When the callback completes, its JSON result is
written to the journal, and a resume *replays* the recorded result instead of
re-executing the callback (incomplete or failed attempts re-run):

```js
const branch = await step('create-branch', { name: `release/${args.version}` }, async () => {
  execSync(`git switch -c release/${args.version}`)
  return { branch: `release/${args.version}` }
})
```

`name` plus the canonicalized `args` are part of the step's resume identity —
changed args are a different step and never reuse a cached result. Steps keep
their own per-branch counter, independent of agents, so inserting or removing a
step never shifts agent resume keys. Args and results must be plain JSON
(`undefined`, functions, `NaN`, `BigInt`, and cycles are rejected loudly); a
void callback resolves to `null`. Steps appear in `flowition status`, `tail`,
the web viewer's run snapshot,
and the MCP snapshot alongside agents.

The guarantee is durable memoization, **not** exactly-once side effects: an
append-only journal cannot commit an external effect and its completion record
atomically. A completed step never re-runs; a step interrupted between its
effect and its completion record — and a *failed* step — re-runs on resume.
Write callbacks to be idempotent, or carry an idempotency key in `args`.

### Editor autocomplete

The npm package ships declarations for the workflow toolkit, but editors do not
search globally installed packages. Install `flowition` locally in the project
where you author workflows, even if the CLI you run remains the global one:

```sh
npm install --save-dev flowition
```

Note that workflow files are ES modules, and Node decides how to parse a `.js`
file from the nearest package.json. If the install above creates one (`npm init
-y` writes `"type": "commonjs"`), make sure it carries `"type": "module"` — or
name your workflows `.mjs` — or the workflow will fail to load.

Then use a JSDoc type annotation in the plain-JavaScript workflow:

```js
// @ts-check

/** @type {import('flowition').WorkflowMeta} */
export const meta = { name: 'review', description: 'review one target' }

/** @satisfies {import('flowition').JSONSchema} */
const FINDINGS = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'string' } } },
  required: ['items'],
  additionalProperties: false,
}

/** @type {import('flowition').Workflow<{ target: string }>} */
const workflow = async ({ agent, args, phase }) => {
  phase('Review')
  return agent(`Review ${args.target} for bugs`, { schema: FINDINGS })
}

export default workflow
```

The `@satisfies` tag on a hoisted schema is not optional under `@ts-check`:
without it `type: 'object'` widens to `string` and no longer matches the schema
type. A schema written inline in the `agent()` call is contextually typed and
needs no annotation.

The JSDoc import is erased tooling syntax: it does not import or execute
`flowition` at runtime — the package exposes types only, and a runtime
`import('flowition')` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED` by design. A
global `npm i -g flowition` alone cannot provide this editor resolution.

### Adapters

| adapter  | steering | resume vehicle                 | schema mode |
|----------|----------|--------------------------------|-------------|
| claude   | live     | `claude -p --resume <sid>`     | native      |
| amp      | live     | `amp threads continue <id>`    | prompt      |
| codex    | turn     | `codex exec resume <tid>`      | native      |
| droid    | turn     | `droid exec -s <sid>`          | prompt      |
| opencode | turn     | `opencode run --session <id>`  | prompt      |
| pi       | turn     | `pi --session-id <uuid>`       | prompt      |

*Live* steering injects your message into the running process's stdin. *Turn*
steering queues it and delivers it as a session-resume follow-up turn when the
current turn ends; either way, `agent()` resolves only after every accepted
message has been consumed, so steering is always reflected in the result.

One amp quirk: amp selects *agent modes* (bundled model + prompt + tools), not
models. On amp, `model`/`mode` resolves against the builtin modes
(low/medium/high/ultra) and any custom modes installed as amp plugins, by key
or label; `flowition doctor` lists what's discovered.

### Structured output

`schema` uses the CLI's native mechanism where one exists (claude
`--json-schema`, codex `--output-schema`) and an appended output-contract block
plus loose JSON parsing elsewhere. All modes re-validate client-side; a failure
triggers one corrective follow-up turn in the same session before the agent
fails with `schema_invalid`. The built-in validator implements a documented
subset of JSON Schema (`type`, `required`, `properties`, `additionalProperties`,
`items`, `enum`, `const`, min/max bounds, `anyOf`); unsupported keywords such
as `pattern` or `oneOf` are rejected loudly, never silently ignored. Caveat for
codex: OpenAI's strict mode requires every property to be listed in `required` —
express optional fields as nullable, e.g. `{ "type": ["string", "null"] }`.

### Determinism and resume

Use the injected `now()` / `random()` instead of `Date.now()` / `Math.random()`
— they are journal-seeded with per-branch substreams. Pass *thunks* to
`parallel()`. Every `agent()` call gets a chained positional resume key derived
from its branch, index, prompt, and resolved spec, so replay is stable
regardless of completion order.

`flowition resume <runId>` (or `flowition run <file> --resume <runId>`) replays completed
agents and completed `step()` results from the journal and re-runs the rest; an
interrupted agent whose
provider session id was journaled *continues that session* with an
"interrupted, finish the task" nudge rather than starting over. Undelivered
steering mail is restored, `ask()` answers replay, and the budget ceiling is
restored. Resume refuses — loudly, rather than silently forking history — when
the workflow file or any local import changed (byte-for-byte hash of the module
graph), when args differ, or when the workflow contains constructs the import
scanner cannot follow statically (`eval`, `Function(`, computed dynamic
imports). Fresh runs are never affected by those constructs.

### Cross-run result seeding

When resume refuses because you *edited the workflow*, the completed results of the
old run don't have to be paid for again: `flowition run new.workflow.js --seed-from
<runId>` loads a settled source run's journal read-only and reuses its completed
agent results as a candidate cache. Derived resume keys hash branch position +
prompt + resolved spec — no run id, no file hash — so an unchanged `agent()` call
matches across runs and replays instantly, while the calls you edited derive new
keys and run fresh. Each hit is durably written into the *new* run's journal with
`seeded` provenance (source run id and usage), so the target resumes normally even
after the source run is deleted, and seeded results add **zero** to the new run's
budget/spend.

This is operator-authorized cache reuse, weaker than resume: key equality identifies
the same call shape but does not pin file bytes, args, `now()`/`random()` streams, or
world state — use it for research/pure-result agents, not for agents whose
correctness depends on file edits or other side effects. Never seeded: `step()`
results (durable side effects proven only against the old world), explicit-`key`
agents (an explicit key matches even a rewritten call), `ask()` answers, provider
sessions, steering mail, and any source result that received steering. The source
must be settled (completed/failed/interrupted/stale — a failed run's *completed*
agents seed fine) with a matching key version; `--seed-from` applies to fresh runs
only and cannot combine with `--resume`.

### Budget

`--budget N` sets an output-token ceiling exposed as `budget.total` /
`budget.spent()` / `budget.remaining()`. It is advisory: checked before each
agent is admitted, so one in-flight agent can overshoot the remainder. Spend is
journaled (including failed and cancelled agents) and restored on resume.

## CLI reference

| command | description |
|---------|-------------|
| `flowition run <file>` | Run a workflow. `--args <json>` / `--args-file <f>`, `--adapter`, `--model`, `--effort`, `--cwd`, `--concurrency N`, `--budget N`, `--resume <id>`, `--seed-from <id>`, `--detach`, `--json` |
| `flowition resume <runId>` | Continue an interrupted run: journal replay plus provider-session resume. `--concurrency`, `--budget`, `--json` |
| `flowition runs` | List runs, newest first. `--json` |
| `flowition status <runId>` | Snapshot: phases, per-agent state, unanswered `ask()`s, queued mail, spend. `--json` |
| `flowition tail <runId>` | Print the run narrative, or one agent's transcript with `--agent N`. `-f` follows. `--json` |
| `flowition send <runId> <agent> <msg…>` | Steer a live agent by index or label (live-inject or queued follow-up turn) |
| `flowition answer <runId> <qid> <text…>` | Answer a workflow `ask()` |
| `flowition cancel <runId>` | Cancel the run, or one agent with `--agent N` |
| `flowition post <msg…>` | Agent→operator progress report; run/agent come from `FLOWITION_*` env or `--run`/`--agent` |
| `flowition result <runId>` | Print the final result; `--wait [seconds]` blocks until one exists |
| `flowition viewer` | Serve the authenticated local run UI. `--port N`, `--control[=send,answer,cancel,resume,delete]`, `--tailscale-origin https://…ts.net`, `--idle-shutdown`, `--idle-timeout M`, `--open`, `--print-url`, `--json` |
| `flowition doctor` | Check each adapter CLI: found, version, steering/resume/schema capabilities, amp modes |
| `flowition guide` | Print the workflow authoring guide (written for agents) |
| `flowition mcp` | Serve flowition as an MCP stdio server |

## MCP

`flowition mcp` serves stdio JSON-RPC with tools `flowition_run` (detached, returns a
runId), `flowition_status`, `flowition_result` (optional wait), `flowition_send`,
`flowition_answer`, `flowition_cancel`, `flowition_resume`, `flowition_runs`, and `flowition_guide`.
Any MCP-capable agent can therefore author a workflow, launch it, monitor it,
and steer its agents — the "invoked by agents" half of the loop. Agents
*inside* a run additionally receive `FLOWITION_RUN_ID` / `FLOWITION_AGENT_INDEX` /
`FLOWITION_BIN` and can `flowition post` progress upward or launch nested runs.

## Configuration

| variable | effect |
|----------|--------|
| `FLOWITION_HOME` | State directory; runs live in `$FLOWITION_HOME/runs/<runId>/` (default `~/.flowition`) |
| `FLOWITION_NO_VIEWER` | Set to `1` to disable viewer auto-start for foreground TTY runs |
| `FLOWITION_VIEWER_PORT` | Default viewer port when `--port` is absent (normally `4646`) |
| `FLOWITION_VIEWER_LOG` | Set to `1` for metadata-only HTTP access lines; queries and bodies are not logged |
| `FLOWITION_<CLI>_BIN` | Override an adapter's executable, e.g. `FLOWITION_CLAUDE_BIN=/opt/claude` |
| `FLOWITION_AMP_PLUGINS_DIR` | Where amp agent-mode plugins are discovered (default `~/.config/amp/plugins`) |

Each run directory holds the journal, event stream, per-agent transcripts,
control socket, and result; the layout is documented in
[ARCHITECTURE.md](ARCHITECTURE.md#persistence--resume).

## Security

**Flowition does no sandboxing in this phase.** Every adapter is run with its most
permissive flags — `--dangerously-skip-permissions` (claude),
`--dangerously-bypass-approvals-and-sandbox` (codex),
`--skip-permissions-unsafe` (droid), `--auto` (opencode), and the equivalent
non-interactive modes of amp and pi. Agents can read, write, and execute
anything the invoking user can, in the workflow's `cwd` and beyond.

Run only workflows you trust, with prompts you trust, on machines where that
level of access is acceptable — ideally inside a container or VM for anything
untrusted. Run directories are created `0700` (they contain full transcripts).

The viewer does not turn that local trust boundary into a remote service. It
binds `127.0.0.1` only, requires a 0600-file read token for every API read, has
no cookies or CORS, and is read-only unless `--control` explicitly grants
capabilities. Mutations additionally require an ephemeral in-memory control
token, same-origin requests, and JSON. The static UI is shipped under a
`script-src 'self'; style-src 'self'` CSP and renders transcript data without an
HTML injection path.

Those controls do not sandbox Flowition. A control credential can steer agents
that already run with full user permissions. Loopback port presence is visible
to other local users, and a process running as your user can read the token and
the run files; that same-user adversary already has the CLI's access and is out
of scope. See [ARCHITECTURE.md → Viewer](ARCHITECTURE.md#viewer) for the full
posture and residuals.

## Development

```
npm test    # root node:test suite against a deterministic in-process mock adapter
```

The suite consumes no API credits and needs none of the real CLIs installed.
The codebase is plain ESM with zero runtime dependencies; the engine internals
— journal format, resume keys, mail-delivery semantics, the import scanner —
are documented in [ARCHITECTURE.md](ARCHITECTURE.md). Adapter behaviors
(stream protocols, resume vehicles, flag quirks) were verified empirically
against the real CLIs.

## Status and roadmap

v0.1, including the first local viewer. Before this first release the engine went through an extensive adversarial
review campaign — many rounds of cross-model review and fix validation, every
confirmed finding fixed under a regression test. The suite that campaign produced
ships with the project. The viewer is intentionally v1: local macOS/Linux only,
read-only by default, and backed directly by run-directory artifacts rather than a
database. Planned next: a sandboxing phase at the adapter layer and more adapters.

## License

[MIT](LICENSE)
