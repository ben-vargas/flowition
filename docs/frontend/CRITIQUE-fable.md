# CRITIQUE — DESIGN.md, implementability & correctness lens

Reviewer stance: I am the engineer handed this document at 2am with no author to ask.
Every claim about flowition below was checked against `src/` at `96362e7`; where the
document is wrong I cite the line that falsifies it. Anywhere I would have to guess is
recorded as a defect, because at 2am a guess ships.

Counts: **4 BLOCKER, 19 MAJOR, 14 MINOR** (37 findings).

---

## BLOCKER

### B1 — §7.1.4 CSP forbids the §9.9 anti-FOUC bootstrap and Vite's own output (parity #109)

**Defect.** §7.1.4 mandates `script-src 'self'` with no `'unsafe-inline'`, no nonce, and no
hash source. §9.9 mandates "pre-mount **inline script** reads `localStorage.theme` → no
wrong-theme flash (parity #109)". These are mutually exclusive: an inline `<script>` in
`index.html` is exactly what `script-src 'self'` blocks. Separately, Vite 6's default
`build.modulePreload.polyfill = true` injects an **inline** module-preload polyfill script
into the built `index.html`, so the shipped bundle violates the mandated CSP even if the
theme script is removed. `style-src 'self'` is a narrower problem than it looks — React
writes inline styles through CSSOM (`node.style[prop] = …`), which CSP does not govern, so
`@tanstack/react-virtual` and the Gantt survive — but it *does* block any `style=`
attribute present in `viewer/public/icons.svg` or `index.html`, which §3.5 leaves open.

**Consequence.** W8 ships, and either (a) the CSP header is quietly dropped to make the app
boot — silently deleting the §7.4 XSS defense that the whole "render hostile model output"
threat model rests on — or (b) the app boots with a flash of wrong theme and a console full
of CSP violations, and parity #109 fails the §12.1 gate. Both outcomes are discovered at
integration time, after both lanes have built against contradictory specs.

**Fix.** Pin all three of: (1) emit the theme bootstrap as a separate first-party asset
(`/boot-theme.js`) referenced with a render-blocking `<script src>` in `<head>` — it is
~10 lines and does not need to be inline; (2) set `build.modulePreload.polyfill: false` in
`vite.config.ts` (targets are evergreen local browsers) and add a CI assertion that
`viewer/dist/index.html` contains **zero** inline `<script>` and `<style>` elements;
(3) state that `icons.svg` and `index.html` must carry no `style=` attributes, and add that
to the W14 dist-hash check. Do not solve this with a nonce: nonces require per-response
HTML rewriting, which conflicts with §5.7's `index.html`-is-a-static-asset caching rule.

### B2 — §1.2 goal 1 / §12.1 gate 1: the 120-item parity floor is NOT cleared; ~20 items have no spec

**Defect.** Goal 1 and acceptance gate 1 both assert every item in the recon's 120-item
parity floor (now DESIGN §14.1) is
covered. Walking the list item by item against this document, the following are **not
specified anywhere in it**:

- **#2** — "a run directory that exists but has no events still appears in the list, with
  status `unknown`". §5.4.2 step 1 explicitly *excludes* dirs lacking both `journal.jsonl`
  and `events.jsonl`. That is precisely the state `detachRun` leaves between
  `ensureDir(runDir(runId), 0o700)` (`src/cli.js:113`) and the child's first journal
  append, and it is the exact case `deriveRunState`'s terminal `return {state:'unknown'}`
  (`src/run-state.js:194`) exists to serve. Also directly contradicts §5.4.3's own promise
  that an empty dir returns a valid skeleton (parity #7) — the detail route serves a run
  the list route hides.
- **#16** — "reads in bounded chunks and never allocates the whole unread region at once".
  §5.6.6 scenario 5 states replay is "exactly the gap" and §5.1 names the CLI loop as the
  model; that loop does `Buffer.allocUnsafe(size - readOffset)` (`src/cli.js:284`) — a
  single unbounded allocation. No chunk cap appears anywhere in §5.5/§5.6/§7.4 (the 1 MiB
  cap in §7.4 is per *line*, not per *read*).
- **#39, #41, #42, #43** — active-run marking, hide/restore-and-persist sidebar, narrow-
  viewport overlay drawer, drag-resizable sidebar split. The §2.2 IA has **no run sidebar
  at all**; Home is a separate route. These four are structurally unbuildable as written.
  §3.3's "cockpit rails collapse into drawers" is about the Inbox rail, not a run list.
- **#35** — `--open` "launches it in the platform browser (macOS/Windows/Linux)". The flag
  appears in §4.2's usage line and is described nowhere: no `open`/`start`/`xdg-open`
  dispatch, no behavior on failure, and §1.3 rules out Windows.
- **#50** — phase auto-collapse on clean completion, default-open for the selected agent,
  and an explicit user toggle that overrides both and survives prop changes. Zero spec.
  This is the single subtlest state-management item on the floor.
- **#93** — manual row expand/collapse overriding the automatic choice. §9.6 gives only the
  automatic rule ("expands iff single-item, contains a pending row, or is the live
  frontier"); the override precedence is unstated.
- **#47, #49, #51** — phases as a collapsible tree in declaration order; per-phase rolled-up
  status glyph + done/total; phase-less agents in their own section. §2.4 offers only a
  "group-by-phase toggle" on the Agents table with header rows.
- **#53** (last-tool column — `AgentView.lastTool` exists but is not a listed column),
  **#54** (failed agent's error message inline — only an "error code chip" is specified),
  **#60/#61** (cockpit no-agents-yet and snapshot-loading states — specified for Home only),
  **#73** (two-line command clamp; selection must not toggle), **#77** (per-argument
  `key: value` tool rendering, objects pretty-printed), **#78** (gradient-faded show-more on
  long tool headers), **#79/#80/#82** (per-file action verb + `+N -M`; diff line classes;
  explicit "no diff available"), **#96** (distinct error card below the transcript),
  **#107** (top/bottom fade affordances only when actually clipped).
