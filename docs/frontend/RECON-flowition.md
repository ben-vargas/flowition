# RECON — flowition's observability substrate

Field-level inventory of everything a viewer can read, the control protocol it can drive,
and an audited list of what the engine does **not** emit.

Scope: read of `src/events.js`, `src/transcript.js`, `src/journal.js`, `src/run-state.js`,
`src/control.js`, `src/engine.js`, `src/agent-proc.js`, `src/cli.js`, `src/mcp.js`,
`src/keys.js`, `src/util.js`, `src/semaphore.js`, `src/adapters/*.js`, `ARCHITECTURE.md`,
`README.md`, `index.d.ts` at commit `96362e7` (branch `feat-frontend`).

Every claim below cites `file:line`. Where this document contradicts `ARCHITECTURE.md`,
the source was re-read and the source wins; those cases are flagged inline.

---

## 0. Method notes and hard facts a viewer must internalize first

1. **The run directory is the only durable surface.** There is no database, no index
   file, no summary. `runsDir()` = `$FLOWITION_HOME/runs` (`src/util.js:9-10`), default
   `~/.flowition/runs`.
2. **Run ids are validated at exactly one choke point** — `runDir(id)`
   (`src/util.js:17-21`), regex `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`. A viewer MUST route
   every user-supplied id through `runDir()` and never `path.join` an id itself.
3. **Three append-only JSONL streams per run**, written with plain `fs.appendFileSync`
   (`src/util.js:28`, `src/transcript.js:19`) — no fsync, no locking, no rotation. A
   reader can always observe a torn final line; both shipped readers tolerate it
   (`src/util.js:36` skips unparseable lines; `src/cli.js:293-296` only renders up to the
   last `\n`).
4. **The journal is not the event stream.** `journal.jsonl` is the resume log;
   `events.jsonl` is the observability stream. They carry *different* data, and the most
   valuable telemetry (per-agent input tokens, cost, cumulative usage) lives **only in the
   journal**. Any serious viewer must read both. See §1.4.
5. **A viewer must never load the journal with `repair: true`.** `Journal.load(dir, {repair:true})`
   mutates the file (`src/util.js:69-71`) and is engine-only, called under the run lock
   (`src/engine.js:786`). Read-only callers get `repair:false` by default, but note that
   `Journal.load` **throws** on interior corruption (`src/util.js:73`). For a viewer, prefer
   the lossy `readJsonl` (`src/util.js:30-39`) and fold it yourself, or wrap `Journal.load`
   in try/catch as `flowition runs` does (`src/cli.js:205`).

---

## 1. On-disk contract

### 1.1 Run directory layout

Created 0700 (`src/engine.js:623`, `src/util.js:26`), with a best-effort `chmod` for dirs
made by older versions (`src/engine.js:626-627`).

| Path | Writer | Lifetime | Notes |
|---|---|---|---|
| `journal.jsonl` | `Journal.append` (`src/journal.js:54`) | forever | resume log; strict-parsed on resume |
| `events.jsonl` | `EventSink.emit` (`src/events.js:12`) | forever | observability stream |
| `agents/<index>.jsonl` | `Transcript.write` (`src/transcript.js:14-20`) | forever | per-agent conversation |
| `result.json` | `finalize` tmp+rename (`src/engine.js:640-642`) | terminal | also written by MCP on spawn failure (`src/mcp.js:59-62`) |
| `.heartbeat` | engine, 5s interval (`src/engine.js:832-834`) | while running | epoch ms as a bare string |
| `run.lock` | `acquireRunLock` (`src/engine.js:52`) | while an engine owns the run | `{pid, startedAt}` |
| `run.lock.reclaim.<pid>.<n>` | stale-lock reclaim (`src/engine.js:76`) | transient/leaked | never trust as a lock |
| `.resuming` | detached-resume launcher (`src/cli.js:120-123`, `src/mcp.js:137-140`) | ≤30s | epoch ms; re-stamped after socket bind (`src/engine.js:749-752`) |
| `.resuming.claim.<pid>.<uuid>` | run-state sweep (`src/run-state.js:98`) | transient/leaked | counts as "starting" while young (`src/run-state.js:37-50`) |
| `control.sock` | `serveControl` (`src/control.js:111`) | while running | unix socket |
| `control.sock.claim.<pid>` | stale-socket claim (`src/control.js:54`) | transient/leaked | |
| `.result.json.<pid>.tmp` | `finalize` (`src/engine.js:640`) | microseconds | never surface it |
| `run.log` | detached launcher, stdout+stderr fd (`src/cli.js:114`, `src/mcp.js:48`) | detached runs only | |
| `scratch/` | adapters (`src/adapters/index.js:221,243`) | per-turn; swept at start (`src/engine.js:754-759`) | prompt/schema temp files, 0600 |

### 1.2 `events.jsonl`

**Envelope.** Every record is `{ t, type, ...payload }` where `t = Date.now()` stamped at
emit (`src/events.js:12`). There is **no sequence number** and no per-type id. Byte order
in the file is the only total order — two events in the same millisecond are otherwise
indistinguishable (see G10).

**Emission is unconditional on disk**; `quiet` only suppresses the stderr mirror
(`src/events.js:13`). Detached runs always pass `--quiet` (`src/cli.js:118`,
`src/mcp.js:71`), so `run.log` is nearly empty for healthy detached runs.

#### `type: 'run'`

| Field | Type | Present when | Source |
|---|---|---|---|
| `runId` | string | always | `src/engine.js:1140`, `:643` |
| `state` | `'started'` \| `'resumed'` \| `'completed'` \| `'failed'` \| `'interrupted'` | always | start: `:1140` (`prior ? 'resumed' : 'started'`); terminal: `:643` from `outcome.status` |
| `file` | string | start event only | **basename only** — `path.basename(file)` (`:1140`) |
| `name` | string \| null | start event only | `meta.name ?? null` (`:1140`) |
| `error` | string \| undefined | terminal event | `outcome.error` (`:643`) |

Emitted at `src/engine.js:1140` (after module load, semaphore construction, budget seeding
— i.e. *after* preflight, so a run that dies in preflight has **no** `run` start event) and
at `src/engine.js:643` inside `finalize`, which runs for: normal completion, workflow
failure, abort, module-load failure (`:848`), unreadable workflow file (`:776`), and
control-socket bind failure on a fresh run (`:740`).

`foldEvents` merges all `run` events into one object (`src/events.js:50`), so the folded
snapshot carries `file`/`name` from the start event and `state`/`error` from the terminal
one.

#### `type: 'phase'`

| Field | Type | Source |
|---|---|---|
| `title` | string | `String(title)` from `phase()` (`src/engine.js:1103`) |

That is the **entire** payload. No index, no id, no agent association, no end marker, no
nesting. `foldEvents` pushes titles into a flat array including duplicates
(`src/events.js:51`). See G1 — this is the single biggest structural gap.

#### `type: 'log'`

| Field | Type | Source |
|---|---|---|
| `message` | string | `String(message)` |

Call sites, all in `src/engine.js`: `log()` toolkit (`:1104`), abort reason (`:665`),
journal torn-tail repair notice (`:830`), agent retry notice (`:956`), post-completion
telemetry error (`:983`), spawn-handle dropped-mail notice (`:1042`). Free-text only — no
level, no agent index, no code (G23).

#### `type: 'agent'`

The one event a UI depends on most, and the least uniform. Field presence **varies by
state**:

| Field | `running` `:915` | `cached` `:906` | `done` `:981` | `failed`/`cancelled` `:994` | `steered` `:696` |
|---|---|---|---|---|---|
| `index` | ✔ | ✔ (from journal) | ✔ | ✔ | ✔ |
| `key` | ✔ | ✔ | ✔ | ✔ | ✘ |
| `label` | ✔ (null-able) | ✔ | ✔ | ✔ | ✔ |
| `adapter` | ✔ | ✔ | ✔ | ✔ | ✔ |
| `model` | ✔ | ✔ | ✘ | ✘ | ✘ |
| `effort` | ✔ | ✘ | ✘ | ✘ | ✘ |
| `promptPreview` | ✔ (160 chars) | ✘ | ✘ | ✘ | ✘ |
| `durationMs` | ✘ | ✘ | ✔ | ✘ | ✘ |
| `outputTokens` | ✘ | ✘ | ✔ | ✘ | ✘ |
| `resultPreview` | ✘ | ✘ | ✔ (200 chars) | ✘ | ✘ |
| `error` | ✘ | ✘ | ✘ | ✔ (message string only) | ✘ |
| `delivery` | ✘ | ✘ | ✘ | ✘ | ✔ |

State vocabulary: `running | cached | done | failed | cancelled | steered`
(`src/events.js:30-35`). `cancelled` is chosen when the thrown error is an `AgentError`
with `code === 'cancelled'` (`src/engine.js:991`).

Timing semantics: `durationMs = Date.now() - t0` where `t0` is captured **after** the
semaphore admits the job (`src/engine.js:949`), i.e. it excludes queue wait. The `running`
event is likewise emitted inside `sem.with` (`:911` → `:915`), so there is no on-disk
record of when `agent()` was *called* (G6).

`failed`/`cancelled` carry **no** `durationMs` even though the journal `result` record does
(`src/engine.js:992`) — see G17.

`AgentError.code` (`spawn_failed | stalled | provider_error | truncated | no_result |
schema_invalid | cancelled`, from `src/agent-proc.js:386,395,396,400,406,410,412,191,177`)
is **dropped**: only `err.message` reaches the event and the journal (G27).

#### `type: 'question'` / `type: 'answer'`

| Event | Fields | Source |
|---|---|---|
| `question` | `qid`, `question`, `runId` | `src/engine.js:1119` |
| `answer` | `qid` **only** | `src/engine.js:705` |

The answer **value** never reaches `events.jsonl`; it is journaled as
`{type:'answer', qid, value}` (`src/engine.js:704`). `foldEvents` uses the `answer` event
purely to flip an `answered` boolean (`src/events.js:54`). `qid` is derived from the branch
context — `'q' + ctx.questionIndex++` plus a 16-hex branch suffix when not at the root
branch (`src/engine.js:1108-1110`), so the qid leaks a *truncated* branch key but nothing a
viewer can resolve to a structure. Ask events also carry no association to any agent (G12).

#### `type: 'mail'`

