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
npm test        # 144 tests against the in-process mock adapter; no API credits consumed
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

## Core concepts

### The workflow contract

A workflow is a plain ES module — no source transform, no vm. It exports `meta`
(`name`, `description`, optional `phases`) and a default async function that
receives the toolkit:

```js
export default async function ({ agent, spawn, parallel, pipeline, phase, log,
                                 ask, sendTo, args, budget, now, random }) { … }
```

`agent(prompt, opts)` resolves to the agent's final text, or a validated object
when `opts.schema` is set. Options include `adapter`, `model`, `effort`,
`system`, `schema`, `cwd`, `label`, and `key`. `spawn()` is `agent()` returning
immediately with a steerable handle (`{ done, send }`). `parallel(thunks)` is a
barrier; `pipeline(items, ...stages)` runs each item through stages with no
barrier between them — prefer it. `flowition guide` prints the full authoring
contract, written to be pasted into an agent's context.

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
agents from the journal and re-runs the rest; an interrupted agent whose
provider session id was journaled *continues that session* with an
"interrupted, finish the task" nudge rather than starting over. Undelivered
steering mail is restored, `ask()` answers replay, and the budget ceiling is
restored. Resume refuses — loudly, rather than silently forking history — when
the workflow file or any local import changed (byte-for-byte hash of the module
graph), when args differ, or when the workflow contains constructs the import
scanner cannot follow statically (`eval`, `Function(`, computed dynamic
imports). Fresh runs are never affected by those constructs.

### Budget

`--budget N` sets an output-token ceiling exposed as `budget.total` /
`budget.spent()` / `budget.remaining()`. It is advisory: checked before each
agent is admitted, so one in-flight agent can overshoot the remainder. Spend is
journaled (including failed and cancelled agents) and restored on resume.

## CLI reference

| command | description |
|---------|-------------|
| `flowition run <file>` | Run a workflow. `--args <json>` / `--args-file <f>`, `--adapter`, `--model`, `--effort`, `--cwd`, `--concurrency N`, `--budget N`, `--resume <id>`, `--detach`, `--json` |
| `flowition resume <runId>` | Continue an interrupted run: journal replay plus provider-session resume. `--concurrency`, `--budget`, `--json` |
| `flowition runs` | List runs, newest first. `--json` |
| `flowition status <runId>` | Snapshot: phases, per-agent state, unanswered `ask()`s, queued mail, spend. `--json` |
| `flowition tail <runId>` | Print the run narrative, or one agent's transcript with `--agent N`. `-f` follows. `--json` |
| `flowition send <runId> <agent> <msg…>` | Steer a live agent by index or label (live-inject or queued follow-up turn) |
| `flowition answer <runId> <qid> <text…>` | Answer a workflow `ask()` |
| `flowition cancel <runId>` | Cancel the run, or one agent with `--agent N` |
| `flowition post <msg…>` | Agent→operator progress report; run/agent come from `FLOWITION_*` env or `--run`/`--agent` |
| `flowition result <runId>` | Print the final result; `--wait [seconds]` blocks until one exists |
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
Residual caveats are documented honestly in
[ARCHITECTURE.md → Known limitations](ARCHITECTURE.md#known-limitations).

## Development

```
npm test    # 144 tests via node:test against a deterministic in-process mock adapter
```

The suite consumes no API credits and needs none of the real CLIs installed.
The codebase is plain ESM with zero runtime dependencies; the engine internals
— journal format, resume keys, mail-delivery semantics, the import scanner —
are documented in [ARCHITECTURE.md](ARCHITECTURE.md). Adapter behaviors
(stream protocols, resume vehicles, flag quirks) were verified empirically
against the real CLIs.

## Status and roadmap

v0.1. Before this first release the engine went through an extensive adversarial
review campaign — many rounds of cross-model review and fix validation, every
confirmed finding fixed under a regression test. The suite that campaign produced
ships with the project. Planned next: a web viewer for runs (today
`flowition tail -f` and `flowition status --json` are the observation surfaces),
a sandboxing phase at the adapter layer, and more adapters.

## License

[MIT](LICENSE)