- **#24** — the content-type map in §5.8 lists `html/js/css/json/svg/woff2/png/ico`; parity
  #24 also requires `woff`.
- **#28** — "supports … an ephemeral (0) port". §4.2 defines `--port N` and a 4646→4655
  collision walk; port `0` is never defined, yet §11.4 *requires* it ("start `startViewer`
  on an ephemeral port"). Port 0 and the collision walk are mutually incoherent.

**Consequence.** The document is billed as the authoritative build spec and says "where this
document is silent, the recon documents govern" — but for #39/#41/#42/#43 the recon and the
IA are in direct conflict, so "the recon governs" produces a screen the design doesn't have.
The other ~16 items become per-lane improvisation, which is exactly the two-competent-
implementers-build-different-things failure the brief asks me to hunt. And §12.1 gate 1 is
unpassable as literally written, so the gate will be waived, which is how parity floors rot.

**Fix.** Three concrete edits. (1) Amend §5.4.2 step 1 to keep any directory whose name
passes `runDir()`, and derive `state` from `deriveRunState` for dirs with no logs — that is
what `unknown` is for. (2) Either add a persistent, collapsible, resizable run rail to the
cockpit (satisfying #39/#41/#42/#43 directly), **or** add a §2.2 subsection that explicitly
retires those four items with the substitute affordance named (`Cmd+K` palette + a "runs"
back control) and amend the parity-floor catalogue to 116 items — silent substitution is not
allowed under gate 1. (3) Add a §2.5.1 "transcript card specifications" and a §2.4.1 "phase
grouping specification" covering #47/#49/#50/#51/#53/#54/#60/#61/#73/#77/#78/#79/#80/#82/
#93/#96/#107 with the same precision §9.6 already gives step grouping. Add `woff` to §5.8;
define `--port 0` (bind ephemeral, skip the collision walk, print the resolved port) and
`--open` (spawn `open`/`xdg-open`, never block, never fail the command).

### B3 — §5.4.2 "journal `meta` is always the first journal line … cached forever by path" is false

**Defect.** Two verified counter-examples in the engine:

1. **Meta is not always first.** When the control socket fails to bind and no journal exists,
   the engine appends `{type:'end', status:'failed', …}` as the run's *first* journal record
   (`src/engine.js:737`, inside the `control.ready` catch) — the `meta` append is at
   `src/engine.js:828`, ~90 lines later. Such a run's first line has no `runId`, `createdAt`,
   `defaults`, `args`, or `budgetTotal`.
2. **Meta is not unique, and a stale one can be first.** `runId = opts.resumeId ?? opts.runId
   ?? shortId('flo')` (`src/engine.js:617`) and the meta append is guarded only by
   `if (!prior)` (`src/engine.js:828`), where `prior` is set only for `opts.resumeId`.
   Nothing anywhere refuses `flowition run wf.js --run-id <id-that-already-ran>`. The second
   run appends a **second** `meta` to the end of the existing `journal.jsonl` while the first
   line still holds the first run's `createdAt`, `workflowFile`, `fileHash`, `args`, and
   `budgetTotal`. `Journal.load` is last-wins (`src/journal.js:100`); the design's first-line
   fast path is first-wins. The two disagree, permanently.

Compounding: "Cached forever by path" means a run dir deleted and recreated under the same
id (trivially reachable via `--run-id`, and E13's `flowition rm` makes it routine) serves the
dead run's metadata until the viewer process is restarted.

**Consequence.** Affected runs show the wrong name, wrong creation time (so wrong sort
position in the Home list), wrong budget ceiling in the §2.4 gauge, and wrong `args` behind
the §13-Q4 disclosure — with no invalidation path. P2's "zero journal parses" is built on
this fast path, so the cheap fix (parse the whole journal) also breaks the perf budget.

**Fix.** (a) Read the first line as a *hint*, and treat "first line is not `type:'meta'`" as
a miss that falls back to scanning forward for the first `meta` record, bounded to the first
64 KiB, with the result cached; if none is found in that window, cache `meta: null` and
render the run from events + `deriveRunState` only. (b) Key the meta cache on
`(path, journal.jsonl size, ino)` rather than path alone — ino change means recreation, and a
size change means a possible second meta; re-scan on mismatch and take the **last** `meta`
seen in that scan so the viewer agrees with `Journal.load`. (c) File an engine change (call
it E16) that refuses `--run-id` against a dir with an existing `journal.jsonl` unless
`--resume` is given; that is a one-line guard at `src/engine.js:617` and it removes the whole
class. Without (c), state explicitly which meta wins.

### B4 — §8 E4 specifies a `Semaphore` change that throws at construction

**Defect.** E4: "`Semaphore` gains `active`/`queued` getters (src/semaphore.js)." `Semaphore`
already assigns `this.active = 0` in its constructor (`src/semaphore.js:6`) and mutates it in
`acquire`/`release` (`:10`, `:17`). Class bodies are strict-mode: defining a getter-only
`active` on the prototype and then executing `this.active = 0` throws
`TypeError: Cannot set property active of #<Semaphore> which has only a getter`. Every run
dies at semaphore construction.

**Consequence.** W1 is assigned to the opus lane as "determinism-adjacent core"; the
implementer follows the spec literally, all 144 existing tests fail instantly, and the lane
burns time deciding whether the spec or the engine is wrong — on the one work unit the
document says must not be improvised on.

**Fix.** Rewrite E4 as: "`Semaphore` gains a `queued` getter returning `this.queue.length`.
`active` is already a public field (`src/semaphore.js:6`) — read it directly; do **not**
convert it to an accessor." Also specify who reads the gauge: the `sem:{active,queued,limit}`
payload must be sampled at the emit site in `agentImpl` **before** `sem.with` for the
`queued` event and **inside** the `sem.with` callback for `running`, because `release()` does
direct hand-off without decrementing (`src/semaphore.js:16`) and a sample taken elsewhere
reads a different instant.

---

## MAJOR

### M1 — §5.4.2 "a resume writes the marker" is false for foreground resume; the terminal cache goes stale for the entire preflight

**Defect.** The invalidation rule is: terminal runs skip `deriveRunState` entirely because
"a terminal state cannot change without a resume, and a resume writes the marker —
src/cli.js:120–123, src/mcp.js:137–140". Both cited sites are the **detached** paths:
`src/cli.js:120–123` is inside `detachRun()`, reached only under `--detach`; `src/mcp.js:137`
is `detachResume()`. The foreground paths — `flowition resume <id>` (`src/cli.js:174`) and
`flowition run <file> --resume <id>` (`src/cli.js:147`) — write **no** `.resuming` marker.
Meanwhile the engine unlinks `result.json` at `src/engine.js:822` and does not emit the
`run/resumed` event until `src/engine.js:1140`, which is after the module-graph hash, the
full resume preflight, and `await import()` of the workflow — work the source comments
themselves describe as able to block past a 300 ms probe (`src/run-state.js:22`,
`src/engine.js:148`-region comments).

**Consequence.** For the whole preflight window of every foreground resume, the Home list
serves a cached `completed` for a run that is live and whose `result.json` no longer exists.
Clicking through gives a "completed" header and a Result view that reports `pending`. The
one state the operator most needs to trust is wrong, and §12.1 gate 8's kill-9 walkthrough
will not catch it because that path goes through a *detached* resume.

**Fix.** Add `run.lock` to the terminal-cache invalidation key. Concretely: for a run cached
as terminal, `stat()` `run.lock` (one stat, already inside P2's budget) and re-derive when it
exists and its mtime is newer than the cached verdict — `acquireRunLock` (`src/engine.js:48`)
writes it before any journal read, so it is the earliest possible signal, earlier than both
the marker and the resumed event. Update §5.7's cache table row accordingly, and delete the
false claim from §5.4.2.

### M2 — §6.5 derives `Caps` from field presence, so every healthy new run shows "older engine" banners

**Defect.** §6.2's `Caps` are defined as "E1 fields seen", "E2 `path` seen", "E4", "E6" —
i.e. capability is inferred from having *observed* a field. §6.5 then drives user-visible
copy off it: "structure unavailable for runs recorded before v0.2", "recorded by an older
engine — queue wait unavailable", "recorded by flowition < 0.2".

**Consequence.** A brand-new run has emitted only `run/started` for its first seconds — no
agent events, hence no `path`, no `queued`, no `progress`. The Structure tab renders "this
run was recorded before v0.2" about a run recorded thirty milliseconds ago, and the Timeline
hides the saturation strip. A run that legitimately has zero agents shows all four banners
forever. E3 already adds `engine: <pkg version>` to the run-start event and the design never
uses it.

**Fix.** Derive `Caps` from `runEvent.engine` (semver-compare against the version that landed
each E-change), falling back to field-presence **only** when `engine` is absent — which is
exactly the true "old run" signal. Add a third state to every degraded panel: `supported`
(render), `unsupported` (render the older-engine note), `pending` (render an empty/loading
state, no note). Add a fold test asserting that a run with an `engine` field and zero agent
events reports `structure: true, queueEvents: true` and renders no older-engine copy.

### M3 — §5.6 never states whether `Last-Event-ID` or `?cursor=` wins on reconnect

**Defect.** §5.6.1 defines resumption via a `cursor` query param. §5.6.3 says "`id` is the
composite cursor **after** the batch. EventSource reconnect therefore resumes exactly."
EventSource replays the *original URL* on reconnect — including whatever `?cursor=` the
client first passed — and adds a `Last-Event-ID` header. Precedence is never stated.

**Consequence.** An implementer who honors `?cursor=` replays from the snapshot offset on
every single reconnect. On a run with a 200 MB events file and a flaky connection, that is a
full replay per reconnect, duplicated records in the client fold (the client's only
de-duplication is the §9.4 "cursor at-or-behind seen cursor → drop buffers" rule, which fires
*after* the duplicates have been folded), and P8's "zero duplicates" fails. The other
implementer honors the header and it works. This is the single highest-value ambiguity in
the document because both lanes touch it: W5 builds the server, W9 the client.

**Fix.** State normatively: **`Last-Event-ID`, when present and parseable, always wins over
`?cursor=`; `?cursor=` is used only on the initial connect.** Add to §11.2's
`viewer-stream.test.js`: a request carrying both a stale `?cursor=` and a fresh
`Last-Event-ID` must replay only from the header offset. Also specify what the server does
when `Last-Event-ID` is present but the composite cursor names a stream not in `?streams=`/
`?agents=` (answer: ignore that key, do not reset the others).

### M4 — §5.4.2 leaves "terminal" undefined for the state-cache, and P2's "≤2 stats/run" is false either way

**Defect.** `RunState` (§6.2) is `running|starting|completed|failed|interrupted|corrupt-result|
stale|unknown`. §5.4.2 says terminal runs skip `deriveRunState` and non-terminal runs
re-derive every 2 s, but never says which of those eight are terminal. `deriveRunState`'s own
`TERMINAL_STATUSES` (`src/run-state.js:9`) is `{completed, failed, interrupted}` — `stale`,
`unknown`, and `corrupt-result` are **not** terminal, and `stale` is the steady state of every
crashed run, which accumulate on a real machine.

**Consequence.** Treat `stale` as non-terminal (the correct reading — a resume revives it) and
every stale run re-derives every 2 s. One `deriveRunState` on a stale run costs: a
`readFileSync` of `.resuming` (ENOENT), a full `readdirSync` of the run dir
(`youngClaimIsStarting`, `src/run-state.js:39`), a `readFileSync` of `result.json` (ENOENT), an
`existsSync` on `control.sock`, a `readFileSync` of `.heartbeat`, a `readFileSync` of
`run.lock`, and a `net.createConnection` attempt with a 300 ms ceiling. That is ~7 syscalls
plus a socket attempt, not "≤2 stats/run", and the readdir is O(files-in-run-dir). At 5,000
runs of which 500 are stale, P2's ≤80 ms/request is not reachable. Treat `stale` as terminal
instead and a resumed run never flips — the exact bug parity #4 exists to prevent.

**Fix.** Define the cache tiers explicitly: `completed|failed|interrupted` = *settled* (skip
derivation, invalidate on run.lock/`.resuming`/events-mtime change per M1);
`stale|unknown|corrupt-result` = *quiescent* (re-derive on a 30 s TTL, not 2 s — nothing can
change them without a lock or marker appearing, both of which are cheap stats);
`running|starting` = *live* (2 s TTL). Restate P2 as "≤2 stats/run for settled runs, ≤8
syscalls/run for quiescent runs at a 30 s TTL" and put a 5,000-run fixture with 10% stale runs
in the P2 test — the current fixture spec says nothing about state mix, so it will be all-
completed and will pass while the real case fails.

### M5 — §6.4's fold has no resume-replay semantics for phases, logs, questions, or mail

**Defect.** §6.4 step 1 handles a `resumed` run event for the `run` object only (clears
`endedAt`/`error`). Step 2 says phase duplicates merge only when "consecutive duplicates (same
title, adjacent)". But a resume **re-executes the entire workflow from the top** — every
`phase()` (`src/engine.js:1103`), every `log()` (`:1104`), every `sendTo()` (`:1130`), and
every `ask()` that has no journaled answer re-emits. The replayed sequence is `A,B,C` followed
by `A,B,C`, which is not adjacent-duplicate.

**Consequence.** After one resume the Structure/Agents phase headers read
`Scan, Fix, Verify, Scan, Fix, Verify`; the §2.4 log lane doubles; `MailView` doubles, so the
Inbox "Steering history" shows every workflow steer twice; `PhaseView.agentIndices` splits an
agent's phase membership across two identical headers. Every resumed run — the marquee
flowition capability — renders wrong. Two implementers will pick different repairs (dedupe by
title? reset on resume? render per-attempt?) and the shared-fold seam between W6 and W9
diverges.

**Fix.** State the rule normatively in §6.4: on a `run` event with `state ∈ {started,
resumed}`, open a new **attempt scope** — `phases`, `logs`, `questions`, and `mail` are
accumulated per attempt; `RunDetail.phases/logs/mail` expose the **current** attempt, and the
lineage strip (§2.4) is the selector for earlier attempts. Agents are *not* scoped (they are
keyed by index and legitimately continue). Add three cases to
`test/viewer-fold.test.js`: resume-replays-phases yields 3 phases not 6; resume-replays-log
yields the current attempt's logs with prior attempts reachable; a `question` re-asked after
resume upserts rather than duplicating (`qid` is deterministic — `src/engine.js:1112`).

### M6 — §2.3/§6.2 `openQuestions` never accounts for a run that died with a question pending

**Defect.** `RunSummary.openQuestions` is folded from `question` events with no matching
`answer` event (§6.4 step 4). When a run aborts, the engine rejects pending questions
(`src/engine.js:667`, `q.reject`) and emits **no** `answer` event — `answer` events are only
emitted from the control-socket handler (`src/engine.js:705`) and, under E7, from the resume
replay path. Neither §6.4 nor the §6.4 step-8 post-pass zeroes `openQuestions` for a terminal
run.

**Consequence.** §2.3's attention strip — "the operator's work queue, not a list", the answer
to Q1, the product's headline claim — permanently accumulates dead runs presenting as
"blocked on you". Every failed run that used `ask()` becomes a phantom task. The strip becomes
noise within a week of real use, and the one thing the design claims a watch-only viewer
structurally cannot do stops working.

**Fix.** Move `openQuestions` into the §6.4 step-8 post-pass (it needs run state, exactly like
`displayState`): `openQuestions = terminalOrStale(runState) ? 0 : unanswered.length`, and give
`QuestionView` a third state `abandoned` so the cockpit Inbox can still show *what* it was
blocked on with the answer composer disabled. Add it to the §11.4 e2e: cancel a run with a
pending `ask()` and assert the run leaves the attention strip.

### M7 — the token's URL form is specified two incompatible ways and the router handles neither

**Defect.** §4.2 prints `http://127.0.0.1:4646/#t=<token>`. §4.3 prints
`view: <url>#/run/<runId>?t=<token>`. §7.1.2 says the token arrives "in the URL **fragment**"
and is scrubbed from the address bar. §9.2's `router.ts` is described only as "a 60-line hash
router (`useSyncExternalStore` on `hashchange`)" with three routes, none of which is `#t=…`,
and §2.2's route grammar has no `?t=` query on `#/run/:id`.

**Consequence.** `#t=<token>` is not a valid route under §2.2's grammar, so the router either
404s or falls through to Home while discarding the token — the operator lands on the "paste
token" screen after the CLI just handed them a working URL. The §4.3 form embeds the token in
the *route's* query string, which the same router must strip before matching `#/run/:id` or
every deep link misses. Two lanes (W4 prints, W8 routes) build against different grammars.

**Fix.** Pick one wire format and specify the parse order in §9.2: `#<route>?<params>` where
`t` is a reserved param stripped before route matching, so §4.2 prints
`http://127.0.0.1:4646/#/?t=<token>` and §4.3 prints `…/#/run/<runId>?t=<token>` — one grammar,
one strip. State that the token is written to `sessionStorage` and removed from the hash via
`history.replaceState` **before** the first route dispatch, and that a `t` param that fails
auth clears `sessionStorage` rather than looping.

### M8 — §5.6.5 forwards unbounded `result` records; nothing caps a single frame or names where the value lands

**Defect.** The journal feed forwards `result` records with "full result values". Journal
records are written by `appendJsonl` with **no truncation** (`src/util.js:28`,
`src/journal.js:54`) — unlike transcripts, which cap `text` at 32 KiB
(`src/transcript.js:16`). An agent returning a large structured object writes it verbatim.
§5.6.3's cap is "256 records or 64 KiB of JSON, whichever first", which bounds a *batch* of
small records but does nothing about one large one. Separately, §6.4.J says result records
supply "full-result" and §5.6.5 says the stream carries "full result values", but `AgentView`
(§6.2) has **no** field to hold a result value — only `resultPreview: string | null`.

**Consequence.** (a) A single 20 MB result record is read, JSON-stringified into an SSE frame,
and buffered by the client — P6's 64 MB heap budget dies on one frame, and §5.6.3's
backpressure pause does not help because the frame is already materialized server-side.
(b) The implementer has to invent where the full result goes: a new `AgentView.result` field?
A separate store? The compare-two-agents feature in §2.5 is the reason full results matter, so
the omission is load-bearing.

**Fix.** Cap the journal feed at 64 KiB per forwarded record: over the cap, forward
`{type:'result', key, index, status, usage, durationMs, truncated:true, resultBytes:N}` and
have the client fetch the full value on demand from a new
`GET /api/runs/:id/agents/:n/result` route (documented in §5.3, byte-ranged like §5.4.5). Add
`resultBytes: number | null` and `resultTruncated: boolean` to `AgentView`, and say explicitly
that `RunDetail` never inlines full result values.

### M9 — §5.4.7 search is an unbounded synchronous scan on a single-threaded server

**Defect.** "scanning at most 64 MiB per request" with no statement that the scan is chunked,
async, or time-bounded, and no concurrency limit on the route.

**Consequence.** `node:http` is one thread. A 64 MiB synchronous read+scan is ~200–600 ms of
uninterruptible blocking; two concurrent searches (one operator, two tabs — §13 Q6 explicitly
contemplates many tabs) is over a second. During that window every SSE keepalive is late,
every `sys/state` push is late, and the §4.4 idle-shutdown timer and the §5.5 1 s drain both
slip. P5's "zero dropped SSE frames" and the 15 s keepalive both become untrue under a
feature the design ships as a headline (Q9). A hostile transcript full of 1-byte lines makes
it worse.

**Fix.** Specify the scan as: `fs.createReadStream` with a 1 MiB chunk, `await` between
chunks, a hard 2 s wall-clock deadline that returns `{truncated:true}`, and a per-connection
limit of one in-flight search (a second returns `409 conflict`). Add a
`test/viewer-search.test.js` asserting an SSE keepalive still lands within 20 s while a search
runs against a 64 MiB fixture.

### M10 — §2.4's stall warning needs `stallMs`, which no event, journal record, or socket reply carries

**Defect.** Q2 and §2.4 specify: "a live agent whose last progress is older than 50% of its
`stallMs` gets an amber 'quiet for Nm' tag". `stallMs` is a per-agent option
(`src/engine.js:884`, `spec.stallMs`) defaulting to `DEFAULT_STALL_MS = 30 * 60_000`
(`src/agent-proc.js:24`) and used at `src/agent-proc.js:345`. It appears in **no** event, **no**
journal record, and **not** in the control `status` payload (`src/engine.js:687`). E1–E15 do
not add it.

**Consequence.** The implementer hardcodes 30 minutes. For a workflow that sets
`stallMs: 120_000` on a fast agent, the amber tag arrives 14 minutes after the agent was
already SIGKILLed (`src/agent-proc.js:348`). For one that sets `stallMs: 4 * 3600_000`, the tag
fires hourly on a perfectly healthy agent. Q2 — "is my run stuck, or just quiet?" — is one of
the two questions the design says the terminal answers worst, and it is answered with a
fabricated constant.

**Fix.** Add `stallMs` to E1's field list on the `running` agent event (it is known at
`src/engine.js:915`, one property, additive, outside `keyed`) and to `AgentView`. State the
UI rule against the emitted value with an explicit fallback: `stallMs ?? 1_800_000`, and label
the fallback tag "quiet for Nm (stall threshold unknown)" on old runs.

### M11 — §2.5's steer composer gate is ambiguous once E4 introduces `queued`, and every steer of a queued agent will fail

**Defect.** "Footer (only while the agent is live per the run fold)". The engine's `findJob`
(`src/engine.js:670`) resolves only against `live`, the map of jobs **inside** `sem.with`
(`src/engine.js:948`). E4 adds a `queued` state for agents that have an index and appear in the
UI but are not in `live`. "Live per the run fold" reads naturally as "not terminal", which
includes `queued`.

**Consequence.** The operator sees a queued agent in the Gantt, opens it, gets a composer,
types a steer, and receives `no live agent "3"` mapped to a `409` — a dead-end interaction on
the feature that is the design's entire thesis. Worse under `--concurrency 1`, where most
agents are queued most of the time.

**Fix.** State the gate as `state === 'running'` explicitly. For `queued`, render the composer
disabled with "agent hasn't started yet — steering opens when it runs" (and, since E4's `sem`
gauge is right there, show its queue position). Add it to the §7.2 UX table as its own row.

### M12 — §7.3 delete has a TOCTOU against a starting run and never consults `run.lock`

**Defect.** "refuse unless state ∈ {completed, failed, interrupted, stale, unknown,
corrupt-result} minus running/starting; `realpath` containment check under `runsDir()`;
`fs.rmSync(dir, {recursive:true})`." The state check and the `rmSync` are separated by at least
a `deriveRunState` await (which itself takes up to 300 ms on the socket probe). Nothing takes
the run lock. `stale` is deletable and is exactly the state a run sits in for the seconds
before a concurrently-launched resume writes its first heartbeat.

**Consequence.** Delete a `stale` run at the moment the operator (or a supervisor, or the
viewer's own Resume button in another tab) resumes it, and `rmSync` recursively removes
`journal.jsonl`, `control.sock`, and `run.lock` out from under a live engine mid-write. The
engine then writes a fresh `journal.jsonl` containing only post-deletion records, and its
resume-key replay silently re-runs completed, side-effecting agents — the precise failure the
strict journal loader's "treating it as absent history could silently re-run side-effecting
agents" comment (`src/util.js:48`) exists to prevent. This is the only irreversible operation
in the product and it is the least guarded.

**Fix.** `removeRun()` must acquire the run lock (reuse `acquireRunLock`, `src/engine.js:48`)
and delete only while holding it, releasing after; if the lock is held by a live pid, return
`409 conflict` regardless of derived state. Re-check `deriveRunState` **after** acquiring.
Add to `test/retention.test.js`: a test that spawns a resume and races a delete, asserting the
delete loses. Also state that `rmSync` is called on the `realpath`ed dir and that a run dir
which is a symlink is refused outright, not followed.

### M13 — §7.2's control-bridge timeout is unspecified, so a blocked engine holds HTTP connections for 5 s

**Defect.** The bridge calls `controlRequest(sock, …)`; the default timeout is 5000 ms
(`src/control.js:156`). The design specifies no override, and §5.2 maps "timeout →
`503 run_not_live`" without saying how long that takes. Meanwhile `deriveRunState` uses a
300 ms probe precisely because the engine's event loop can block (`src/run-state.js:7`, and the
comment at `:22`).

**Consequence.** An engine in synchronous preflight (the module-graph scan the source calls out
repeatedly) leaves each `send`/`answer`/`cancel` hanging for 5 s on a single-threaded server.
The §2.4 "Cancel run" modal appears frozen; the operator clicks again; two cancels queue.
Combined with M9 this is the second unbounded-blocking path on the request thread.

**Fix.** Specify per-command timeouts in §7.2's table: `status` 300 ms (matching
`CONTROL_TIMEOUT_MS`), `send`/`answer`/`cancel` 2000 ms, and state that a timeout returns
`503 run_not_live` with `retryAfterMs`. State that mutation buttons enter a pending state and
are disabled for the request's duration so a double-click cannot double-cancel.