| Field | Type | Notes |
|---|---|---|
| `agent` | number \| string \| null | **type-inconsistent** — see below |
| `dir` | `'in'` \| `'out'` | in = operator/workflow → agent; out = agent → operator |
| `message` | string | full text, untruncated |
| `delivery` | verdict string | **only on `sendTo()` sends** (`src/engine.js:1130`) |

Three call sites:
- control-socket `send` → `dir:'in'`, `agent = job.index` (number), **no `delivery`**
  (`src/engine.js:697`) — even though the sibling `agent`/`steered` event on the previous
  line does carry it.
- workflow `sendTo()` → `dir:'in'`, `agent = job.index` (number), **with `delivery`**
  (`src/engine.js:1130`) — and **no** accompanying `steered` agent event.
- control-socket `post` (i.e. `flowition post` from inside an agent) → `dir:'out'`,
  `agent = req.agent ?? null` (`src/engine.js:720`). The CLI sources that from
  `FLOWITION_AGENT_INDEX`, a **string** (`src/cli.js:347`), and it is passed through
  unvalidated. So `mail.agent` is a number for `in` and a string (or null) for `out`.

`foldEvents` ignores `mail` entirely (`src/events.js:49-55`) — `flowition status` never
shows agent reports. A viewer reading the raw stream gets them for free.

### 1.3 `agents/<index>.jsonl` (per-agent transcript)

**Envelope.** `{ t, kind, ...payload }`, `t = Date.now()` at write (`src/transcript.js:15`).

**File lifecycle.** Created/truncated at agent start when the index is *new*
(`src/engine.js:917` passes `fresh: !resumedIndex`; `src/transcript.js:12` does
`writeFileSync(file, '')`). On resume, an index that already exists is **appended to**, with
a `status` record whose `text` is the sentinel string `'— resumed run: new attempt below —'`
(`src/engine.js:918`). That string is the only attempt boundary (G15). Agents that replay
from cache never construct a `Transcript`, so their file is untouched; agents that never
started have no file at all → a viewer must handle ENOENT.

**Truncation chain.** `Transcript.write` truncates by field name
(`src/transcript.js:16-18`), and several parsers truncate *before* that. Effective limits:

| kind | field | parser-side cap | transcript cap | effective |
|---|---|---|---|---|
| `meta` | `prompt` | — (engine slices to 4000, `src/engine.js:919`) | not truncated (field is `prompt`) | **4000 chars, hard** |
| `text` | `text` | — | 32768 | 32768 |
| `reasoning` | `text` | — | 32768 | 32768 |
| `tool` | `input` | 2000 for codex/opencode/droid/pi (`protocols.js:93,150,237,213`); unbounded for claude/amp (`:36`) | 8192 | **2000** most adapters, 8192 claude/amp |
| `tool-result` | `output` | 4000 droid/pi (`:240,214`); unbounded claude/amp/codex/opencode | 32768 | 4000 or 32768 |
| `raw` | `text` | — | 32768 | 32768 |
| `status` | `text` | mail texts pre-truncated to 200 (`agent-proc.js:109,127,210`) | 32768 | varies |

`truncate` appends a literal `… [+N chars]` marker into the string (`src/util.js:135`) — a
viewer can detect truncation by suffix but **cannot recover the elided text**; it is never
written anywhere.

**Kinds, with every field and its writer:**

| kind | fields | written at |
|---|---|---|
| `meta` | `index`, `label`, `adapter`, `model`, `prompt` (≤4000) | `src/engine.js:919`, once per attempt |
| `text` | `text` | `src/agent-proc.js:442` (stream), `:280` (direct adapters) |
| `reasoning` | `text` | `src/agent-proc.js:443` |
| `tool` | `name`, `input` | `src/agent-proc.js:446`; also sets `job.lastTool` (`:445`) |
| `tool-result` | `name`, `output`, `isError` | `src/agent-proc.js:448` — **`name` is `undefined` for claude/amp/opencode/droid** (`protocols.js:52,151,240` emit no name); only codex (`:92`) and pi (`:214`) supply it |
| `mail-in` | `text` (full, untruncated) | `src/agent-proc.js:131` |
| `mail-out` | — | **NEVER WRITTEN.** Documented in the header comment (`src/transcript.js:2`) and in `ARCHITECTURE.md`, but `grep -rn "mail-out" src/` matches only that comment. Agent→operator `post` lands in `events.jsonl` only (G14) |
| `status` | `text` (free-form English) | 11 sites: `src/engine.js:918,980,993`; `src/agent-proc.js:109,121,127,186,197,210,377,391,480` |
| `raw` | `text` | `src/agent-proc.js:374` — any provider stdout line that failed `JSON.parse` |

**`status` is a free-text channel carrying machine-relevant facts with no structure.** The
complete vocabulary a viewer would have to string-match:
`'— resumed run: new attempt below —'`, `'completed'`, `'<failed|cancelled>: <msg>'`,
`'workflow mail replay-suppressed — …'` (two variants), `'mail dropped — agent already settled: …'`,
`'schema validation failed, requesting correction: …'`,
`'delivering N queued message(s) via follow-up turn'`,
`'mail DROPPED undelivered because …'`, `'parser exception (event skipped): …'`,
`'parser exception at EOF: …'`, `'error: <msg>'`.

**Not in the transcript at all:** usage. `handleEvent`'s `usage` branch
(`src/agent-proc.js:449-479`) journals and accumulates but writes nothing to the transcript
and emits no event.

### 1.4 `journal.jsonl` — and why a viewer must read it

Record types are documented at `src/journal.js:1-32` and parsed at `:99-161`. Every record
also carries `t` (`:54`).

| type | fields | safe/useful to surface? |
|---|---|---|
| `meta` | `runId`, `workflowFile` (**absolute path**), `fileHash`, `graphHash`, `graphDynamic`, `args`? , `seed`, `createdAt`, `keyVersion`, `defaults` (`{adapter,model,effort,cwd}`), `budgetTotal` (`src/engine.js:828`) | **Yes — the run-metadata event that `events.jsonl` lacks.** Caveat: `args` may contain secrets; `fileHash`/`graphHash`/`seed` are internal (show on a debug pane at most). Field is *absent* when no args were passed — presence is semantically distinct from `null` (`src/engine.js:798`, `src/cli.js:56`) |
| `started` | `key`, `index`, `label`, `adapter` | Redundant with the `running` event; useful as a cross-check |
| `session` | `key`, `sessionId` | Yes — provider thread id. Also exposed live over the socket. Mildly sensitive (a session id addresses a real provider conversation) |
| `usage-cum` | `key`, `cum: {input, output}` | **Yes — the only live token telemetry on disk.** Semantics differ per adapter: for codex it is the *provider thread's* cumulative totals; for every other adapter it is the *job's own running totals*, journaled once per usage event (`src/agent-proc.js:458` vs `:477`). A `{0,0}` record is a **reset marker**, not a data point (`:42,436,472`). No `cost` field ever |
| `mail` | `key`, `id` (uuid), `text`, `origin` (`'operator'`\|`'workflow'`), `seq`?, `sender`? (branch hash), `callsite`? (`file:line:col`) | Yes. `callsite` is the only place a **workflow source position** appears on disk — genuinely valuable for a UI |
| `mail-done` | `key`, `id`, `skipped`?, `dropped`? | Yes — lets a UI show delivered vs dropped steering. `dropped:true` = never reached the provider (`src/agent-proc.js:209`) |
| `result` | `key`, `index`, `status`, `result` (**full value**), `error`?, `usage: {input, output, cost}`, `durationMs`, `adapter`?, `model`? | **Yes — the richest per-agent record.** `adapter`/`model` are written on the completed path only (`src/engine.js:964`); the failure path omits them (`:992`). Full result value is here and nowhere else |
| `answer` | `qid`, `value` | Yes — the answer text `events.jsonl` omits |
| `end` | `status`, `error`? | Redundant with `result.json` |

**Mapping journal records to UI rows requires `key`.** Journal records are keyed by the
opaque agent key; `events.jsonl` agent events carry `key` on `running`/`cached`/`done`/`failed`
(but not `steered`). That join is the mechanism by which most "missing" telemetry is
viewer-reconstructible.

**Ordering caveat:** `Journal.load` applies last-wins for `results` (`src/journal.js:143`),
which is deliberate — a resumed key's later record supersedes the earlier one. A viewer
showing attempt history must read the raw records, not the folded map.

### 1.5 `result.json`

Written tmp+rename so a reader never sees a partial file (`src/engine.js:640-642`).

```jsonc
{ "runId": "flo_ab12cd34", "status": "completed", "result": <any JSON> }
{ "runId": "...", "status": "failed" | "interrupted", "error": "..." }
```

`status ∈ {completed, failed, interrupted}` (`src/run-state.js:9`). MCP writes a fourth
shape on detached-spawn failure — same fields, `status: 'failed'` (`src/mcp.js:57`).
**Deleted at the start of a resume** (`src/engine.js:823`), which is why the `.resuming`
marker and `run.lock` exist.

### 1.6 `.heartbeat`, `run.lock`, `.resuming`, `run.log`

- **`.heartbeat`** — a bare decimal epoch-ms string, rewritten every 5s
  (`src/engine.js:832`) plus once immediately (`:834`). Staleness threshold is **15s**
  (`src/run-state.js:6`), not 5s. It proves the *engine's event loop* is alive; it says
  nothing about any agent (G25). It is never deleted, so a crashed run leaves a stale one
  forever.
- **`run.lock`** — `{"pid":N,"startedAt":epochMs}` (`src/engine.js:52`). Written `wx`
  (exclusive create). Released only if the pid still matches (`:55-56`). A viewer must not
  interpret this itself — `deriveRunState` already does, including pid-liveness with the
  EPERM caveat (`src/run-state.js:13-14`).
- **`.resuming`** — bare epoch-ms string, tmp+renamed by the launcher
  (`src/cli.js:121-123`, `src/mcp.js:138-140`), re-stamped by the engine after socket bind
  (`src/engine.js:751`), unlinked at the ownership point (`:822`). 30s budget
  (`src/run-state.js:8`). **Reading it has side effects**: `resumeIsStarting` renames aged
  markers away and unlinks aged claim files (`src/run-state.js:99,110,47`). This is fine —
  it is the sanctioned reader — but it means a viewer polling `deriveRunState` in a tight
  loop is doing filesystem mutations, and must not run as a different user than the engine.
