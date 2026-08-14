# flowition — architecture

Flowition is a deterministic multi-agent workflow engine. A workflow is a plain-JS module
that composes real coding-agent CLIs — **claude, codex, amp, droid, opencode, pi, cursor, grok** —
with programmatic control flow. Flowition is both *invokable by* agents (CLI with `--json`,
`--detach`, and an MCP stdio server) and an *invoker of* agents (each `agent()` call
spawns a real CLI process); agents inside a run can call back into flowition (`flowition post`,
or even `flowition run` recursively) via injected `FLOWITION_*` env vars.

Design lineage: Claude Code's Workflow tool and prior CLI orchestrators. Flowition keeps their strengths
(deterministic scripts, journaled replay, chained positional resume keys, per-agent
transcripts) and adds the four things they lack:

1. **Mid-run communication** — operator→agent steering, workflow→agent steering,
   agent→operator reports, and operator→workflow answers (`ask()`).
2. **Cross-run provider-session resume** — an interrupted agent *continues its
   provider session* instead of restarting (session ids are journaled).
3. **Per-agent control** — cancel one agent, not just the whole run.
4. **A supervisable process model** — detached runs, heartbeat, control socket,
   `status`/`tail -f` from any other terminal or agent.

## Component map

```
bin/flowition.js            CLI entry
src/cli.js             commands: run, resume, runs, status, tail, send, answer,
                       cancel, post, result, rm, prune, viewer, doctor, guide, mcp
src/engine.js          run loop: module load, DSL toolkit, journal replay, budget,
                       control-socket handlers, heartbeat, outcome
src/agent-proc.js      AgentJob: one agent() call across 1..n provider turns
                       (initial → schema-corrective → queued-mail follow-ups),
                       live stdin injection, stall watchdog, cancellation
src/adapters/index.js  per-CLI adapters (argv construction, capabilities)
src/adapters/protocols.js  stream parsers → normalized events
src/adapters/mock.js   deterministic in-process adapter for tests
src/keys.js            chained positional resume keys, per-branch rng/now
src/journal.js         journal.jsonl (resume log)
src/events.js          events.jsonl (observability stream) + fold
src/transcript.js      agents/<n>.jsonl per-agent conversation
src/control.js         unix-socket JSONL request/response
src/schema.js          minimal JSON Schema validator + prompt contract
src/mcp.js             MCP stdio server (flowition_run/status/result/send/answer/…)
src/guide.js           authoring guide served by `flowition guide` / MCP flowition_guide
```

## Viewer

The v1 viewer is one long-lived Node HTTP process plus a prebuilt browser SPA.
`flowition viewer` serves the runs under the current `FLOWITION_HOME`; it is an
observer and control-socket bridge, not another workflow engine. It never imports
`src/engine.js`, `src/agent-proc.js`, or `src/adapters/**`, never holds a run lock,
and never loads or executes a workflow module. Resume is delegated to a detached
CLI process, and delete is delegated to the same lock-aware retention module used
by `flowition rm`.

### Process and module map

```
src/viewer/                       shipped Node server; node: builtins + reviewed relatives
  index.js          bind/reuse, HMAC discovery, rendezvous, auto-start, idle shutdown
  http.js           Host/auth/origin/content-type gates, CSP/headers, error envelope
  auth.js           home ownership, 0600 read token, ephemeral control token, capabilities
  routes.js         read, stream, search, session, and mutation route dispatch
  summaries.js      paginated run listing and identity-keyed summary cache
  snapshot.js       run detail from event fold + journal join + derived liveness
  fold.js           tolerant event fold shared with the SPA
  journal-view.js   lossy, read-only journal projection; never journal repair
  tail.js           bounded byte-domain JSONL tailing, torn-line and rotation handling
  cursor.js         composite SSE cursor encode/parse
  stream.js         multiplexed SSE replay/tail, resets, batching, backpressure
  pages.js          bounded transcript and event pages
  search.js         bounded, deadline-limited in-run search
  control-bridge.js control-socket send/answer/cancel; detached resume; retention delete
  audit.js          append-only lifecycle/control audit records outside run directories
  static.js         realpath-contained viewer/dist serving, content types, cache policy

viewer/                           private TypeScript/React build workspace
  src/api/          authenticated fetch + EventSource clients
  src/app/          hash router, token bootstrap, shell and run rail
  src/state/        snapshot/poll/SSE stores
  src/features/     Home, cockpit, transcript/result, and opt-in controls
  src/lib/          bounded Markdown and ANSI projection
  dist/             committed prebuilt assets; the only viewer/ subtree published
```