### M14 — §9.3/P6: an 8 MiB *source-byte* transcript window does not fit a 64 MB heap budget

**Defect.** P6 budgets "≤ 64 MB JS heap regardless of file size", achieved by "8 MiB
source-byte window + virtualization + eviction". The window is measured in **source bytes of
JSONL**, but what lives in the heap is the parsed object graph plus React's fiber tree for the
mounted subset.

**Consequence.** JSONL parsed into JS objects typically expands 5–15× (per-object header,
per-string header, UTF-16 string storage doubling every ASCII byte). 8 MiB of source is
plausibly 40–120 MB of live objects before a single React element exists. P6 is not merely
tight, it is likely unreachable, and the mitigation (shrink the window) is a product
regression discovered in W13 — the last unit before release.

**Fix.** Either raise P6 to a measured number after a spike, or — better — bound the window by
**parsed record count** with a byte ceiling as a secondary guard (e.g. 20,000 records or
8 MiB, whichever first) and add a retained-size assertion to the W13 measurement rather than
"manual heap snapshot documented". State the eviction unit (whole fetched pages, not
individual records) so the §5.4.5 offsets stay contiguous.

### M15 — §8 E2's `path` cannot be assembled from the change described; three call sites must also change

**Defect.** E2 says "`makeCtx` carries a plain `path: PathSeg[]` alongside the hashed branch
(src/keys.js:16–18 gains a field)". `makeCtx(branchKey, runSeed)` (`src/keys.js:16`) receives
**no parent context**, so it cannot inherit a parent path. The three construction sites —
`rootCtx` (`src/keys.js:20`), `parallel`'s item ctx (`src/engine.js:1071`), and `pipeline`'s
per-stage ctx (`src/engine.js:1085`) — must each pass the parent's path explicitly, and
`pipeline` rebuilds a *fresh* ctx per stage from `itemBranch`, so the item segment must be
re-derived at each stage rather than inherited from the previous stage's ctx.