- **`run.log`** — raw stdout+stderr of a detached engine, `O_APPEND`
  (`src/cli.js:114`, `src/mcp.js:48`). Not JSONL. Exists only for detached runs. Because
  detached runs are `--quiet`, it normally contains only crash output — which is exactly
  when it matters. Note `detachRun` never closes its fd (`src/cli.js:114`) whereas
  `launchDetached` does (`src/mcp.js:54`); harmless for a viewer.

---

## 2. Control-socket protocol

Server: `serveControl(sockPath, handle)` (`src/control.js:69`), handler at
`src/engine.js:680-726`. Client: `controlRequest(sockPath, req, timeoutMs = 5000)`
(`src/control.js:156`).

**Framing.** Newline-delimited JSON, one object per line, both directions
(`src/control.js:89`, `:162`). The client always sends `id: 1` (`:162`); the server echoes
`{id: req.id, ...res}` (`:89`).

**Requests and responses:**

| `cmd` | request fields | success response | error response |
|---|---|---|---|
| `status` | — | `{ok:true, runId, state:'running', agents:[{index,label,adapter,model,lastTool,queuedMail,sessionId}], questions:[{qid,question}], spentOutputTokens}` (`engine.js:685-691`) | — (never fails) |
| `send` | `agent` (index or label), `message` | `{ok:true, delivery}` (`:698`) | `{error:'no live agent "X" (use \`flowition status\` for indices/labels)'}` (`:694`) |
| `answer` | `qid`, `value` | `{ok:true}` (`:707`) | `{error:'no pending question "X"'}` (`:702`) |
| `cancel` | `agent`? | `{ok:true, cancelled:<index>}` or `{ok:true, cancelled:'run'}` (`:713,717`) | `{error:'no live agent "X"'}` (`:712`) |
| `post` | `agent`?, `message` | `{ok:true}` (`:721`) | — (never fails) |
| anything else | — | — | `{error:'unknown command "X"'}` (`:724`) |

A throw inside `handle` becomes `{error: String(err.message)}` (`src/control.js:88`).

**Send verdict vocabulary.** `AgentJob.send` returns (`src/agent-proc.js:75-143`):

| verdict | meaning | reachable over the socket? |
|---|---|---|
| `live` | injected into the running process's stdin now (`:133`), or handed to a direct adapter's waiting `waitMail()` (`:139`) | ✔ |
| `queued` | will ride a session-resume follow-up turn (`:141`) | ✔ |
| `dropped` | the agent already settled — no turn left to consume it (`:126-129`) | ✔ |
| `replayed` | crash-resume suppression against the delivered/restored multisets (`:117,121`) | ✘ — gated on `origin === 'workflow'` (`:99`); operator sends never see it |
| `pending` | queued on a `spawn()` handle before the job was admitted (`src/engine.js:1056`) | ✘ — workflow-side only |

`sendTo()` additionally returns `false` when no live job matches (`src/engine.js:1128`).
Target resolution is by numeric index first, then label (`src/engine.js:670-674`); the
label map is **live-only and last-wins** (`:948`), so duplicate labels silently collide.

**Failure modes a viewer must handle:**

1. **Unparseable request line → no response at all.** `src/control.js:86` `return`s
   silently; the client hangs until its timeout. Never send anything but strict JSON.
2. **Socket absent / not listening** → `net.createConnection` errors (ENOENT/ECONNREFUSED)
   → `controlRequest` rejects. The CLI maps this to "run is not live"
   (`src/cli.js:61-63`); a viewer should do the same, not surface a raw errno.
3. **Idle timeout 30s** — `conn.setTimeout(IDLE_TIMEOUT_MS, () => conn.destroy())`
   (`src/control.js:9,82`). **A viewer cannot hold a long-lived control connection.**
4. **Request timeout** — default 5000ms (`:159`); `deriveRunState` uses 300ms
   (`src/run-state.js:7`); the liveness probe uses 250ms (`src/control.js:8`).
5. **Server-side close destroys all client connections** (`src/control.js:135`).
6. **Pipelining is unsafe with the shipped client.** `controlRequest` resolves on the
   *first* line received and ignores the echoed `id` (`src/control.js:164-167`). One
   connection per request. The server itself is fine with concurrent connections — a `Set`
   of clients, each with its own `LineSplitter` (`:76-80`).
7. **`LineSplitter` buffers unbounded** (`src/util.js:108-118`) — a hostile or huge message
   is a memory concern on both ends.

**Concurrency semantics.** The engine's handler is fully synchronous (returns plain
objects), so responses are FIFO per connection today. `serveControl` `await`s `handle(req)`
(`src/control.js:88`), so if the handler ever became async, out-of-order responses would be
possible and the `id` echo would matter. Treat `id` matching as required in any new client.

**Authentication: none.** Access control is entirely the 0700 run directory. See §6.

---

## 3. Run-state derivation

**Any viewer MUST reuse this. Exact import:**

```js
import { deriveRunState } from '<repo>/src/run-state.js'
const st = await deriveRunState(runDir(runId))   // runDir from src/util.js
```

`deriveRunState(runDirPath)` is `async` and returns
`{ state, result, live?, detail?, error?, heartbeatAt?, heartbeatAgeMs?, heartbeatError? }`
(`src/run-state.js:116-195`).

**States:** `running | starting | completed | failed | interrupted | corrupt-result | stale | unknown`.

**Decision order and why each signal exists:**

1. **`.resuming` fresh (<30s)** → probe the socket; `ok` → `running` with `live`, else
   `starting` (`:117-124`). *Why:* a detached resume has already deleted nothing yet, so
   the previous attempt's terminal `result.json` is still on disk and must not be trusted.
2. **`result.json` present or unparseable** → probe the socket (`running` if it answers),
   then check `run.lock` for a live pid (`running`, because the lock proves an engine owns
   the run even while its event loop is blocked in the synchronous module-graph scan), then
   `corrupt-result`, else the file's `status` (`:126-153`).
3. **No result** → read `.heartbeat`, probe the socket. Live socket **or** heartbeat age
   ≤15s → `running` (`:181`). Then `run.lock` live pid → `running` (`:186-187`). Then
   heartbeat present/erroring → `stale`. Then `journal.jsonl` exists → `stale` (an attempt
   started and died before its first heartbeat). Else `unknown` (`:188-194`).

Each signal covers a hole the others leave: the socket is richest but rides the event loop;
the lock is event-loop-independent but can be stale under pid reuse (documented residual,
`src/run-state.js:23-26`); the heartbeat resolves crashed runs; the journal-existence check
prevents `flowition result --wait` hanging forever on a run that never heartbeat.

**Cost.** Every call opens a unix socket with a 300ms timeout and does 3–6 `stat`/`read`
calls, and mutates aged `.resuming` markers. Listing 200 runs = 200 probes. `flowition runs`
does exactly that in parallel (`src/cli.js:201-208`) — a viewer should cache terminal states
(they cannot change without a resume) and only re-derive non-terminal ones.

**Do not reimplement.** The `live` field returned on a hit already contains the full socket
`status` payload minus `id` (`:119`), so a viewer gets `lastTool`/`queuedMail`/`sessionId`/
`spentOutputTokens` from the same call.

---

## 4. What a viewer can show today, for free

Read-only, no engine change, from files + `deriveRunState` + one socket probe:

**Run list** — id, state, workflow basename (event) or absolute path (journal `meta`),
`createdAt`, terminal status and error, final result value, defaults (adapter/model/effort/cwd),
budget ceiling, args, key version, whether the module graph is resume-blocked
(`graphDynamic`), whether the journal was repaired.
*Caveat:* the shipped listing filters `startsWith('flo_')` (`src/cli.js:200`, `src/mcp.js:127`)
and therefore hides every `--run-id`-named run — a viewer should `readdir` unfiltered and
validate with `runDir()` (G19).

**Run timeline** — every `events.jsonl` record in byte order with millisecond stamps:
phases, logs, agent state transitions, questions/answers, mail in both directions.

**Per-agent card** — index, label, adapter, model, effort, prompt preview (160) and prompt
(4000, transcript `meta`), state, duration (completed only, from the event; failed/cancelled
from the journal `result`), output tokens (event), input tokens + cost (journal `result.usage`),
full result value (journal `result.result`), error message, provider session id (journal
`session`), attempt count (multiple journal `result` records for one key).

**Per-agent live token progress** — from journal `usage-cum` records joined on `key`,
honoring `{0,0}` as a reset. This is genuinely live: written on every provider usage event.

**Full transcript** — assistant text, reasoning/thinking, tool calls with inputs, tool
results with `isError`, inbound steering mail, engine status lines, raw unparsed provider
output. Live-tailable by byte offset exactly as `flowition tail` does
(`src/cli.js:275-304`).

**Live steering surface (running runs)** — via one socket `status` call: live agent set,
each agent's `lastTool`, queued-mail depth, session id; pending `ask()` questions with text;
run-level `spentOutputTokens`.

**Steering history** — from the journal: every accepted message with origin, sender branch,
**workflow source callsite `file:line:col`**, per-callsite ordinal, and whether it was
delivered, dropped, or replay-suppressed.

**Budget** — `budgetTotal` (journal `meta`) vs spend (socket for live runs; recomputed from
journal `result.usage` + `usage-cum` chaining for terminal ones).

**Mutations** (with the safety design of §6) — `send`, `answer`, `cancel` (agent or run) over
the socket; `resume` by spawning `flowition resume <id> --json` detached, exactly as
`src/mcp.js:141` does.

That is already a superset of the prior-art viewer recon'd, which serves four read-only
endpoints (`/api/runs`, `/api/runs/:id`, `/api/runs/:id/stream`,
`/api/runs/:id/agents/:n[/stream]`) and no control surface at all.

---

## 5. GAPS

**27 gaps.** Each is classified **VIEWER-RECONSTRUCTIBLE** (a viewer can compute it from
what is already on disk, so old runs work too) or **NEEDS ENGINE EMISSION** (no amount of
viewer cleverness recovers it).

Blast-radius vocabulary used below:
- *events-only* — adds/extends `events.jsonl` records. Does not touch resume keys, the
  journal, or determinism. Old `renderEvent` returns `null` for unknown agent states
  (`src/events.js:36`) and ignores unknown event types (`:41`), so old CLIs degrade
  silently rather than crashing.