The root package has no runtime `dependencies`. The SPA's runtime and build
dependencies stay isolated in the private `viewer/` package; globally installed
users receive `viewer/dist/**` rather than its toolchain. CI builds into a temporary
directory, byte-compares the complete output tree with committed `viewer/dist`,
rejects inline script/style output, and checks the real `npm pack` manifest for both
the static assets and `src/viewer/**`. The root suite runs separately without
`viewer/node_modules`.

### Startup and capability model

The default listener is `127.0.0.1:4646`; a fixed-port collision walks through
4655, while `--port 0` requests one ephemeral port. A primary writes a 0600
`$FLOWITION_HOME/viewer.json` rendezvous record. Reuse is accepted only after a
challenge response proves knowledge of the read token with HMAC; an unauthenticated
`/healthz` shape alone never causes a token-bearing URL to be printed.

A human-attended foreground `flowition run` starts discovery concurrently with the
workflow. It auto-starts only on a TTY without `--detach`, `--json`, `--quiet`,
`--no-viewer`, or `FLOWITION_NO_VIEWER=1`, prints a deep link only after the
challenge succeeds, and always starts the server with idle shutdown and without
control capabilities. MCP and detached paths never auto-start a viewer.

`--tailscale-origin https://machine.tailnet-name.ts.net` opts a viewer into being
reached from the operator's own tailnet through Tailscale Serve, which terminates
tailnet TLS and proxies to the loopback port — the bind itself never leaves
`127.0.0.1`. The flag accepts exactly one canonical HTTPS `*.ts.net` origin,
requires an explicit fixed `--port` (no port walking — Serve forwards to one
port), and refuses to run as a secondary. It adds that single authority to the
closed Host allowlist, requires Serve's `X-Forwarded-Proto: https` on requests
for it, and unconditionally refuses traffic marked with Serve's public-Funnel
header. The rendezvous record carries the origin, and reuse matches on it: a
caller whose tailnet policy differs from the live instance gets a loud refusal
after the challenge proof, never a second listener with different exposure. All
token, origin, and capability gates apply to tailnet requests unchanged.

The default capability set is empty. `--control` enables
`send,answer,cancel,resume,delete`; `--control=<comma-list>` enables a subset.
Every absent capability remains a 403 at the HTTP boundary and is reported by
`GET /api/session` so the SPA fails closed. Because the control token is minted
in memory and never persisted, another CLI process cannot attach control to an
existing viewer or recover it with `--print-url`; restart with `--control` or use
an explicit secondary port.

### Security posture and residuals

The viewer exposes prompts, args, transcripts, provider session metadata, and
results that are otherwise protected by 0700 run directories. Loopback binding
alone is not treated as authentication:

- every `/api` read requires a persistent 32-byte read token held in a 0600 file;
  equality is constant-time, and discovery proves token knowledge without sending it;
- mutation requests additionally require the ephemeral control token, an exact
  same-origin `Origin`, JSON content type, capability grant, and bounded bodies;
- printed tokens travel in the URL fragment, never an HTTP request target or process
  argument; the SPA moves them to `sessionStorage` and scrubs the fragment before routing;
- the server uses a strict Host allowlist, emits no CORS headers and no cookies, redacts
  query tokens from diagnostics, and logs no request or transcript bodies;
- the static policy is `default-src 'none'`, first-party script/style/font/connect
  only, no framing, and no inline script/style. Transcript Markdown and ANSI become
  bounded React elements; raw HTML, remote images, and `innerHTML` paths are excluded.

Read-only is a statement about run-control capabilities, not about the process
touching no files: the server creates/reads its token, startup lock, and rendezvous
under `FLOWITION_HOME`, and the shared liveness classifier may clean an aged
`.resuming` marker. It does not repair or rewrite journal/event/transcript streams.
Lifecycle operations are possible only when explicitly enabled; delete moves a
non-live run to Flowition's trash under the shared run lock, and resume delegates
the unchanged engine hash/key checks to a detached CLI.

Accepted residuals are explicit. Other local users can observe that a loopback port
exists. A process running as the same user can read the token and run files; that
adversary already has the CLI's full authority and is out of scope. A control token
is an instruction channel into agents running with full user permissions, so it is
RCE-equivalent in impact even though the viewer itself never executes a workflow.
The v1 viewer is supported on macOS and Linux, not Windows, and is not a remote or
multi-user service.

### On-disk contract and compatibility