**Consequence.** An implementer following E2 literally adds a field that is always `[]` for
every nested case, and the Structure tab renders a flat list for exactly the workflows it
exists to visualize. Discovering this requires reading `makeCtx`'s call sites, which E2 does
not name.

**Fix.** Restate E2 with the signature change and all three call sites:
`makeCtx(branchKey, runSeed, path = [])`; `rootCtx` passes `[]`; `parallel` passes
`[...ctx.path, {kind:'parallel', n: fanoutOrdinal, fanout: thunks.length}, {kind:'item', i}]`
where `ctx` is captured **before** the `map` (`src/engine.js:1068`); `pipeline` passes
`[...ctx.path, {kind:'pipeline', n: fanoutOrdinal, fanout: items.length, stages: stages.length},
{kind:'item', i}, {kind:'stage', s}]`. State explicitly that a `pipeline` item whose stage
throws produces fewer `stage` segments than `stages` declares, and that the Structure DAG must
render the declared stage count with un-reached stages dimmed.

### M16 — §5.4.2's `createdAt` fallback to directory mtime produces unstable sort order

**Defect.** "Sort `createdAt` desc (journal meta; fallback dir mtime)". Directory mtime bumps
on every entry creation or removal inside it: `agents/` creation (`src/transcript.js:10`),
`.result.json.<pid>.tmp` create + rename (`src/engine.js:638–642`), `.resuming` marker
write/rename (`src/cli.js:120–123`), `control.sock` bind and unlink, and every
`.resuming.claim.*` the viewer's own `deriveRunState` creates and sweeps
(`src/run-state.js:98,110`).