- *transcript-only* — adds fields/kinds to `agents/<n>.jsonl`. No engine semantics.
- *journal* — touches `journal.jsonl`. **High scrutiny**: `Journal.load` switches on
  `e.type` and ignores unknown types (`src/journal.js:99-161`), so *new record types* are
  backward- and forward-compatible; *changed fields on existing types* are not.
- *keyed* — touches the `keyed` object at `src/engine.js:889`. **Breaks every existing
  run's resume** and requires a `KEY_VERSION` bump (`src/keys.js:9`). Avoid.

---

### G1 — Agent events carry no phase; phase events carry no index. **NEEDS ENGINE EMISSION.**

**Missing.** `phase()` emits `{type:'phase', title}` with nothing else
(`src/engine.js:1103`). `agent()` has no `phase` option — `AgentOptions` is
`adapter|model|mode|effort|system|schema|cwd|label|key|stallMs` (`index.d.ts:138-174`),
and the emitted agent event has no phase field (`:915`).

**Why it matters.** The phase → agent tree is the primary UI structure. Without it there is
no grouping, no per-phase progress, no per-phase cost rollup, no collapse/expand.

**Is the ordering heuristic sound?** *No.* Assigning each agent to the last `phase` event
before its `running` event is wrong in the common case, and provably so:

- The `running` event fires **after semaphore admission** (`src/engine.js:911-915`), not at
  `agent()` call time. With `concurrency: 8` and 30 queued agents, an agent *called* during
  phase A can emit `running` after `phase('B')` has already fired.
- `pipeline()` is explicitly barrier-free (`src/engine.js:1084-1101`): item 1 can be in
  stage 3 while item 2 is in stage 1. Any `phase()` call between stages is interleaved with
  agents from both.
- Fire-and-forget `spawn()` handles resolve long after the phase that created them
  (`src/engine.js:1022-1059`).
- Prior orchestrators' own doctrine tells authors to pass `opts.phase` *precisely
  because* the global `phase()` state races under fan-out. flowition has no such escape
  hatch — this is a capability regression against the stated bar.

**Minimal fix.** (a) Accept `o.phase` in `agentImpl` and include it on the `running`,
`cached`, `done`, `failed`, and `steered` agent events. (b) Fall back to the engine's
current global phase title when `o.phase` is absent, captured **at `agentImpl` entry**
(before `sem.with`), not at emit time. (c) Give `phase` events a monotonic `phaseIndex` so
repeated titles are distinguishable.

**Blast radius.** *events-only* — **provided** `phase` is excluded from the `keyed` object
at `src/engine.js:889`. It must be, or every existing run's resume breaks. Add
`index.d.ts` `AgentOptions.phase?: string`.

**Backward compatibility.** Old runs have no phase field; the viewer falls back to the
(unsound, clearly-labelled-as-approximate) ordering heuristic. New runs are exact. Old CLIs
reading new events are unaffected.

**Risk.** Low, with one trap: it is tempting to key on phase for "cache invalidation per
phase". Don't.

---

### G2 — No branch / parallel / pipeline structure. The UI cannot render the real DAG. **NEEDS ENGINE EMISSION.**

**Missing.** `parallel()` and `pipeline()` derive branch keys
(`src/engine.js:1069,1072,1083,1086,1089`) and stash them in an `AsyncLocalStorage` context
(`src/keys.js:10,22`), but **nothing about the branch reaches any file**. The agent event
carries `key` — which is `sha256(KEY_VERSION + branch + 'agent' + idx + prompt + spec)`
(`src/keys.js:28-31`), a **one-way hash**. The branch itself is
`sha256(KEY_VERSION + parentBranch + 'branch' + kind + index)` (`:24-26`), also one-way.

**Evaluated and rejected: exposing the existing keys.** Publishing the branch hash would let
a viewer group siblings (same branch prefix → same `parallel()` item) but **not** reconstruct
the tree: you cannot recover a parent hash from a child hash, and you cannot recover `kind`
or `index`. It buys sibling-grouping and nothing else. Not worth an engine change on its own.

**Why it matters.** Without it: no DAG view, no "these 5 agents were one `parallel()`", no
"agent 12 is stage 2 of item 7", no per-item pipeline lane, no fan-out width visualization.
This is the single largest differentiator available over a flat index-ordered agent list.

**Minimal fix.** Thread a **plain, human-readable path** alongside the hashed branch in the
key context. `makeCtx` already carries `branch`; add `path: []`. `deriveBranch` call sites
append `{kind:'parallel'|'pipeline', fanout:n}` then `{kind:'item', i}` then
`{kind:'stage', s}`. Emit `path` on the agent `running`/`cached` events, plus a `fanout`
event when `parallel()`/`pipeline()` starts, carrying the parent path, the kind, and the
item count.

**Blast radius.** *events-only* + a purely additive field on the in-memory ctx object. The
hashed `branch` computation is untouched, so resume keys are bit-identical. `makeCtx` is
called per item/stage already (`src/engine.js:1072,1089`), so there is a natural place to
build the path with zero extra allocation sites.

**Backward compatibility.** Old runs have no `path` → the viewer renders a flat list.
New runs render the DAG. Non-negotiable that the flat fallback stays
first-class.

**Risk.** Low-medium. The risk is scope creep — the path must stay a dumb array, not a
second key system. Test that `deriveBranch` outputs are unchanged before/after (the existing
resume tests already pin this).

---

### G3 — No run-level metadata event; `concurrency` and `meta.phases` are persisted nowhere. **MIXED.**

**Missing from `events.jsonl`.** The `run` start event carries only `runId`, `state`,
`file` (**basename**), `name` (`src/engine.js:1140`).

**Where the rest lives.** `journal.jsonl`'s `meta` record has `workflowFile` (absolute),
`args`, `seed`, `createdAt`, `keyVersion`, `defaults` (adapter/model/effort/cwd),
`budgetTotal`, `fileHash`, `graphHash`, `graphDynamic` (`src/engine.js:828`) →
**VIEWER-RECONSTRUCTIBLE**.

**Genuinely absent everywhere — NEEDS ENGINE EMISSION:**
- **`concurrency`.** Read from `opts` at `src/engine.js:807`, used to size the semaphore
  (`:852`), and **never written to any file**. A viewer cannot show "6 of 8 slots busy"
  even in principle, and cannot compute saturation for a finished run at all.
- **`meta.phases`** — the declared phase outline from the workflow module
  (`index.d.ts:126-132`). The engine reads `meta` (`src/engine.js:841`), passes it to the
  toolkit (`:1012`), uses `meta.name` in the run event — and drops `meta.phases`. A UI that
  wants to show "phase 2 of 5" or grey out not-yet-reached phases cannot.
- **Engine version.** Nothing records which flowition wrote the run.

**Minimal fix.** Extend the existing `run` start event (`src/engine.js:1140`) with
`concurrency`, `phases: meta.phases ?? null`, `workflowFile` (absolute), `cwd`,
`defaults`, `budgetTotal`, `version`. Everything is already in scope at that line.

**Blast radius.** *events-only*, additive fields on an existing event type. `foldEvents`
spreads run events (`src/events.js:50`) so it picks them up automatically.

**Backward compatibility.** Old runs: viewer falls back to journal `meta`; concurrency and
declared phases render as "unknown". Full.

**Risk.** Very low. Note `args` may contain secrets — the event stream is as sensitive as
the journal either way (§6).

---

### G4 — No input-token, cache-token, or cost telemetry in `events.jsonl`. **VIEWER-RECONSTRUCTIBLE.**

**Missing.** The `done` event carries only `outputTokens` (`src/engine.js:981`).
`failed`/`cancelled` carry no usage at all (`:994`) even though failed attempts *do* consume
tokens and *are* charged (`:988-990`).

**Where it lives.** Journal `result.usage = {input, output, cost}` (`:964,992`) for every
attempt including failures, plus `usage-cum` per usage event.

**Cache tokens are lost at the parser layer, permanently.** Every parser *folds* cache
tokens into `input` before emitting: claude/amp/droid sum
`input_tokens + cache_read_input_tokens + cache_creation_input_tokens`
(`protocols.js:62,247`); opencode sums `input + cache.read + cache.write` (`:158`); pi sums
`input + cacheRead + cacheWrite` (`:207`). Codex alone preserves `cachedInput` as a separate
field (`:102`) — and `handleEvent` then **ignores it** (`src/agent-proc.js:452-458`). So
cache-hit ratio, the single most useful cost-optimization metric a viewer could show, is
**not reconstructible for any adapter** and would need a parser + journal change.

**Minimal fix.** (a) Add `usage: job.usage` to the `done` and `failed`/`cancelled` events —
one word each. (b) Separately, if cache visibility is wanted: stop folding cache tokens in
the parsers, carry `cachedInput`/`cacheWrite` through `handleEvent`, and widen the journal
`result.usage` shape.

**Blast radius.** (a) is *events-only*, trivial. (b) touches all six parsers, `handleEvent`,
and the `usage-cum`/`result.usage` journal shapes — *journal*, and it changes what
`Journal.load`'s spend aggregation sums (`src/journal.js:146-157`). Do (a) now; treat (b) as
a separate, tested change.

**Backward compatibility.** (a) full — old runs fall back to the journal join. (b) needs
care: `usage-cum` records are read as `{input, output}` (`src/journal.js:110-112`) and
adding fields is safe, but any change to what `input` *means* would corrupt resume-time
budget accounting for in-flight runs.

**Risk.** (a) negligible. (b) medium — touches the money math.

---

### G5 — No per-agent live progress between `running` and `done`. **PARTLY RECONSTRUCTIBLE / NEEDS EMISSION for push.**

**Missing.** Between the `running` and `done` events there is **no `events.jsonl` activity
for an agent at all** — an agent can run for 30 minutes with the stream silent.

**What a viewer can do today.** Tail `agents/<index>.jsonl` (text/tool records give current
activity), join journal `usage-cum` on `key` for live token counts, and poll the socket for
`lastTool` (`src/engine.js:687`). All three work. So this is **reconstructible for content**
but requires the viewer to watch N+2 files per run and poll a socket.

**Why it still matters.** (a) A run-level timeline built only from `events.jsonl` shows dead
air. (b) `lastTool` is live-only — for a terminal run there is no "what was it doing when it
died" without parsing the whole transcript. (c) There is no *heartbeat per agent*, so the
UI cannot distinguish "thinking hard" from "hung" until the 30-minute stall watchdog fires
(`src/agent-proc.js:24,348`).