The durable source is still `$FLOWITION_HOME/runs/<runId>/`, described in
[Persistence & resume](#persistence--resume). The viewer combines, rather than
conflates, its three append-only JSONL domains:

- `events.jsonl` supplies run/phase/agent/log/question/mail chronology;
- `journal.jsonl` supplies metadata, attempts, usage, answers, sessions, and results;
- `agents/<index>.jsonl` supplies the per-agent transcript.

It also derives liveness from `run.lock`, `control.sock`, `.heartbeat`,
`.resuming`, and terminal `result.json`; detached `run.log` and lifecycle trash
remain separate artifacts. Readers are bounded and lossy: torn final lines,
oversize records, missing files, unknown record types, and fields absent from old
runs degrade to unknown/omitted UI state rather than triggering a migration or a
workflow replay. New viewer-facing journal data is additive, and none of it enters
the resume-key derivation.

The normative contracts are [DESIGN §4–§7 and §16.6](docs/frontend/DESIGN.md);
the field-level inventory, writer locations, and historical artifact caveats are
in [RECON-flowition §1](docs/frontend/RECON-flowition.md). Source remains decisive
when those historical citations refer to an older commit.

## Workflow contract

```js
export const meta = { name, description, phases }
export default async function ({ agent, spawn, parallel, pipeline, phase, log,
                                 ask, sendTo, args, budget, now, random }) { … }
```

Explicit-toolkit ES modules (no source transform, no vm): the file is imported and
the default export is called with the toolkit. Determinism rules are by contract:
use `now()`/`random()` (journal-seeded, per-branch substreams) instead of
`Date.now()`/`Math.random()`.

## Adapter layer

Each adapter declares capabilities and builds argv per turn:

| adapter  | protocol          | steer | resume vehicle              | schema mode  |
|----------|-------------------|-------|-----------------------------|--------------|
| claude   | claude-stream     | live  | `claude -p --resume <sid>`  | native `--json-schema` |
| amp      | claude-stream-eof | live  | `amp threads continue <id>` | prompt       |
| codex    | codex-jsonl       | turn  | `codex exec resume <tid>`   | native `--output-schema <file>` |
| droid    | droid-jsonl       | turn  | `droid exec -s <sid>`       | prompt       |
| opencode | opencode-jsonl    | turn  | `opencode run --session <id>`| prompt      |
| pi       | pi-jsonl          | turn  | `pi --session-id <uuid>` (flowition-assigned) | prompt |
| cursor   | cursor-jsonl      | turn  | `cursor-agent -p --resume <sid>` | prompt  |
| grok     | claude-stream     | turn  | `grok --resume <sid>`       | native `--json-schema` |

Parsers normalize each CLI's JSONL into: `session`, `text`, `reasoning`, `tool`,
`tool-result`, `usage`, `result`, `error` (+ `turn-end` for amp, which runs turns
with stdin open but only flushes its `result` event at stdin EOF — flowition closes stdin
on `assistant stop_reason=end_turn` instead).

`spec.system` rides a native flag where the CLI has one (claude/droid/pi:
`--append-system-prompt`; grok: `--rules`); amp, codex, opencode, and cursor have none, so their builders
prepend a delimited `[system instructions] … [task]` preamble to the prompt of
the first turn of a fresh session only — resume turns (schema correction,
queued-mail follow-ups, cross-run continuation) continue a session that already
carries it and never repeat the preamble.

`spec.effort` maps to a native flag or mode per adapter — except cursor, which
encodes effort into the model id itself (`gpt-5.6-sol-xhigh`) and has no flag:
its `validateSpec` rejects `effort` at `agent()` time rather than dropping it.
Grok's `--reasoning-effort` accepts only `low|medium|high|xhigh`; the adapter
maps `none`/`minimal` → `low`, `max` → `xhigh`, and omitted effort → `high`.

**Steering semantics.** `steer: 'live'` (claude, amp): user messages are injected as
stream-json lines on the running process's stdin; an outstanding-message counter
decides when stdin closes. `steer: 'turn'` (codex, droid, opencode, pi, cursor, grok): mail queues
in the AgentJob; when the current turn ends, queued mail is delivered as a
session-resume follow-up turn. Either way `agent()` resolves only after all injected
messages are consumed, so steered guidance is always reflected in the returned result —
deliver or declare: when the provider session cannot take a follow-up turn (no
resumable session id was captured), queued mail is terminally declared undeliverable
instead — journaled as `mail-done` with `dropped: true` and a loud DROPPED notice
in the transcript — never silently stranded. Mail acceptance closes synchronously
with the successful final turn (AgentJob sets `settled` in the same synchronous
segment as its last queue check, before `execute()` resolves), so a send racing
the completion microtasks is dropped loudly, never stranded as a pending record
no turn will consume. The `dropped` flag keeps the record
out of the delivered-mail multiset (it still clears the pending entry), so after
a crash-before-result the resumed workflow's re-send of that text goes out
genuinely instead of being absorbed against a delivery that never reached the
provider. Likewise, mail queued on a `spawn()` handle whose agent
replays from cache (no job ever starts) is dropped with an events-log notice.
Delivery is durable only once a resumable session id exists or the result is
recorded: a turn that completes without ever emitting a session event
(degenerate stream) defers its `mail-done` records — the engine journals them
alongside the COMPLETED result record instead, since a fresh session started by
a crash-resume would never see mail marked delivered at turn end (the pending
queue would clear and workflow re-sends would be absorbed against a delivery
the new session never received). A crash before the result record therefore
leaves the mail pending, which is exactly right: the mail restores into the
fresh session the resumed attempt starts.
Every accepted mail record is origin-tagged: `operator` for control-socket sends,
`workflow` for `sendTo()` and `spawn()`-handle sends. Workflow-origin records
additionally carry a deterministic identity: `sender` — the sending
context's resume-key branch (`sendTo()` captures it at call time; a `spawn()`
handle captures the creating context's branch once at creation and stamps it
on every send through the handle; control-socket sends stay operator and carry
none) — `callsite` — the workflow-side call position `file:line:column`, read
from a fresh `Error().stack` as the first frame outside flowition's own src files
(stable across replays because resume pins the workflow file and its import
graph byte-for-byte via fileHash + graphHash) — and `seq`, the 1-based ordinal
of that (sender, callsite)'s sends to that agent within the run. The replay
identity of a workflow send is key+sender+callsite+text+ordinal: each
re-executing call site re-issues its sends in order, so its Nth send to an
agent is the same logical send as the original run's Nth from that branch and
position. On resume ALL pending mail is restored to the
agent's queue — the restored copy is authoritative for delivery (it delivers
under its original journal id). Workflow-origin re-sends from the re-executing
workflow are idempotent replays: each is absorbed against two per-agent
multisets keyed on sender+callsite+text+seq — mail already delivered into the
continued session before the crash, and mail restored as pending — and a send
whose sender, callsite, text, or ordinal matches neither goes out fresh.
Without the sender, a DIFFERENT branch's logical send could still be
suppressed when recovery legitimately changes control flow (a
previously-failed agent succeeding on retry alters branches) and the colliding
send shares text AND position — and a suppressed genuine send can starve a
receiver forever. Without the call site, SEQUENTIAL call sites within one
branch (if/else arms, consecutive lines) share an identity, so a recovery that
switches arms could still absorb a different logical send with the same text
and per-sender ordinal. With both, neither different branches nor different
call sites can EVER absorb each other's sends. The remaining ambiguity —
identical text from the IDENTICAL call site under nondeterministic
interleavings (e.g. same-callsite sends racing on un-awaited promises can
shift ordinals between runs) — biases toward an at-least-once duplicate into
the continued session, an explicit choice of duplication over loss. Legacy
records keep their narrower identities, one layer at a time: journaled without
`callsite`, they fall back to sender+text+seq matching; without `sender`, to
text+seq; without `seq`, to text-only — conservative, but bounded to old
journals.
Restoration cannot rely on the workflow re-sending: a cached sender replays
instantly and its `sendTo()` can fire before the receiver is admitted, find no
live job, and deliver nothing — which is why pending workflow mail is restored
rather than tombstoned (older engines wrote `skipped: true` tombstones at
restore; those records still load, clearing pending without counting as
deliveries). Records from pre-origin journals restore as operator (a possible
duplicate beats loss).