**Consequence.** Any run whose meta is unreadable (B3's `end`-first case, a torn first line, a
corrupt journal) jumps to the top of the Home list every time anything touches it — including
every time the viewer polls it. With keyset pagination over `(createdAt, runId)`, an item whose
sort key changes between pages is skipped or duplicated across "Load more", which is a
correctness bug, not cosmetic.

**Fix.** Fall back to `birthtimeMs` (stable on APFS and ext4-with-crtime), then to the run
dir's `journal.jsonl` birthtime, then to `0`. Cache the resolved `createdAt` for the lifetime
of the process keyed on `(path, ino)` so it cannot change mid-pagination, and say so in §5.7.

### M17 — §4.1's startup ownership check has no ENOENT branch and fails on a fresh install

**Defect.** "refuse to start if `stat(runsDir()).uid !== process.getuid()`". On a machine
where no run has ever executed, `~/.flowition/runs` does not exist — `runsDir()` is only
created via `ensureDir` on the run path (`src/engine.js:622`, `src/cli.js:113`). No ENOENT
branch is specified.

**Consequence.** `flowition viewer` on a fresh install throws on `stat`. Worse, §4.3
auto-start spawns the viewer during the *first* `flowition run`, and the child's `stat` races
the parent's `ensureDir` — an intermittent, unreproducible "viewer didn't come up" that §4.3
correctly renders as silence (prints nothing), so it is invisible and unreportable.