**Minimal fix.** A throttled `{type:'agent', state:'progress', index, key, tool, outputTokens, sinceMs}`
event emitted from `handleEvent` at most once every N seconds per agent.

**Blast radius.** *events-only*, but it **increases `events.jsonl` volume** — the one place
where a throttle is mandatory, not optional. `foldEvents` merges by index (`src/events.js:52`),
so progress events fold harmlessly.

**Backward compatibility.** Full; old runs simply show no progress rows. Old `renderEvent`
returns `null` for an unknown state (`src/events.js:36`), so `flowition tail` on a new run
under an old CLI stays clean.

**Risk.** Low. Watch the file-size interaction with G24.

---

### G6 — No queue-admission event: wait time and concurrency saturation are invisible. **NEEDS ENGINE EMISSION.**

**Missing.** `agentImpl` allocates the index (`src/engine.js:909`) and then enters
`sem.with` (`:911`); the `running` event is emitted **inside** (`:915`), and `t0` is
captured after that (`:949`). Nothing records the call-time moment. `Semaphore` tracks
`active` and `queue` (`src/semaphore.js:5-7`) and exposes neither.

**Why it matters.** Queue wait is often the dominant contributor to wall-clock in a
fan-out workflow, and it is exactly what the user can act on (raise `--concurrency`). A
Gantt view without it lies: agents look like they started when they were admitted. It also
compounds G1 — the phase heuristic is unsound *because* admission is delayed.

**Minimal fix.** Emit `{type:'agent', state:'queued', index, key, label, adapter, model}`
at `src/engine.js:910` (index is already allocated), and add `waitMs` to the `running`
event. Optionally include `{active, queued}` from the semaphore for a saturation sparkline.

**Blast radius.** *events-only*, plus two accessor properties on `Semaphore`.

**Backward compatibility.** Full. Old runs show no queued state; a viewer must treat
`running` as the earliest known moment. New agent-state string is ignored by old readers
(`src/events.js:36`).

**Risk.** Low. One correctness note: the event must be emitted **before** `sem.with`, and
the failure path (`aborted || finishing` at `:912` throws *inside* the semaphore, after the
queued event) must still produce a terminal event for that index — today it throws a
`WorkflowError` that propagates without emitting an agent event, so an agent could sit in
`queued` forever in the UI. Fix that at the same time.

---

### G7 — No tool-call ids: `tool` and `tool-result` cannot be correlated. **NEEDS ENGINE EMISSION.**

**Missing.** `Transcript` records `tool {name, input}` (`src/agent-proc.js:446`) and
`tool-result {name, output, isError}` (`:448`) with **no id on either**. Worse:
`tool-result.name` is `undefined` for claude, amp, opencode and droid — those parsers emit
no `name` (`protocols.js:52,151,240`).

**The ids exist upstream and are actively discarded.** The claude-stream parser reads
`b.type === 'tool_use'` and takes only `b.name` and `b.input`, dropping `b.id`
(`protocols.js:36`); the tool-result branch reads `b.type === 'tool_result'` and drops
`b.tool_use_id` (`:48-52`). Both are standard Anthropic stream-json fields.

**Why it matters.** Under parallel tool calls (Claude routinely issues several `tool_use`
blocks in one assistant message — the parser emits them in a loop, `protocols.js:32-37`),
positional pairing is simply wrong. A viewer cannot show a tool call collapsed with its
output, cannot compute a per-tool duration, cannot mark which call errored.

**Minimal fix.** Carry `id` on `{k:'tool'}` and `toolUseId` on `{k:'tool-result'}` in
`protocols.js` where the underlying protocol has them (claude-stream: yes; codex: emits both
halves from one `item.completed`, so synthesize an id from `it.id`; opencode: `part.id`; pi:
has `toolName` but no call id in `tool_execution_start`/`_end` — synthesize a per-agent
counter). Write them through `handleEvent` into the transcript.

**Blast radius.** *transcript-only* + parser changes. No engine semantics, no journal, no
keys. Parsers have a dedicated test file (`test/protocols.test.js`).

**Backward compatibility.** Full — old transcripts lack the field and the viewer falls back
to a stack-based positional pairing (correct for the single-tool-at-a-time case, explicitly
approximate otherwise).

**Risk.** Low. The only trap is synthesizing ids inconsistently across adapters; make the id
opaque and adapter-scoped, never cross-referenced outside one transcript.

---

### G8 — No tool durations. **NEEDS ENGINE EMISSION (and structurally impossible for codex).**

**Missing.** Neither `tool` nor `tool-result` carries a duration. With G7 fixed, a viewer
can compute `t(tool-result) − t(tool)` from the transcript timestamps — but only where the
two arrive separately.

**Structural limits.** Codex emits both halves from a single `item.completed` message
(`protocols.js:90-92`), so their `t` values are identical and the computed duration is
always 0. Opencode only emits tool events once `state.status` is `completed`/`error`
(`:149`) — same problem. So durations are *genuinely* available only for claude, amp,
droid, and pi.

**Minimal fix.** Where the upstream event carries a duration or start timestamp, pass it
through as an explicit `durationMs` on the `tool-result` record rather than inferring it, and
have the viewer show "duration unavailable" (not "0ms") for adapters that cannot supply one.

**Blast radius.** *transcript-only*.

**Backward compatibility.** Full.

**Risk.** Low. The real risk is a UI that renders 0ms bars for codex and quietly misleads.

---

### G9 — Budget spend is not in `events.jsonl`. **VIEWER-RECONSTRUCTIBLE (expensively).**

**Missing.** `usageTotal` is engine-internal (`src/engine.js:653`), exposed only as
`spentOutputTokens` on the socket `status` (`:690`). `budgetTotal` is journal-only (`:828`).
No event records spend at any point, including the moment a run dies from
`budget exceeded (N/M output tokens)` (`:913`) — that message surfaces only as the run's
terminal `error` string.

**Reconstruction.** Sum journal `result.usage.output` over completed and failed records
(`src/journal.js:146-151` shows the exact aggregation the engine itself does), plus the
crash-window delta from `usage-cum` chaining (`:170-174`). That is a full re-read of the
journal per refresh.

**Minimal fix.** With G4(a) done — `usage` on the `done`/`failed` events — a viewer can
accumulate spend incrementally from the event stream it is already tailing. That alone
closes this; a separate budget event is unnecessary.

**Blast radius.** Covered by G4(a). *events-only*.

**Backward compatibility.** Full.

**Risk.** Negligible. Note the documented semantics: the budget is a **pre-admission
advisory ceiling**, so overshoot is expected (`ARCHITECTURE.md:311-313`) — the UI must not
present it as a hard cap.

---

### G10 — No event sequence number; same-millisecond events are unordered. **VIEWER-RECONSTRUCTIBLE.**

**Missing.** Only `t` (`src/events.js:12`). Under fan-out, dozens of events share a
millisecond.

**Reconstruction.** Byte offset in `events.jsonl` is a perfect total order, since the file
is append-only single-writer (`src/util.js:28`) and the engine is one process holding the run
lock. A viewer that tails by offset (as `flowition tail` does, `src/cli.js:275-287`) gets it
free. **Do not sort by `t`.**

**Minimal fix (optional).** Add a monotonic `seq` in `EventSink` (`src/events.js:11-14`),
one counter field. Makes the ordering explicit in API responses instead of implicit in read
order.

**Blast radius.** *events-only*.

**Backward compatibility.** Full; viewer falls back to offset.

**Risk.** Negligible. Caveat: `seq` resets across resume (new engine process) — it orders
within an attempt, not across the run. Offsets remain the run-wide order.

---

### G11 — `foldEvents` leaks stale fields across state transitions. **VIEWER-SIDE (and an existing CLI bug).**

**The defect.** `foldEvents` merges agent events with a spread:
`snap.agents.set(ev.index, {...(prev||{}), ...ev})` (`src/events.js:52`). The `done` event
carries no `error` field (`src/engine.js:981`), so an `error` set by a previous `failed`
event **persists into the merged done state**.

**Concrete failure.** Agent 3 fails → run interrupted → `flowition resume` → agent 3 re-runs
and completes. `events.jsonl` holds `failed(error=…)`, then `running`, then `done`.
`flowition status` renders `[3] label adapter done 4.2s — <the old error>`
(`src/cli.js:238` prints `a.error` unconditionally), and `status --json` ships the same stale
field (`:227`). Same for `model`/`effort`, which are absent on `done`.

**Why it matters for the viewer.** Any viewer that reuses `foldEvents` inherits the bug and
will show green-with-an-error-message rows.

**Minimal fix.** Viewer-side: reset per-state fields on transition (clear `error` when
`state` becomes `running`/`done`/`cached`). Engine-side (optional, and a genuine CLI bug
worth fixing regardless): have `foldEvents` drop `error` on a non-failed state, or emit
`error: null` on `done`.

**Blast radius.** Viewer-side: none. Engine-side: `src/events.js` only; changes
`flowition status --json` output shape in a strictly-more-correct direction.

**Backward compatibility.** Full — it is a fold-time fix, so it corrects old runs too.

**Risk.** Negligible. Verify against `test/cli.test.js`.

---

### G12 — `question`/`answer` events carry thin context. **MOSTLY VIEWER-RECONSTRUCTIBLE.**