**Schema enforcement.** Native where the CLI supports it; otherwise a prompt contract
(appended OUTPUT CONTRACT block) + `parseJsonLoose`. All modes re-validate client-side
with the built-in validator; a failure triggers one corrective follow-up turn in the
same provider session before the agent fails with `schema_invalid`.

## Persistence & resume

Run dir: `$FLOWITION_HOME/runs/<flo_id>/` (default `~/.flowition`):

- `run.lock` — exclusive per-run lock (pid-stamped, stale locks from dead
  processes are reclaimed). Two engines can never execute the same run
  concurrently; the lock is held until `result.json` is written.
- `journal.jsonl` — resume log: `meta` (fileHash/graphHash/args/seed/defaults/
  budgetTotal/keyVersion), `started`, `session` (provider session id per agent
  key), `usage-cum` (running-total usage snapshots: the provider thread's
  cumulative totals for codex, the job's own per-event running totals for the
  other adapters — crash-window spend is recomputed from them on load),
  `mail`/`mail-done` (origin-tagged steering messages — workflow-origin ones
  carry their `sender` branch, `callsite` position, and per-(agent, sender,
  callsite) send ordinal `seq` —
  accepted / delivered into the provider session), `result`, `step-start`/
  `step-result` (durable `step()` lifecycle: only `completed` step results are
  replayed on resume; a start with no result is an ambiguous crash window and
  the callback re-runs — callbacks must be idempotent), `answer` (ask()
  replies), `end`.
  Loaded strictly on resume: a torn final record (crash mid-append) is repaired by
  truncation; interior corruption refuses to resume rather than silently
  re-running side-effecting history.