**Fix.** Specify: ENOENT → `mkdirSync(runsDir(), {recursive:true, mode:0o700})` and proceed;
any other stat error → refuse with the error; uid mismatch → refuse with the documented
message. Also specify the check on `home()` rather than only `runsDir()`, since
`viewer.token` (§7.1.2) is written to `home()`, and add a test that the token file is created
0600 in a freshly-created home.

### M18 — §5.6.6 scenario 2 claims the CLI tail loop is "multibyte-safe" and shareable; it is neither bounded nor extracted

**Defect.** "Same algorithm as `flowition tail`'s proven loop (src/cli.js:272–304), factored
pure and shared." That loop reads the entire unread region in one `Buffer.allocUnsafe(size -
readOffset)` (`src/cli.js:284`) — see B2/#16 — and its `pending` carry-over is per-process, not
per-subscription. §4.5 lists `tail.js` as a new pure module but nothing in §12's work table
says `src/cli.js` is refactored onto it, so "shared" is aspirational and the two will drift.

**Consequence.** The bounded-chunk parity item is lost (B2), and the claim of a "proven"
algorithm gives the W5 implementer false confidence to copy a loop that is only safe because
`flowition tail` polls every 400 ms against a file it has been following since offset 0.

**Fix.** Specify `tail.js` independently: `readChunk(fd, offset, max = 1 MiB) → {bytes,
nextOffset, eof}`, a per-subscription `pending: Buffer` carry, a per-line 1 MiB cap that skips
and counts oversize lines, and a drain loop that yields to the event loop between chunks.
Either add "refactor `src/cli.js` tail onto `src/viewer/tail.js`" to W5's file list — with the
existing tail tests as the regression net — or drop the word "shared".

### M19 — §2.4's budget gauge does not say which number it plots, and the wrong choice is plausible

**Defect.** "the **budget gauge** — a horizontal bar: spent vs `budgetTotal`". `RunSummary.spend`
is `{input, output, cost}`. The engine's budget is checked as
`usageTotal.output >= budget.total` (`src/engine.js:913`) and `budget.remaining()` is
`budgetTotal - usageTotal.output` (`src/engine.js:866`) — **output tokens only**.

**Consequence.** An implementer reading "spent" next to a `spend` object with three fields
plots `input + output` or `cost`. The gauge then reads 80% full when the run is at 30% of its
real ceiling — and this is the widget the design uses to answer Q4 and to justify the
"Economics" differentiator. It also silently disagrees with `flowition status`'s
`spent: N output tokens` line (`src/cli.js:245`).

**Fix.** State: "the gauge plots `spend.output` against `budgetTotal`; both are output tokens.
Input tokens and cost are shown as separate figures and never enter the gauge." Add the same
sentence to §6.3's formatting rules so `fmtTokens` usage is unambiguous, and add a DOM test
asserting the gauge fill fraction equals `output / budgetTotal`.

---

## MINOR

### N1 — §5.4 has dangling subsection numbers (5.4.1, 5.4.4 absent)
§5.4 jumps 5.4.2 → 5.4.3 → 5.4.5. Two subsections were removed without renumbering, so a
reader cannot tell whether content is missing or the numbering is cosmetic. Given §5.3's
route table has seven read routes and §5.4 documents five, "missing" is the reasonable
inference. **Fix:** renumber, or add the two sections (a §5.4.1 covering shared param
validation and the `?include=args` disclosure would be genuinely useful — see N2).

### N2 — `?include=args` is answered in §13 Q4 but appears in no route spec
§13 Q4 says args are served via `RunDetail ?include=args`. §5.3's route table and §5.4.3 do
not mention the parameter, its auth treatment, or whether `RunDetail.args` is omitted vs
`null` when not requested (`hasArgs` exists but `args?` is optional). **Fix:** document the
param in §5.4.3, state that `args` is absent (not null) without it, and that the response
carries `cache-control: no-store` plus a distinct access-log marker so args reads are
auditable.

### N3 — §6.2 `Caps.toolIds` is documented "per-transcript" but lives on a per-run object
`Caps` hangs off `RunDetail`. Tool ids are a property of an individual agent's transcript and
adapter (E11 gives claude/codex/opencode real ids and droid/pi synthesized ones), so one run
can mix. **Fix:** move `toolIds` to `AgentView` (or make it `toolIds: Record<number, boolean>`)
and say which value the transcript pane's "pairing approximate" badge reads.

### N4 — §6.4.J's mail fallback join keys on `agent`, but journal mail records key on `key`
"else by `(agent, text, |Δt|≤5s)`". Journal `mail` records carry `{key, id, text, origin, seq,
sender, callsite}` (`src/journal.js:9`) — no `agent` index. The join must go through
`started`/`result` records' `key → index` mapping first. **Fix:** state the two-hop join
explicitly, and note that a mail record whose key never got a `started` record (accepted then
crashed) has no index and must render as run-scoped.

### N5 — §7.2's `cancel` route does not forbid `{"agent": null}`
The engine branches on `req.agent != null` (`src/engine.js:711`), so `{"agent": null}` from a
buggy client silently cancels the **whole run** when the operator clicked a per-agent cancel.
**Fix:** the route must reject a body containing an `agent` key whose value is not a
non-negative integer or a non-empty string with `400 bad_request`; whole-run cancel requires
the key to be absent.

### N6 — §4.3 says "spawn `node bin/flowition.js viewer`"
The engine's own detached launcher uses `process.execPath` and a `fileURLToPath(new
URL('../bin/flowition.js', import.meta.url))` resolution (`src/mcp.js:48–52`). A literal
`node` breaks under nvm shims, pnpm's node manager, and any non-PATH runtime. **Fix:** cite
`src/mcp.js:47–55` as the pattern and require `process.execPath` + module-relative binPath.

### N7 — §11.2's `zero-deps.test.js` checks import prefixes but not the real invariant
"`src/viewer/**` imports only `node:` and relative paths" is satisfied by
`import { runWorkflow } from '../engine.js'` — the one import §4.1 declares must never exist.
**Fix:** add an explicit denylist assertion: no module under `src/viewer/` may import
`../engine.js`, `../agent-proc.js`, or `../adapters/*`; `../run-state.js`, `../control.js`,
`../util.js`, `../journal.js`, `../events.js`, `../transcript.js`, and `../retention.js` are
the allowed engine-side imports.

### N8 — §9.8 specifies foreground truecolor passthrough and is silent on background SGR
"256/truecolor pass through as inline `color`". SGR 48 (background) is not mentioned. A tool
emitting `\e[48;2;250;250;250m` on the fixed dark well (§3.2) produces near-white-on-near-white
if backgrounds pass through, or loses meaningful highlighting if they are dropped. Parity #74
explicitly requires "forces a readable foreground on colored backgrounds". **Fix:** state the
rule — backgrounds pass through, and when a background is applied the foreground is forced to
the higher-contrast of the well's two text tokens by relative luminance.

### N9 — §4.2's healthz reuse ignores `--read-only`
The reuse protocol matches on `{app, homeHash}`. A viewer started `--read-only` is reused by
`flowition run`'s auto-start; the operator gets a working deep link and every mutation returns
`403 forbidden` with no explanation of why. **Fix:** add `readOnly: boolean` to the healthz
payload, surface it as a persistent header chip in the SPA ("read-only viewer"), and have
auto-start still reuse it (starting a second instance would be worse) while noting it on
stderr.

### N10 — §5.5's `fs.watch` + `realpath` plan does not say what happens when `agents/` is a symlink or is removed
"poll 250ms for the dir until it exists, then `realpath` before watching". Nothing says what to
do if `realpath` resolves outside the run dir, or if `agents/` is deleted while watched
(`fs.watch` on a removed directory behaves differently across platforms and can emit an error
that, unhandled, takes the process down). **Fix:** require the resolved path to be a
descendant of the `realpath`ed run dir or the watch is skipped (poll only); require an
`error` handler on every watcher that downgrades to poll-only and logs once.

### N11 — §4.4's idle definition can never idle out on a home with one stuck run
"active = (SSE clients > 0) OR (any cached run state is `running`/`starting`)". A run whose
engine was SIGSTOPped, or whose `run.lock` holds a reused pid (the accepted residual at
`src/run-state.js:23–26`), reports `running` forever. The auto-started viewer then never exits,
which is the exact failure §4.4 exists to prevent. **Fix:** additionally require that the run
have produced new events within the idle window — `running` with a static `events.jsonl` mtime
for 15 minutes does not count as active.

### N12 — §6.2 `RunSummary.detached` = "run.log exists" is not equivalent to detached
`run.log` is opened by both `detachRun` (`src/cli.js:114`) and `launchDetached`
(`src/mcp.js:48`), and it **persists** after the run finishes. A run started detached, then
resumed in the foreground, still shows `detached`. Conversely a foreground run resumed via MCP
becomes `detached` retroactively for its whole history. **Fix:** either rename the field
`hasRunLog` and label the badge "has detached log", or derive per-attempt detachment from the
lineage strip.

### N13 — §12's dependency graph omits W8 → W11 and W8 → W10
W11 (cockpit) and W10 (transcript) both consume the §3 design system and the `ui/` primitives
built in W8, but their `Deps` columns list only W9 and W8/W9 respectively (W10 lists W8; W11
does not). **Fix:** add W8 to W11's deps. Also note W12 depends on W8's `Dialog` primitive for
the confirm modals.

### N14 — the `run/started` event is emitted after module load, so import failures produce no start event
`events.emit({type:'run', state:'started'})` is at `src/engine.js:1140`, well after
`await import(...)` at `src/engine.js:838`. A workflow with a syntax error emits **only** the
terminal `run` event. §6.4 step 1 ("First `started` latches `startedAt`") therefore leaves
`startedAt: null` while `endedAt` is set, and §2.4's lineage strip gets a segment with no
start. **Fix:** state the fold rule — a terminal `run` event with no preceding
`started`/`resumed` opens and closes a zero-length attempt whose start is the journal `meta`
`createdAt` (or the terminal `t`), and the strip renders it as a stub. Optionally add to E3:
move the `started` emit before module load, which is additive and makes the common case honest.

---

*End of CRITIQUE-fable.md.*