**Missing.** `question` = `{qid, question, runId}` (`src/engine.js:1119`); `answer` = `{qid}`
(`:705`). No answer value, no asking branch, no relationship to any agent, no indication of
whether the answer came from the socket or replayed from the journal on resume
(`:1115-1116` resolves replayed answers **without emitting any event at all** — so a resumed
run's UI shows the question as still pending unless it reads the journal).

**Reconstruction.** Journal `{type:'answer', qid, value}` (`:704`) gives both the value and
the fact that it was answered — including for replayed answers. The `qid`'s 16-hex suffix
(`:1110`) identifies the asking branch but is not resolvable to anything a user would
recognize.

**Minimal fix.** Include `value` on the `answer` event, and emit an
`{type:'answer', qid, replayed:true}` on the resume-replay path (`:1116`). With G2 done, add
the asking `path`.

**Blast radius.** *events-only*. Note the answer value is operator-authored free text and
may be sensitive — but it is already journaled in the same 0700 directory.

**Backward compatibility.** Full.

**Risk.** Low.

---

### G13 — `mail` events are inconsistent and uncorrelatable. **NEEDS ENGINE EMISSION.**

**Four separate defects** (all in `src/engine.js`):
1. **`agent` is a number for `dir:'in'` (`:697,1130`) and a string-or-null for `dir:'out'`**
   (`:720`, sourced from the `FLOWITION_AGENT_INDEX` env var via `src/cli.js:347`, passed
   through unvalidated). A viewer must coerce.
2. **`delivery` is present on `sendTo()` mail (`:1130`) but absent on control-socket mail
   (`:697`)** — even though the immediately preceding line (`:696`) has the verdict in hand.
3. **`sendTo()` emits no `steered` agent event**, while the control socket emits both a
   `steered` agent event and a `mail` event. The same logical action produces different
   event shapes depending on who initiated it.
4. **No mail id on any mail event.** The journal `mail`/`mail-done` records carry a uuid
   `id` (`src/agent-proc.js:130,132`), and the transcript writes `mail-in {text}` with no id
   (`:131`). So a viewer cannot join "this event" ↔ "this journal record" ↔ "this transcript
   line" except by text matching — which is ambiguous by construction, since identical
   steering text is exactly the case the replay logic is built around
   (`src/agent-proc.js:98-122`).

**Why it matters.** Steering is flowition's headline capability over prior orchestrators. A UI that
shows "you sent this; it was delivered live; the agent's next turn incorporated it" needs the
join. Right now it can show the send and the delivery separately and guess at the link.

**Minimal fix.** Return the mail id from `AgentJob.send` (or emit the mail event from inside
`send`), stamp `mailId` on the events and the transcript record, normalize `agent` to a
number (or `null`) at `:720`, add `delivery` at `:697`, and emit `steered` from `sendTo`.

**Blast radius.** *events-only* + *transcript-only*. `AgentJob.send`'s return value is part
of the public `SendVerdict` type (`index.d.ts:204-209`) — do **not** change it; emit the id
via a side channel or an out-param.

**Backward compatibility.** Full; old runs join by text and timestamp proximity with a
clearly-labelled approximation.

**Risk.** Low, but `AgentJob.send` is the most subtle function in the codebase (replay
suppression, ordinal tracking, at-least-once semantics). Touch its *emission*, never its
*control flow*, and lean on the existing mail tests (`test/mail-drop.test.js`,
`test/core-fixes.test.js`).

---

### G14 — `mail-out` transcript kind is documented but never written. **NEEDS ENGINE EMISSION (trivial).**

**Missing.** `src/transcript.js:2` and `ARCHITECTURE.md` both list `mail-out` as a transcript
kind. `grep -rn "mail-out" src/` matches **only that comment**. Agent→operator `post`
messages (`src/engine.js:719-722`) land in `events.jsonl` and nowhere else.

**Why it matters.** Reading one agent's transcript should show what that agent reported
upward. Today the agent's own progress reports are missing from its own transcript, so the
per-agent view is incomplete and the docs are wrong.

**Minimal fix.** In the `post` handler, resolve `req.agent` to a live job (`findJob`, already
defined at `:670`) and, when found, `job.transcript.write('mail-out', {text: message})`.

**Blast radius.** *transcript-only*, ~2 lines.

**Backward compatibility.** Full. Old transcripts simply lack the kind — which is already
the case for *all* transcripts today.

**Risk.** Negligible.

---

### G15 — No structured attempt boundary in transcripts across resume. **NEEDS ENGINE EMISSION.**

**Missing.** A resumed agent appends to its existing transcript, separated only by a
`status` record whose `text` is the literal string `'— resumed run: new attempt below —'`
(`src/engine.js:918`; the file is not truncated because `fresh: !resumedIndex`, `:917`).

**Why it matters.** A viewer that wants per-attempt tabs, or wants to show "attempt 2 of 3"
next to the journal's multiple `result` records for one key, has to string-match an English
sentence with an em-dash in it. Any wording change silently breaks it.

**Minimal fix.** Add an `attempt` integer to every transcript record (the engine knows it:
count prior journal `result` records for the key), or emit a structured
`{kind:'attempt', n, resumedFrom}` record.

**Blast radius.** *transcript-only*.

**Backward compatibility.** Old transcripts have no `attempt` → viewer falls back to the
sentinel string and, failing that, treats the file as one attempt.

**Risk.** Low.

---

### G16 — The full prompt is not on disk. **NEEDS ENGINE EMISSION.**

**Missing.** The prompt appears twice, truncated both times: `promptPreview` at 160 chars on
the `running` event (`src/engine.js:915`) and `prompt` at 4000 chars in the transcript `meta`
record (`:919`). The full string exists only in memory. `truncate` is not even applied here —
the engine hard-`slice`s, so there is no `… [+N chars]` marker and **no indication that
truncation occurred**.

**Why it matters.** Prompts in real workflows embed prior agents' full results and routinely
exceed 4000 characters; the useful content is often past the cut. A viewer that shows "the
exact instruction this agent received" — the single most-requested debugging affordance —
cannot.

**Minimal fix.** Drop the `.slice(0, 4000)` at `src/engine.js:919`. `Transcript.write` does
not truncate a field named `prompt` (`src/transcript.js:16-18`), so the full text lands. If
size is a concern, rename the field to `text` to inherit the 32768 cap plus its explicit
marker — an honest cap beats a silent one.

**Blast radius.** *transcript-only*; increases run-dir size (see G24/G18).

**Backward compatibility.** Full; old transcripts stay truncated and unmarked, so the viewer
should label the 4000-char boundary as "may be truncated" for old runs.

**Risk.** Low. Storage growth is the only real cost, and it argues for retention (G18).

---

### G17 — Failed/cancelled agents have no duration in the event stream. **VIEWER-RECONSTRUCTIBLE.**

**Missing.** The `failed`/`cancelled` event carries `index, key, label, adapter, state, error`
and no timing (`src/engine.js:994`), while the journal `result` record for the same attempt
does carry `durationMs` (`:992`).

**Why it matters.** A timeline that can only measure successes is a timeline that hides the
expensive failures — a 29-minute stall before the watchdog fires renders as a zero-width bar.

**Reconstruction.** Journal `result` joined on `key`. Or `t(failed event) − t(running event)`
from the stream, which additionally includes the retry (`:955-958` re-executes the same job
without emitting an intervening event), so it is arguably the *more* honest number.

**Minimal fix.** Add `durationMs` (and, with G4a, `usage`) to `:994`.

**Blast radius.** *events-only*, one field.

**Backward compatibility.** Full.

**Risk.** Negligible.

---

### G18 — Nothing prunes `~/.flowition/runs`. **NEEDS ENGINE/CLI CHANGE.**

**Missing.** There is no delete, prune, archive, or retention path anywhere. The only
`unlink` calls in the codebase target `scratch/` contents (`src/engine.js:759`),
`result.json` (`:823`), `.resuming` (`:822`), lock/claim files, and adapter temp files
(`src/agent-proc.js:419`). No CLI command removes a run (`src/cli.js:134-419`), and MCP has
none either.

**Why it matters.** Run dirs grow without bound: 32KB per transcript text record, unbounded
`events.jsonl` and `journal.jsonl` (`usage-cum` is journaled **once per provider usage
event**, `src/agent-proc.js:477` — deliberately, and it is a lot of lines). A viewer will be
the first surface where users *see* 400 accumulated runs and immediately want to delete
them. Shipping a viewer without a delete path makes the viewer the complaint magnet.

**Minimal fix.** A `flowition rm <runId>` / `flowition prune --older-than <d>` CLI command
that refuses to delete a run whose `deriveRunState` is `running` or `starting`, resolves the
path through `runDir()`, and deletes only within `runsDir()`. The viewer then calls the CLI
rather than implementing `rm -rf` itself.

**Blast radius.** New CLI surface; no engine semantics. **This is the one gap whose fix is
destructive**, so it needs its own tests: refuse-if-live, refuse-outside-runsDir, refuse
path-traversal ids (`runDir()` already covers the last).

**Backward compatibility.** Full.

**Risk.** Medium — it is the only proposed change that deletes user data. It also directly
governs whether the viewer may expose a delete button (see §6).

---

### G19 — `runs` listing hides every custom-`--run-id` run. **VIEWER-SIDE FIX (existing bug).**

**The defect.** Both listings filter `readdirSync(runsDir()).filter((d) => d.startsWith('flo_'))`
(`src/cli.js:200`, `src/mcp.js:127`). But run ids are user-supplied via `--run-id`
(`src/engine.js:617`, `src/cli.js:138`) and validated only against
`/^[A-Za-z0-9][A-Za-z0-9._-]*$/` (`src/util.js:17`). A run started as
`flowition run w.js --run-id nightly-audit` executes correctly, writes a full run dir, and is
**invisible** to `flowition runs`, `flowition_runs`, and any viewer that copies the filter.

**Minimal fix (viewer).** `readdir` unfiltered, keep entries that are directories, validate
each with `runDir()` in a try/catch, and require a `journal.jsonl` or `events.jsonl` inside.

**Blast radius.** Viewer-side: none. Fixing the CLI too is a one-line change with a
behavioral consequence (previously-hidden runs appear) — worth doing, worth a changelog line.

**Backward compatibility.** Full.

**Risk.** Negligible.

---

### G20 — No run index: listing N runs costs N journal reads + N socket probes. **VIEWER-RECONSTRUCTIBLE (with a cache).**

**Missing.** No summary file. `flowition runs` loads every journal in full just to get
`meta.workflowFile` and `meta.createdAt` (`src/cli.js:205-207`), then calls `deriveRunState`
per run (`:206`), each doing a 300ms-timeout socket probe.

**Why it matters.** A viewer's landing page is the run list. `Journal.load` on a long run
parses tens of thousands of `usage-cum` lines to extract one `meta` record on line 1.

**Reconstruction.** (a) The `meta` record is always the **first** journal line
(`src/engine.js:828`, written before anything else) — read only until the first `\n` instead
of the whole file. (b) Cache by `(path, mtime, size)`. (c) Terminal states are immutable
absent a resume, so skip the probe when `result.json` exists and no `.resuming` marker does.
These three make the list cheap without any engine change.

**Minimal fix (optional).** Write a `summary.json` at `finalize`. Not required; the read
optimizations above are enough, and an extra file is another thing to keep consistent.

**Blast radius.** Viewer-side: none.

**Risk.** Negligible. Prefer the viewer-side optimization over new engine state.

---

### G21 — The control socket is poll-only; no subscribe/push, 30s idle kill. **NEEDS ENGINE EMISSION (for push).**

**Missing.** `serveControl`'s protocol is strictly request→response (`src/control.js:83-90`),
and connections are destroyed after 30s idle (`:9,82`). There is no `subscribe`. The socket
is the *only* source of `lastTool`, `queuedMail`, and live `spentOutputTokens`
(`src/engine.js:687-690`).

**Why it matters.** A live UI wanting sub-second `lastTool` updates must poll a unix socket
per run per interval, opening a fresh connection each time (per §2 note 6). Meanwhile the
file-based signals (events, transcripts) are naturally push-able via watch/tail. The result
is two different freshness models in one UI.

**Minimal fix.** Prefer G5 (a throttled `progress` event in `events.jsonl`) over adding
push to the socket: it makes the file stream authoritative, keeps the control socket a
pure command channel, and works for terminal runs too — which a socket never does. Only if
sub-second latency is genuinely required should a `subscribe` command be added, and that is
a structural change to `serveControl`'s one-response-per-line contract.

**Blast radius.** G5 route: *events-only*. Subscribe route: `src/control.js` protocol change
+ client changes — a real redesign.

**Backward compatibility.** G5 route: full.

**Risk.** Low if G5; medium-high if subscribe.

---

### G22 — No file/artifact events: the UI cannot show what a run changed. **NOT RECONSTRUCTIBLE reliably.**

**Missing.** Nothing records files written, commands run, or repos touched. The only trace
is inside `tool`/`tool-result` transcript records, whose `input` is an adapter-specific JSON
blob truncated to **2000 chars** for four of six adapters (`protocols.js:93,150,237,213`).

**Why it matters.** "What did this run actually do to my code" is the question an
orchestration viewer most wants to answer, and the one no prior-art viewer answers. It is
the strongest differentiation opportunity — and the hardest.

**Assessment.** Per-adapter tool-input parsing is lossy (truncation), fragile (six schemas,
each versioned by an external vendor), and incomplete (a `bash` tool call hides arbitrary
writes). A robust answer is out of band: run a `git status`/`git diff --stat` against each
agent's `cwd` at agent start and end and emit the delta. That is a real feature, not a
telemetry tweak.

**Minimal fix.** Explicitly defer. If pursued: an opt-in `{type:'artifacts', index, cwd, files:[…]}`
event computed from a git diff at agent completion, gated behind a flag, with a hard cap on
list size.

**Blast radius.** *events-only*, but it introduces a subprocess (`git`) into the engine's
completion path — which currently spawns nothing but adapter CLIs. That is a meaningful
change to the engine's dependency surface. Argue it separately.

**Risk.** Medium-high. Do not smuggle this in with the telemetry work.

---

### G23 — `log` events have no level, no agent, no code. **VIEWER-SIDE (partly).**

**Missing.** `{type:'log', message}` only (`src/engine.js:1104`). Engine-internal notices —
abort reason (`:665`), retry (`:956`), telemetry error (`:983`), dropped spawn mail (`:1042`),
journal repair (`:830`) — are indistinguishable from workflow-authored `log()` calls, and
agent-scoped ones embed the index in English (`agent [3] retrying after: …`).

**Why it matters.** A viewer wants engine diagnostics in a diagnostics lane and workflow
narration in the timeline, and wants agent-scoped logs on the agent's card.

**Reconstruction.** Regex the known engine strings. Brittle but bounded — there are exactly
five.

**Minimal fix.** Add `level: 'info'|'warn'|'error'`, `source: 'workflow'|'engine'`, and an
optional `index` to the engine-internal call sites. `log()` keeps emitting bare workflow
logs.

**Blast radius.** *events-only*, additive.

**Backward compatibility.** Full; old runs default to `workflow`/`info`.

**Risk.** Negligible.

---

### G24 — `events.jsonl` and `journal.jsonl` are unbounded and unrotated. **NEEDS ENGINE CHANGE.**

**Missing.** Both files append forever (`src/util.js:28`). `usage-cum` is journaled once per
provider usage event for non-codex adapters (`src/agent-proc.js:477`, a deliberate and
documented volume tradeoff, `ARCHITECTURE.md:299-303`). Transcripts append 32KB-capped text
records with no cap on record count.

**Why it matters.** A viewer that loads a run does a full-file parse. A long-running
workflow's journal can reach hundreds of MB; the browser tab, not the engine, is where that
becomes visible. G5 (progress events) would add to `events.jsonl` specifically.

**Minimal fix.** Do **not** rotate the journal — resume correctness depends on the complete
record. For `events.jsonl`: throttle any new high-frequency event (G5) at the source, and
have the viewer stream by byte range with pagination rather than parsing whole files.
Rotation is the wrong tool here.

**Blast radius.** Viewer-side design constraint, primarily.

**Risk.** Low, but it constrains G5's design — decide the throttle before shipping progress
events.

---

### G25 — The heartbeat proves engine liveness, not agent liveness. **NEEDS ENGINE EMISSION.**

**Missing.** `.heartbeat` is a single run-level 5s ping (`src/engine.js:832`) with a 15s
staleness threshold (`src/run-state.js:6`). Per-agent liveness has exactly one mechanism: the
stall watchdog, default **30 minutes** (`src/agent-proc.js:24`), reset on every provider
output line (`:346-351,372`). Between output lines nothing reports.

**Why it matters.** "Engine healthy, agent 4 silent for 22 minutes" is precisely the state an
operator needs to see, and precisely the one the UI cannot distinguish from "agent 4 working
hard". `ARCHITECTURE.md:421` names the stall watchdog as the *only* turn timeout — so a UI
warning at, say, 50% of `stallMs` is the natural affordance and there is no data for it.

**Minimal fix.** G5's throttled progress event with `sinceLastOutputMs` closes this exactly.
Alternatively expose `lastOutputAt` per agent in the socket `status` payload
(`src/engine.js:687`) — one field, since `resetStall` already knows the moment.

**Blast radius.** *events-only* (G5) or socket-payload-additive.

**Backward compatibility.** Full.

**Risk.** Low.

---

### G26 — `adapter`/`model` are absent on `done`/`failed` events. **VIEWER-RECONSTRUCTIBLE.**

**Missing.** `model` appears on `running` (`src/engine.js:915`) and `cached` (`:906`) but not
`done` (`:981`) or `failed` (`:994`). `adapter` is on all four.

**Why it matters.** Only if a consumer reads a single event in isolation — e.g. an SSE
client that joined mid-stream, or a webhook. Anything that folds the stream is fine.

**Reconstruction.** Fold by index (`src/events.js:52`), or join journal `result.adapter`/`.model`
— but note the journal writes those only on the **completed** path (`:964`), not the failed one
(`:992`).

**Minimal fix.** Add `model` to `:981` and `:994`; add `adapter`/`model` to the journal
failure record at `:992`.

**Blast radius.** *events-only*; the journal part is *journal* but purely additive fields on
an existing record type, which `Journal.load` ignores unless read (`src/journal.js:142-158`).

**Backward compatibility.** Full.

**Risk.** Negligible.

---

### G27 — `AgentError.code` is discarded; failures are message strings only. **NEEDS ENGINE EMISSION.**

**Missing.** `AgentError` carries a structured `code` (`src/agent-proc.js:16-22`), and the
engine has it in hand at the failure site — it even branches on it to choose
`cancelled` vs `failed` (`src/engine.js:991`) and re-wraps it into `AgentFailed`
(`:996`). But both the event (`:994`) and the journal record (`:992`) store only
`String(err.message)`.

**The vocabulary being thrown away:** `spawn_failed`, `stalled`, `provider_error`,
`truncated`, `no_result`, `schema_invalid`, `cancelled` (`src/agent-proc.js:191,279,386,395,396,400,406,410,412`),
plus the `retryable` boolean (`:20`) that decides whether the engine silently retries
(`src/engine.js:955`).

**Why it matters.** A viewer that groups failures ("3 agents stalled, 1 schema-invalid, 1
CLI not installed") is dramatically more useful than one showing five different English
sentences. `spawn_failed` in particular means "the CLI isn't installed" — an actionable,
one-click-fixable condition (`flowition doctor`) that deserves distinct UI treatment, not a
generic red row.

**Minimal fix.** Add `code: err.code ?? null` and `retryable: !!err.retryable` to the agent
failure event (`:994`) and the journal failure record (`:992`).

**Blast radius.** *events-only* + additive journal fields on an existing type.

**Backward compatibility.** Full; old runs fall back to substring matching on the message
(which is stable enough for the five distinct prefixes, but should be labelled a heuristic).

**Risk.** Negligible.

---

### 5b. Backward-compatibility classification (hard requirement: the viewer degrades gracefully on old runs)

| Gap | Class | Fix blast radius | Old runs degrade to |
|---|---|---|---|
| G1 phase↔agent | **needs emission** | events-only (must stay out of `keyed`) | unsound ordering heuristic, labelled approximate |
| G2 DAG/branch path | **needs emission** | events-only | flat agent list (parity floor) |
| G3 run metadata | mixed | events-only | journal `meta`; concurrency + declared phases unknown |
| G4 input/cost tokens | reconstructible (cache tokens: **not**) | events-only / parser+journal | journal `result.usage` join |
| G5 live progress | partly reconstructible | events-only (throttled) | transcript tail + `usage-cum` + socket poll |
| G6 queue admission | **needs emission** | events-only + semaphore accessors | `running` treated as start; no wait time |
| G7 tool ids | **needs emission** | transcript-only + parsers | positional pairing, wrong under parallel tools |
| G8 tool durations | **needs emission** | transcript-only | `t` delta where available; "unavailable" for codex/opencode |
| G9 budget spend | reconstructible | covered by G4a | journal aggregation per refresh |
| G10 event seq | reconstructible | events-only | byte offset ordering |
| G11 fold staleness | **viewer-side** | events.js fold fix (optional) | viewer clears fields on transition |
| G12 question/answer context | mostly reconstructible | events-only | journal `answer.value` |
| G13 mail correlation | **needs emission** | events + transcript | text+time proximity matching |
| G14 `mail-out` never written | **needs emission** | transcript-only (~2 lines) | posts visible in events only |
| G15 attempt boundary | **needs emission** | transcript-only | English sentinel string match |
| G16 full prompt | **needs emission** | transcript-only | 4000-char silent truncation |
| G17 failed duration | reconstructible | events-only | journal `result.durationMs` |
| G18 retention | **needs CLI change** | new destructive command | no delete affordance |
| G19 `flo_` prefix filter | **viewer-side** | one-line CLI fix | viewer readdirs unfiltered |
| G20 run index cost | reconstructible | none | first-line read + mtime cache |
| G21 socket push | **needs emission** (prefer G5) | events-only via G5 | polling |
| G22 artifacts | not reliably reconstructible | deferred; adds `git` subprocess | no artifact view |
| G23 log levels | partly reconstructible | events-only | regex five known strings |
| G24 unbounded files | **needs design** | throttle + viewer pagination | viewer paginates |
| G25 agent liveness | **needs emission** | events-only via G5 | no stall warning before 30min |
| G26 model on done/failed | reconstructible | events-only + journal field | fold by index |
| G27 error codes | **needs emission** | events-only + journal field | message substring heuristic |

**Recommended first engine change-set** (one PR, all *events-only*, no key/journal/determinism
impact, every item independently testable with the mock adapter): **G1, G2, G3, G6, G27**,
plus the one-field additions from **G4a, G17, G26**. Together these turn the event stream
into a self-sufficient UI feed — phase tree, DAG, saturation, per-agent economics, and a
failure taxonomy — without a single change to resume behavior. **G7/G8/G14/G15/G16** are a
second, transcript-only change-set. **G18** ships with the viewer's delete affordance or not
at all.

---

## 6. Security-relevant facts and what they imply for an HTTP server

### 6.1 What is actually in a run directory

- **Full agent transcripts** — every assistant message, every reasoning/thinking block,
  every tool call **input**, and every tool **output** (`src/agent-proc.js:442-448`). Tool
  output is whatever the agent read: `.env` files, private keys, `~/.aws/credentials`,
  database dumps, customer data. Agents run with `--dangerously-skip-permissions` /
  `--dangerously-bypass-approvals-and-sandbox` / `--skip-permissions-unsafe` / `--auto`
  (`src/adapters/index.js:40,215,239,262`; `README.md:284-289`), so there is no upper bound
  on what can appear.
- **Prompts** (`src/engine.js:919`) — which embed prior agents' full results.
- **`raw` records** — unparsed provider stdout (`src/agent-proc.js:374`), i.e. whatever the
  vendor CLI printed.
- **Provider session ids** (`src/journal.js` `session` records) — handles to real provider
  conversations.
- **`args`** (journal `meta`) — operator-supplied JSON, frequently containing tokens.
- **`workflowFile` absolute path, `cwd`, `defaults`** — filesystem layout disclosure.
- **`callsite`** on workflow mail — absolute source paths with line/column
  (`src/engine.js:576-587`).

### 6.2 The protection model today, and exactly how it is weaker than it looks

Access control is **directory permissions only**: `~/.flowition`, `runs/`, each run dir, and
`scratch/` are created 0700 (`src/util.js:26` + `src/engine.js:623`), with best-effort
`chmod` for legacy dirs (`:626-627`). The comment at `src/util.js:23-25` is explicit that
**directory perms are the whole mechanism** — "no traversal means the files inside are
unreachable". Individual files are created with the process umask; `appendJsonl` and
`Transcript` pass no mode (`src/util.js:28`, `src/transcript.js:12,19`), so they are
typically 0644. Only adapter temp files are explicitly 0600
(`src/adapters/index.js:222,244`).

**Implication:** the moment any process serves file *contents* over a channel that is not
the 0700 directory, the entire protection model is gone. There is no second layer.

### 6.3 Threat model for the viewer HTTP server

**Baseline principle: an HTTP listener is a strictly weaker boundary than a 0700 directory.**
A TCP listener on `127.0.0.1` is reachable by **every local user and every local process** on
a multi-user or shared-CI machine, whereas the run dir is reachable only by its owner. Binding
to loopback is therefore a *downgrade*, not a safeguard.

1. **Local-user exposure (highest-likelihood, lowest-effort attack).**
   *Mitigation:* prefer a **unix-domain socket** (`server.listen('/path/to.sock')`, chmod
   0600) as the default transport, with TCP as an explicit opt-in. Node's `http` server
   binds unix sockets natively — no dependency. If TCP is used, require a per-invocation
   bearer token printed to the launching terminal and carried in every request.
2. **DNS rebinding.** A malicious page can resolve its own hostname to `127.0.0.1` and issue
   same-origin requests to the local port. *Mitigation:* reject any request whose `Host`
   header is not exactly `127.0.0.1:<port>` / `localhost:<port>`. This must be checked
   before routing, on every request.
3. **CSRF on mutations.** Simple-request methods bypass preflight, so a page can drive
   `cancel`/`send` cross-origin unless blocked. *Mitigation:* mutations are `POST` only, must
   carry `Content-Type: application/json` (forces preflight), must carry the bearer token in
   a header (not a cookie — never use cookies), and must have an `Origin` matching the
   server's own. Reject `Origin: null`.
4. **XSS via transcript content.** Transcripts contain arbitrary model output, arbitrary
   tool output, and raw provider stdout. *Mitigation:* the API returns JSON only, never HTML;
   the SPA renders text nodes, never `innerHTML`/`dangerouslySetInnerHTML`; markdown/code
   rendering, if any, runs through a sanitizer with links and images disabled by default.
   Serve `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'`,
   `X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`.
5. **Path traversal.** Two surfaces: run ids (route every one through `runDir()`,
   `src/util.js:17-21` — it rejects separators and leading dots) and static asset paths
   (resolve, then verify the result is inside the asset root; reject `..`, NUL bytes, and
   absolute paths after decoding — decode exactly once).
6. **Control-socket bridging is a privilege bridge, and must be treated as such.** Anyone
   who can reach the socket can `cancel` a run and `send` **arbitrary text into an agent
   running with full permissions on the machine**. Steering text is an instruction to a
   process that can write files and execute commands. An HTTP endpoint that forwards to
   `send` is functionally a remote code execution surface for anyone who can reach the port.
   *Requirements:* mutations **off by default**, enabled by an explicit `--allow-control`
   flag; a distinct confirmation for `cancel`-the-run; message size limits; and every
   mutation logged to the run's own event stream (`post`/`mail` already do this) so an
   operator can audit what the viewer did.
7. **Never execute a workflow file.** `flowition_run` (MCP) launches arbitrary JS with full
   permissions (`src/mcp.js:90-99`). The viewer must **not** expose run-launch. `resume` is
   the only lifecycle mutation that is defensible, because it re-executes a workflow the
   operator already chose, pinned byte-for-byte by `fileHash`/`graphHash`
   (`src/engine.js:791-793`) — and even that should be opt-in, and should shell out to
   `flowition resume` detached (as `src/mcp.js:141` does) rather than calling `runWorkflow`
   in-process, so the viewer never holds a run lock.
8. **Deletion.** If a delete affordance ships (G18), it must go through a CLI command that
   refuses live runs and confines itself to `runsDir()` — not through filesystem code in the
   HTTP handler.
9. **Read-side side effects.** `deriveRunState` renames and unlinks aged `.resuming` markers
   (`src/run-state.js:99,110`). A viewer running as a different user than the engine will
   either fail or corrupt the launch-marker protocol. Document that the viewer must run as
   the run's owner; refuse to start otherwise (`fs.statSync(runsDir()).uid !== process.getuid()`).
10. **Logging.** The HTTP server must not log request bodies or response payloads — they
    carry transcript content by definition.

### 6.4 The zero-dependency constraint

`package.json` has no `dependencies` (`package.json:1-57`) and the README promises it
(`README.md:58`). The server must therefore be `node:http` + `node:fs` + `node:path` only —
entirely achievable: routing is a `switch` on `url.pathname`, JSON responses are
`JSON.stringify`, live tailing is byte-offset polling exactly as `src/cli.js:275-304` already
does (and polling, not `fs.watch`, is the right call for Node 18 anyway — recursive
`fs.watch` is unsupported on Linux before Node 20, which is exactly why prior art ships a
polling fallback).

**The prebuilt-asset tradeoff, argued explicitly.** A Vite/React/Tailwind toolchain in
`devDependencies` with `viewer/dist/**` committed and listed in `package.json#files` keeps the
*runtime* dependency count at zero — the published package ships static bytes, and `npm i -g
flowition` installs nothing extra. This is the proven prior-art packaging model. The costs are honest
and worth stating: (1) committed build output must be regenerated and reviewed on every UI
change, and a stale `dist/` silently ships old UI; (2) `npm pack` size grows by the bundle;
(3) contributors need the toolchain to change the UI, which raises the contribution bar on a
project that currently needs only Node. The alternative — hand-written ES modules served
directly, no build step — keeps the repo dependency-free end to end and is viable for a
focused viewer, at the cost of no component ecosystem and slower UI iteration. **Recommendation:
prebuilt assets via devDependencies, with a CI check that `viewer/dist` matches a fresh build**,
which neutralizes cost (1), the only one that can cause a silent defect.

### 6.5 Testability

Everything above is testable under `node scripts/test.mjs` with no credits: the mock adapter
produces real run dirs (`src/adapters/mock.js`), and `node:http` servers plus
`controlRequest` are directly drivable from `node:test`. Existing patterns to follow:
`test/control.test.js` (socket lifecycle), `test/cli.test.js` (run-dir fixtures),
`test/mcp.test.js` (JSON-RPC surface). Security assertions — Host rejection, Origin
rejection, traversal rejection, mutations-off-by-default — belong in that suite as
first-class tests, not as manual checks.

---

## 7. Appendix — the exact imports a viewer must reuse

```js
import { deriveRunState }            from '<repo>/src/run-state.js'  // NEVER reimplement (§3)
import { runDir, runsDir, readJsonl } from '<repo>/src/util.js'      // id validation choke point
import { foldEvents, renderEvent }   from '<repo>/src/events.js'     // fold: beware G11
import { Journal }                   from '<repo>/src/journal.js'    // load with repair:false; catch throws
import { controlRequest }            from '<repo>/src/control.js'    // one connection per request (§2)
```

Do **not** import `runWorkflow` (`src/engine.js:613`) into the viewer process: it acquires
the run lock, binds the control socket, and executes a workflow module.