- `events.jsonl` — observability: `run`, `phase`, `agent` state changes, `step`
  state changes, `log`, `question`/`answer`, `mail`.
- `agents/<index>.jsonl` — per-agent transcript (text/reasoning/tool/mail).
- `result.json`, `run.log` (detached), `.heartbeat` (5s deadman), `control.sock`,
  `scratch/` (prompt/schema temp files).
- `.resuming` — detached-resume launch marker (written tmp+rename by the
  launcher): while it is fresh, readers probe the control socket instead of
  trusting a stale terminal `result.json`. The engine re-stamps the marker's
  mtime right after the socket-bind gate succeeds, so its 30s budget covers
  preflight from bind rather than from launcher spawn, and clears it at the
  ownership point, immediately before it clears the stale `result.json` (never
  earlier — a CPU-blocked event loop, e.g. the module-graph scan, can outlast
  a reader's socket-probe timeout). A failed, contended, or preflight-refused
  resume leaves the marker to age out in 30s (a transient "starting").
  Readers have a second, event-loop-independent ownership signal, applied in
  every classification branch (terminal, corrupt, and result-less alike):
  `run.lock` — a held lock whose pid is alive means an engine owns the run
  (even one blocked in synchronous preflight past both the marker budget and
  the probe timeout), so the run reports running: any terminal file is a
  previous attempt's, and a result-less dir is an engine that hasn't produced
  its result yet. Conversely, a result-less dir with NO held lock, no socket
  answering, and no heartbeat — but a journal on disk — is an attempt that
  started and crashed before its first heartbeat: classified stale (so
  `flowition_result` waiters resolve) rather than unknown; bare dirs with no journal
  stay unknown. Accepted residual: a stale lock whose dead writer's pid
  was reused by an unrelated process can transiently misreport a dead run as
  running — bounded, because the next resume attempt's reclaim clears the lock
  (`acquireRunLock` disambiguates pid reuse via `ps` start times).

Resume keys are chained positional (v3-style): each `parallel()`/`pipeline()` call
derives a branch node from a per-branch fan-out counter; items and stages derive
sub-branches; `agent()` chains branch + local index + prompt + resolved-spec hash.
`step()` chains branch + its own independent per-branch counter + name +
canonicalized args, so steps and agents never shift each other's keys and a
changed step spec never reuses a cached result.
Keys are concurrency-invariant, so replay is stable regardless of completion order.

`flowition resume <runId>` verifies key version, fileHash, the local import graph hash
(a changed `./dep.js` also blocks resume), and args. Graph files are
canonicalized with `realpath` before hashing and their relative specifiers
resolve against the realpath's directory, matching Node's ESM loader for
symlinked entries and deps (two symlink routes to one file hash once); a
lexically-resolved path would hash a different, often nonexistent file and
miss changes to the actually-loaded dep. Under `--preserve-symlinks` Node
resolves lexically, so canonicalization is skipped — the resolution mode
always matches Node's own, in both modes. Detection follows Node's
boolean-flag semantics: the bare token or ANY `--preserve-symlinks=<value>`
spelling ENABLES, and any `--no-preserve-symlinks` token — with or without
an `=<value>` — NEGATES (the value is ignored on both forms: `=false` and
`=0` still enable, `--no-…=false` still negates), and the last mention wins
with NODE_OPTIONS applied before the command line (Node's own precedence);
the separate `--preserve-symlinks-main` / `--no-preserve-symlinks-main`
pair only affects the entry point and never counts. Then: **completed** agents
replay instantly from the journal; **failed/cancelled/unfinished** agents re-run —
and if a provider session id was journaled, the agent *continues that session* with
a firm "you were interrupted, finish the task" nudge rather than starting over
(in-process retries after a stall likewise resume the session the failed attempt
captured). Undelivered steering mail of any origin is restored to the agent's
queue (workflow-origin re-sends from the replayed workflow are absorbed
against per-agent multisets of sender-branch+callsite+text+send-ordinal
already delivered before the crash or restored as pending, so the continued
session never receives the same logical steering twice), the budget ceiling is
restored from meta, and ask() answers replay from the journal.
Preconditions throw rather than silently forking history.
A SIGKILL/OOM of the engine itself can orphan a provider CLI child for a few
seconds (until its next write to the dead engine's pipe fails), so an immediate
resume can briefly overlap that dying child's provider session — the same
documented at-least-once class as crash-window steering, duplication over loss.

### Cross-run result seeding (`--seed-from`)

Because derived agent keys hash branch position + prompt + resolved spec — no run
id, no seed, no file hash — an unchanged `agent()` call derives the identical key
across runs. `flowition run <edited-file> --seed-from <runId>` (`src/seed.js`)
exploits that: it loads a settled source run's journal **read-only** (never
`{repair:true}`; a torn tail is tolerated as an ignored record, interior corruption
refuses) and exposes its final last-wins `status === 'completed'` agent results as a
candidate cache for a fresh run — the recovery path for exactly the case resume
correctly refuses, an edited workflow file.

This is deliberately weaker than resume: key equality identifies the same call
shape but pins none of what resume pins (file bytes, args, `now()`/`random()`
streams, steering, world state), so it is operator-authorized cache reuse for
research/pure-result agents, never a freshness guarantee. The exclusions keep
everything session- or side-effect-shaped out: `step()` results (step keys don't
hash the callback, and a completed step proves a side effect in the *old* world),
`ask()` answers, provider sessions, usage baselines, steering mail, and any source
key that ever accepted steering mail (mail isn't keyed but shaped the answer). The
steering exclusion is source-side only: steering newly added in the *target* cannot
retroactively invalidate a hit — the seeded result is materialized before the spawn
handle can send, so that mail is dropped with a warning, exactly like a same-run
cache replay. To force real execution, change the call's prompt/spec or give it an
explicit `key`.
Explicit `o.key` results are excluded structurally — explicit keys hash in their own
domain, and the engine skips the seed lookup entirely when a call passes `key`.

Preconditions: the source must exist, be settled (completed/failed/interrupted/
stale — a failed run's completed agents seed fine; running/starting have a live
writer and refuse), match `KEY_VERSION`, and not be the target itself. A bad source
is an admission failure sealed like any other. On a hit the engine allocates a
target index and durably appends a completed `result` record to the **target**
journal — `usage: null` so imported spend never enters the budget aggregates, with
the source's run id, index, and usage on a `seeded` provenance field — *before*
returning the result, so a later resume of the target replays it from its own
journal even after the source run is deleted. The `cached` event (and the shared
fold's `seededFrom` annotation) distinguishes cross-run seeding from same-run
replay; the target's `meta` records the source's run id and hashes as provenance.

## Communication & inspection

A unix control socket per run accepts `status`, `send` (steer agent by index or
label), `answer` (resolve an `ask()`), `cancel` (one agent or the run), `post`
(agent→operator report). The CLI maps onto it; agents inside the run receive
`FLOWITION_RUN_ID` / `FLOWITION_AGENT_INDEX` / `FLOWITION_CONTROL_SOCK` / `FLOWITION_BIN` and can
`flowition post "msg"` upward (or launch nested flowition runs). `flowition status` folds
`events.jsonl` into a snapshot and augments with live socket data; `flowition tail -f`
follows the run narrative or a single agent's transcript.

## MCP surface

`flowition mcp` serves stdio JSON-RPC (initialize / tools/list / tools/call) with tools:
`flowition_run` (detached; returns runId), `flowition_status`, `flowition_result` (optional wait),
`flowition_send`, `flowition_answer`, `flowition_cancel`, `flowition_resume`, `flowition_runs`, `flowition_guide`.
Any MCP-capable CLI can therefore orchestrate flowition workflows, monitor them, and
steer their agents — the "invoked by agents" half of the loop.

## Sandboxing

Deliberately out of scope for this phase: every adapter runs with its most permissive
flags (`--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`,
`--skip-permissions-unsafe`, `--auto`, `--force`). The adapter layer is where per-mode sandbox
policies would slot in later (a per-provider sandbox matrix is the
reference design).

## amp agent modes

amp has no model flag — its `-m` selects an *agent mode* (bundled model + system
prompt + tools). Flowition supports the builtin modes (low/medium/high/ultra) plus any
custom modes installed as amp plugins: it parses the `// @amp-agent-mode
{"key","label"}` annotations amp's plugin sync stamps into
`~/.config/amp/plugins/*.ts` (falling back to scanning `registerAgentMode()` calls
for hand-written plugins). On amp, `model` (or the amp-only `mode` option) resolves
against these by key or label, case-insensitively — `model: 'Claude Fable xhi'` →
`-m claude-fable-xhi`; an unknown mode fails at `agent()` time listing what's
available. Without an explicit mode, `effort` maps to a builtin mode
(xhigh/max→ultra); the effort table is closed, so an out-of-vocabulary effort
also fails at `agent()` time listing the accepted values instead of surfacing
as a spawn error. `flowition doctor` lists discovered modes;
`FLOWITION_AMP_PLUGINS_DIR` overrides the plugins directory.

## Result & usage integrity

Parsers track `sawTerminal` — whether the protocol's own completion event was
observed. A result synthesized from partial output of a crashed process (terminal
event never seen, nonzero exit) is refused rather than cached as success; opencode,
whose terminal signal *is* clean EOF, requires exit code 0. Codex reports
thread-cumulative usage each turn: flowition journals the baseline and charges only
deltas, and never double-counts `cached_input_tokens` (a subset of input). The
other adapters report per-event usage; flowition journals their job-level running
totals as `usage-cum` records too — one line per usage event, with a `{0,0}`
reset whenever an attempt restarts the totals from zero (mirroring the codex
session-change reset) — so the crash window (tokens reported after the last
result record of a crashed attempt) is charged on resume for EVERY adapter via
the same `Journal.load` delta chaining, not just codex. Failed and cancelled
agents' usage is charged to the run like completed ones; completed usage is
aggregated at journal load and seeded into the run totals at start (the
cache-hit replay path adds nothing), so `budget.spent()` still counts completed
work whose key a resumed run's control flow never revisits.

## Known limitations

- The output-token budget is an advisory pre-admission ceiling: it is checked
  before each agent starts, so one in-flight agent can overshoot the remaining
  allowance. It is not a provider-enforced hard cap.
- Embedding flowition as a library (calling `runWorkflow` repeatedly in one long-lived
  process) can execute a stale *dependency* module from Node's ESM cache after
  the file changed on disk — only the entry file gets a cache-busting URL. The
  shipped surfaces are immune: the CLI is one process per run and MCP detaches
  child processes.
- The import scanner is a small lexer, not a JS parser. `/` is judged as
  division ONLY after a token that grammatically ends an expression: an
  identifier, an operand keyword (`this`/`super`/`true`/`false`/`null`), a
  literal, or a closing `)`/`]` (statement-head parens excluded, below).
  After anything else — including the COMPLETE reserved + contextual word
  list (`await` through `yield`, plus `async`/`get`/`set`) — `/` starts a
  regex, scanned escape-aware including `[...]` classes, in both the main
  lexer and inside template interpolations. The keyword surface is closed by
  construction, not enumerated per bug: a contextual word used as a plain
  identifier before division (a variable literally named `of` in `of / 2`)
  enters a regex scan that either terminates benignly or trips the universal
  swallow guard / EOL rule — a loud `dynamic` flag, never a silent miss. The
  only residual silent surface is a future reserved word added to JS after
  this list was written. All four JS line terminators (`\n`, `\r`,
  `\u2028`, `\u2029`) are modeled where the grammar ends a construct at any
  of them: each ends a `//` comment scan and a regex-literal scan, so a
  CR-only file cannot hide code that Node sees as separate lines. String
  scans terminate on `\n`/`\r` ONLY: a raw `\u2028`/`\u2029` inside a `'` or
  `"` string is legal CONTENT since ES2019, and treating it as end-of-line
  would trip the unterminated-string fail-safe on loadable code. `++`/`--` are consumed as one token
  and, on one line, are TRANSPARENT to expression state: postfix follows
  an operand, so the position stays expression-end and `a++ / 2` is
  division; prefix precedes its operand, so the position stays
  non-expression and a following `/` (`++/re/.x` — valid JS, the grammar
  lexes a regex there) enters the guarded regex scan, where a quote in the
  body flags dynamic loudly instead of a phantom string swallowing a
  same-line import. Across a line terminator (a multi-line `/* */` comment
  counts, like the grammar) a `++`/`--` is PREFIX by construction — `[no
  LineTerminator here]` forbids postfix there — so the carried
  expression-end is dropped and ASI's `a NEWLINE ++/re/` lexes the regex
  instead of a phantom division. The
  `)` position is decided by a statement-head paren stack: a paren opened
  right after `if`/`while`/`for`/`switch`/`catch` — including `for await`,
  via one word of lookbehind — closes into statement position (`/` starts a
  regex there), while any other `)` — call or grouping — still ends an
  expression, so `(a+b)/2` and `f(x)/2` stay division. A word after `.` is a
  property name, not a keyword: `obj.return / 2` is division and `x.if(y)`
  opens a call paren, not a statement head. `}` before `/` (object-literal
  division vs block-then-regex) stays undecidable without a parser and
  prefers regex. On top of all position judgments sits a universal swallow
  guard: EVERY regex scan — however its position was judged — whose body
  contains a quote character or the token `import` flags the module
  `dynamic`. A phantom regex from a mis-judged position can therefore never
  silently swallow an import (the quote or the import text itself trips the
  guard); the deliberate cost is that a genuine regex containing a quote or
  the word import in a workflow file disables resume for that workflow — a
  loud `computed dynamic import` refusal, while fresh runs are unaffected.
  The remaining fail-safe direction is also dynamic: a string scan that
  reaches `\n`/`\r`/EOF without its closing quote, a regex scan that reaches
  any of the four line terminators/EOF unclosed (each a syntax error in
  loadable code, so on real source they only fire on a mis-lex or a
  mis-judged division — a legal string carrying a raw ` `/` ` never
  trips them), a template still open at EOF, or an unterminated
  quoted span inside a template interpolation all flag the module `dynamic`;
  interpolation brace-counting skips quoted spans, comments, regex bodies,
  and nested templates escape-aware, so a `}` inside them cannot end the
  interpolation early. Source-phase and deferred imports are first-class:
  `import.source(` and `import.defer(` are recognized (only a `(` directly
  after the recognized property arms call handling — `import.meta`, its
  properties, and `import.meta.resolve(…)` stay inert) and behave exactly
  like `import(` — a literal specifier is hashed (a `.wasm` dep is hashed
  but never lexed for nested imports; its bytes are not JS), anything
  computed flags `dynamic`. CommonJS chains are lexed the same way: the
  identifier token `require` immediately followed by `(` behaves exactly
  like `import(` — a plain-quoted literal specifier is hashed when it is a
  local path (bare package names stay environment), anything else flags
  `dynamic`; `obj.require(x)` stays clean via the dot-property rule, and the
  word `require` inside strings and comments stays inert. Inside template
  interpolations a `require(` flags `dynamic` like any import mention —
  interpolations never extract specifiers. Mis-lexes therefore fail toward a spurious
  `dynamic` flag or a deterministic phantom hash entry — a loud resume
  refusal, never a silently unsound resume. Runtime code construction is
  handled the same way: `eval("import('./dep.mjs')")` executes an import the
  scanner cannot see, precisely BECAUSE string contents are deliberately
  inert (the design's core property — prompt text mentioning `import(x)`
  must never hash or flag anything). eval/`Function` bodies cannot be
  statically followed, so flowition refuses resume loudly when they appear in
  workflow code: in code position, the identifier tokens `eval` and
  `Function` immediately followed by `(` flag `dynamic` (fresh runs are
  unaffected) — with or without a preceding `new`, since bare
  `Function('...')` constructs the identical function per ES 20.2.1.1; a
  user identifier literally named `Function` false-positives toward the
  loud refusal, the preferred direction. The dot-property rule keeps
  `obj.eval(x)` / `globalThis.eval(x)` / `obj.Function(x)` clean, and the
  words `eval`/`Function` inside a string or comment stay inert. Honest
  residual: indirect eval reached through an alias or property (`const e =
  eval; e(src)`, `(0, eval)(src)`, and the optional-call spelling
  `eval?.(src)` — per spec an optional call is INDIRECT eval, never direct,
  so it belongs to this alias class) is not detected, and property-mediated
  Function construction escapes the same way — `Function.call(null, src)` /
  `Function.apply(...)` via that same deliberate dot-property rule, and
  `Reflect.construct(Function, [src])` because there `Function` is a bare
  identifier read, never followed by `(` — flagging bare
  identifier reads of `eval`/`Function` would poison ordinary code, so that
  surface stays open by choice.
- Only local path imports and requires (`./`, `../`, `/`, `file:`) participate
  in the module-graph hash. Bare package specifiers (node_modules) are
  environment — like the agent CLI binaries themselves — and resume does not
  validate the environment.
- Steering a turn-steer adapter *after* its final turn completed is a no-op (the
  agent already resolved); `flowition status` shows queued counts so operators can see it.
- The stall watchdog (30 min default, `stallMs` per agent) is the only turn timeout.
