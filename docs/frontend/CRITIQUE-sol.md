# Adversarial critique — product ambition, visual quality, and security

Verdict: if every promised surface worked, this would be meaningfully more capable than
the prior-art viewer recon'd, not a reskin. The interactivity, result view, temporal view, and DAG
are real product differentiators. The current document is not yet a safe or internally
consistent build specification, however. Its default write posture violates the brief, its
viewer-reuse handshake is impersonable by another local user, its CSP blocks mechanisms
the SPA requires, and several headline claims are unsupported or contradicted by the
checked-in engine.

1. **BLOCKER — §7.2: Writes are enabled by default, violating the required explicit opt-in.**

   - **Section / defect:** §7.2 explicitly settles “Writes are enabled by default”
     (`DESIGN.md:985-998`) and makes `--read-only` an opt-out. The brief requires an
     explicit opt-in for anything that mutates a run. This is especially serious for
     `send`: the design correctly calls steering an RCE-equivalent channel, and the
     engine runs adapters with full user permissions (`README.md:282-293`;
     `src/engine.js:692-698`).
   - **Consequence:** Merely auto-starting or opening the viewer also exposes
     send/answer/cancel/resume/delete. An operator never makes the security decision the
     brief requires, and any later token, origin, or rendering defect immediately becomes
     a full-permission control-channel defect.
   - **Proposed fix:** Make the server read-only by default. Add explicit, independently
     testable capabilities: `--allow-control` for send/answer/cancel, `--allow-resume`,
     and `--allow-delete` (or one `--allow-control=send,answer,cancel,resume,delete`
     allowlist). Auto-start must pass none of them. Return enabled capabilities in the
     bootstrap/snapshot response and do not register disabled routes at all. Keep read and
     mutation tokens separately scoped so disclosure of a read URL does not imply control.

2. **BLOCKER — §§4.2-4.3 and 7.1: The unauthenticated reuse probe lets another local user impersonate the viewer and steal its bearer token.**

   - **Section / defect:** Reuse trusts an unauthenticated `/healthz` response containing
     a public app string and `sha256(home())` (`DESIGN.md:362-365,374-378,475-477`).
     `home()` is a predictable path (`src/util.js:9-10`); hashing it without a secret does
     not authenticate anything. Another local user can bind the predictable loopback port,
     return the expected JSON, and serve attacker-controlled JavaScript. Flowition will
     then print a URL whose fragment contains the real persistent token. Fragments are
     hidden from the HTTP request, not from JavaScript served by the destination. The
     threat table also claims the token is never in argv (`DESIGN.md:1040-1042`), but
     `--open` has no safe launch design; the conventional `open`/`xdg-open`/browser
     subprocess puts the token-bearing URL in a process argument visible to other local
     users on many systems.
   - **Consequence:** The attacker page reads `location.hash`, sends the token back to the
     attacker, and the other local user can later authenticate directly to a legitimate
     viewer and read transcripts or drive mutations. This defeats the exact adversary the
     0600 token is supposed to exclude.
   - **Proposed fix:** Never reuse or print a token-bearing URL based on unauthenticated
     health data. The parent must safely create/read the 0600 token first and prove the
     listener knows it using an authenticated `/api/session` probe (or
     nonce/HMAC challenge). Treat `/healthz` as readiness only. Scan candidate ports using
     the authenticated probe, or use a 0600 per-home rendezvous file containing
     `{pid,port,instanceNonce}` and still authenticate the live listener. Either remove
     token-bearing `--open`, or open a 0600 temporary bootstrap document whose path—not
     token—is passed in argv and which immediately navigates to the viewer. Add a node:test
     fixture with a fake server that spoofs the current health response; auto-start must
     reject it and must never disclose the token.

3. **BLOCKER — §§7.1.4, 9.5, 9.8, and 9.9: The CSP blocks the SPA implementation the same document mandates.**

   - **Section / defect:** The CSP is `script-src 'self'; style-src 'self'`
     (`DESIGN.md:967-971`), but §9.9 requires a pre-mount **inline** theme script
     (`DESIGN.md:1317-1321`). `script-src 'self'` blocks that script. The ANSI renderer
     requires inline truecolor styles (`DESIGN.md:1311-1315`), while virtualization,
     resizable splits, and Gantt positioning necessarily require dynamic per-element
     dimensions/transforms (`DESIGN.md:160-163,1270-1278`); `style-src 'self'` blocks style
     attributes too.
   - **Consequence:** A conforming browser either flashes the wrong theme and loses
     truecolor/layout positioning, or implementers silently weaken/ignore the promised CSP.
     The security matrix can be green while the real app is visibly broken because jsdom
     does not enforce CSP.
   - **Proposed fix:** Move theme bootstrapping into a parser-blocking external
     `theme-init.js` loaded before CSS. Then choose and document one coherent style policy:
     either eliminate style attributes, or use
     `style-src-elem 'self'; style-src-attr 'unsafe-inline'` while enforcing a small
     application-owned style-property/value whitelist (no transcript-derived CSS or
     `url()`). Test the exact policy against an instrumented browser or, if the test
     constraint forbids that, add a build-time policy checker and remove every construct it
     cannot validate.

4. **MAJOR — §§7.2-7.4 and E13: Delete is broader than “delete a run,” irreversible, and destroys its own claimed audit trail.**

   - **Section / defect:** §7.3 allows deletion in state `unknown` and then calls
     `fs.rmSync(..., {recursive:true})` (`DESIGN.md:1022-1025`). `runDir()` proves only that
     a string is a valid child name; it does not prove the child is a flowition run
     (`src/util.js:17-20`). A direct API call can therefore delete any validly named
     directory under `runs/`, even one with no journal/events and one the list deliberately
     hides. The claim that every viewer mutation is visible in the run event stream
     (`DESIGN.md:1009-1010`) is false for delete because that stream is deleted; cancel
     requests also have no durable request record distinct from the eventual outcome
     (`src/engine.js:709-717`).
   - **Consequence:** A mistaken or stolen control credential can irreversibly remove
     non-run data plus all evidence that the request happened. Type-to-confirm is UX, not
     server-side target authentication.
   - **Proposed fix:** Put delete behind its own explicit opt-in. Refuse `unknown`; require
     a regular directory with a recognizable flowition marker (`journal.jsonl`,
     `events.jsonl`, or a validated `result.json`) and a terminal `deriveRunState` result.
     Prefer an atomic move into `$FLOWITION_HOME/trash/` with a separate purge command.
     Record cancel/resume/delete requests in a 0600 global audit JSONL outside the run being
     deleted, with no message or transcript bodies.

5. **MAJOR — §§5.4.2 and 5.7: Terminal-state probe skipping is false for attached resume and will show a live run as terminal.**

   - **Section / defect:** The cache assumes every resume writes `.resuming`, so a terminal
     run can skip `deriveRunState` until that marker or `events.jsonl` changes
     (`DESIGN.md:513-519,695-703`). Only detached launchers create the marker
     (`src/cli.js:106-125`; `src/mcp.js:136-142`). The ordinary attached
     `flowition resume` path calls `runWorkflow` directly (`src/cli.js:174-195`), and the
     engine explicitly tolerates “no marker (attached resume)” (`src/engine.js:745-751`).
     During preflight the old terminal result remains while `run.lock` already proves a
     new engine owns the run (`src/engine.js:630,814-823`; `src/run-state.js:138-152`).
   - **Consequence:** Home and cockpit can keep showing “completed” during a real attached
     resume, fail to reopen streaming, and enable terminal-only actions. This regresses the
     run-state correctness the design says it reuses.
   - **Proposed fix:** A terminal summary may skip `deriveRunState` only after cheap checks
     confirm **both** `.resuming` and `run.lock` are absent (and the result/event
     fingerprints are unchanged); otherwise call `deriveRunState`. Better, make every CLI
     resume path install the same marker before `runWorkflow`, but retain the lock check for
     library callers and old CLIs. Add an attached-resume cache regression test.

6. **MAJOR — §§4.2-4.3: The auto-start/deep-link protocol cannot obtain the promised run id or fallback port reliably.**

   - **Section / defect:** The design says viewer startup runs concurrently with a
     foreground run and prints a verified run-specific link (`DESIGN.md:367-379`). Today a
     fresh foreground run id is allocated inside `runWorkflow`
     (`src/engine.js:613-623`) and is returned to the CLI only after completion
     (`src/cli.js:163-169`); no start callback exposes it. Separately, a detached viewer may
     choose ports 4647-4655 (`DESIGN.md:362-365`), but its stdio is ignored and the parent
     only specifies/probes 4646, so it has no defined way to learn the chosen port. Token
     syntax is also inconsistent: startup uses `#t=<token>` while a run link uses
     `#/run/<id>?t=<token>` (`DESIGN.md:356-357,377`), yet no bootstrap grammar or
     token-scrubbing route transition is specified.
   - **Consequence:** Two competent implementations will print late links, dead links, or
     links to the wrong home; multi-home/port-collision behavior in §13 cannot work as
     written.
   - **Proposed fix:** Allocate the fresh run id in the CLI before both operations and pass
     it as `runId` to `runWorkflow` (resume and explicit `--run-id` retain their ids).
     Discover/reuse the port through the authenticated port scan/rendezvous from finding 2.
     Specify one hash grammar, e.g. `#/run/<encoded-id>?token=<encoded-token>`, parse it
     before routing, copy the token to sessionStorage, then `history.replaceState` to the
     tokenless route. Test fresh, resume, explicit-id, collision, and multi-home cases.

7. **MAJOR — §§1.2, 2, 4, 5, 9, and 12.1: The claimed 120-item parity floor is not actually cleared.**

   - **Section / defect:** The incorporation clause at `DESIGN.md:3-6` cannot resolve
     direct contradictions. Item-by-item comparison with the recon's
     120-item parity floor (now DESIGN §14.1) finds at least these uncovered or regressed items:
       - **#1:** `/api/runs` returns `RunsPage`, not the required summary array.
       - **#2:** listing requires journal or events, so a truly empty existing run dir is
         omitted (`DESIGN.md:505-508`).
       - **#4:** liveness is TTL-cached and terminal probes are skipped; finding 5 shows
         the result is incorrect.
       - **#9:** the full-transcript endpoint is replaced by a page endpoint; no
         compatibility route exists.
       - **#11:** an agent stream without a cursor starts at `tail`, not by replaying the
         transcript (`DESIGN.md:614-621`).
       - **#24:** the MIME table omits `.woff` (`DESIGN.md:711-715`).
       - **#28/#30:** port 0 and configurable idle timing/idle handler are not specified;
         idle timing is fixed.
       - **#35:** `--open` appears on `viewer`, but the run command's `--open`
         behavior/platform launch is absent.
       - **#37-43:** Home is a separate paged table, not a persistent run sidebar; there
         is no total-count display, active-run mark, persisted hide/show, mobile run
         drawer, or resizable run-list/content split.
       - **#47/#49/#50:** the phase tree, phase rollup/count, and its auto-collapse /
         selected-open / user-override behavior are replaced by a group-by table and DAG.
       - **#72-74:** no engine change records a real command exit code
         (`src/adapters/protocols.js:90-93`; `src/agent-proc.js:444-448`), and a fixed dark
         well does not guarantee readable foreground on arbitrary ANSI backgrounds.
       - **#99:** §7.3 disables resume for completed runs even though current flowition
         supports it (finding 12).
       - **#107:** directional overflow fades are nowhere specified or owned.
       - **#109:** the pre-paint theme mechanism is blocked by the stated CSP (finding 3).
       - **#119:** there is no phase-collapse behavior to cover in the DOM suite.
   - **Consequence:** The acceptance gate can be declared green by citing the recon while
     observable regressions remain. Several substitutions may be good product choices, but
     they are not “all 120” without an explicit equivalence argument.
   - **Proposed fix:** Add a normative 120-row compliance matrix to DESIGN with one of
     `exact`, `superseded-equivalent` (and a concrete UX/API proof), or `deferred-blocks-
     release`, plus its owning W-unit and test/demo. Preserve compatibility endpoints where
     the parity item is an external contract. Do not use a blanket incorporation clause as
     acceptance evidence.

8. **MAJOR — §§5.1, 5.4, 5.6.5, 6.2, and 7.4: The “All bodies ≤256 KB” claim conflicts with unbounded snapshots, journal results, and result.json.**

   - **Section / defect:** §5.1 caps every response at 256 KB
     (`DESIGN.md:447-450`), but `RunDetail` contains unbounded `logs[]` and `mail[]`;
     the journal SSE forwards raw full `result` values (`DESIGN.md:669-676`); and the result
     endpoint passes `result.json` through verbatim (`DESIGN.md:560-566`). The engine writes
     the full agent result to the journal (`src/engine.js:963-964`) and the full workflow
     outcome to `result.json` (`src/engine.js:637-642`). The threat model's 1 MiB line skip
     silently loses precisely those values and does not reconcile the loss with the wire
     types. “JSON.parse depth is bounded by V8” (`DESIGN.md:1044`) is not an application
     resource bound, and a recursive JSON tree can still exhaust the stack.
   - **Consequence:** Implementers must either violate the cap, silently drop data, or
     invent pagination. A large model result or log-heavy run can block the Node event loop,
     allocate far beyond the browser budget, and blank the result/log experience.
   - **Proposed fix:** Limit the 256 KB statement to request bodies and explicitly bound
     each response. `RunDetail` should include recent logs/mail plus counts and cursors;
     add paged log/mail endpoints. Do not stream journal result bodies—stream attempt/usage
     metadata plus a result reference. Make `/result` return size/type metadata and a
     bounded preview, with an explicit download/stream path for large values. Add
     oversize/corrupt counters to the degradation contract, and cap JSON tree nodes/depth
     with a raw-download fallback.

9. **MAJOR — §§5.6 and 9.4: Composite SSE resume semantics are ambiguous at the exact points that decide duplication versus loss.**

   - **Section / defect:** The design accepts a URL `cursor` and relies on EventSource's
     `Last-Event-ID`, but never specifies precedence. If the initial query cursor wins on
     automatic reconnect, every reconnect replays from the initial snapshot; if a malformed
     query overrides a valid header, the client resets unnecessarily. “At-or-behind” is
     undefined for a vector cursor: component offsets can be equal, advanced, regressed
     after rotation, or incomparable across streams (`DESIGN.md:623-653,1262-1268`).
     Ordering between `sys/reset` and the first replayed record is also not normative.
   - **Consequence:** Two competent stream implementations can both follow this document
     and produce duplicate transcript rows or discard valid buffered history. This is the
     core correctness property of the viewer, not a cosmetic detail.
   - **Proposed fix:** Specify a pure transition table: authenticated
     `Last-Event-ID` takes precedence over the bootstrap query on native reconnect;
     explicit client reopen sends the latest query cursor and no stale header; compare
     offsets **per stream**, never by a scalar/vector ordering; regression of one stream
     first emits `reset(stream)` and resets only that stream before any records; absent
     components use documented subscription defaults. Test every precedence combination,
     incomparable vector, rotation, changed agent set, and mid-batch disconnect.

10. **MAJOR — §§6.4 and E1-E2: The proposed telemetry still cannot support the “exact” phase/DAG views it promises.**

   - **Section / defect:** E1 says to capture an ambient phase at `agentImpl` entry but
     never defines where that ambient state lives (`DESIGN.md:1066-1073`). A single global
     phase remains racy under concurrent branches; current branch isolation exists in
     `AsyncLocalStorage`, whose contexts presently carry no phase
     (`src/keys.js:10-22`). `AgentOptions.phase?: string` is also ambiguous when titles
     repeat. E2 has three incompatible container shapes: `PathSeg` uses `n` and `fanout`,
     the prose emits `count`, and it is unclear whether a fanout event's `path` denotes the
     parent or the new container (`DESIGN.md:750-753,1075-1080`). Sequential sibling
     fanouts can therefore collapse into one node.
   - **Consequence:** The headline Structure and phase rollups can confidently display the
     wrong topology on new runs while `Caps.phaseAssociation` says they are exact. Worse,
     implementers may “fix” identity by feeding phase/path into `keyed`, breaking resume
     compatibility.
   - **Proposed fix:** Put observational phase state in each ALS context, inherited by
     child contexts but excluded from `agentKey` and `deriveBranch`. Give phase instances a
     stable observational id (branch path + branch-local phase ordinal), not a title key.
     Define one canonical path schema, e.g.
     `{kind:'parallel'|'pipeline', ordinal, count, stages}` followed by item/stage
     segments; every fanout and agent event carries that exact full container path. Pin
     current branch/key outputs before and after and test concurrent branches with repeated
     phase titles and sequential sibling fanouts.

11. **MAJOR — §§2.1, 2.4, 6.2, and E6: The 50%-of-stall liveness warning cannot be computed honestly.**

   - **Section / defect:** The UI promises a warning at 50% of each agent's `stallMs`
     (`DESIGN.md:69-73,133-141`), but `AgentView` has no `stallMs`, and E6 does not add it
     to `running`. Today the resolved stall value and last-output reset are local to
     `AgentJob.runProcessTurn` (`src/agent-proc.js:345-372`), while socket status exposes
     only `lastTool` (`src/engine.js:682-690`). E6 proposes a throttled progress event that
     fires only when something changes; a silent agent produces no later event. If
     `sinceOutputMs` itself counts as “changed” and emits periodically, using event time as
     `lastProgressAt` falsely makes the silent agent look active.
   - **Consequence:** Custom-stall agents warn at the wrong time or never warn. The feature
     meant to answer “stuck or quiet?” becomes another guess, exactly what the design
     forbids at run level.
   - **Proposed fix:** Emit resolved `stallMs` on `running`; maintain an explicit
     `lastOutputAt` in `AgentJob`; include that timestamp (not just an age) in progress
     events and socket status. Initialize it at turn start and never advance it merely
     because a timer emitted. Persist the last known timestamp in terminal events so a
     dead run remains diagnosable. Define “output” consistently (provider stdout line,
     direct-adapter event, mail wait) and test a custom short stall with no output.

12. **MAJOR — §§1.3, 5.6.4, and 7.3: The resume contract disables supported behavior and overstates what hashes make safe.**

   - **Section / defect:** §7.3 permits resume only from failed/interrupted/stale
     (`DESIGN.md:1014-1020`), while the engine deliberately resumes a completed run by
     replaying cached agents. This behavior is asserted in `test/engine.test.js:41-46` and
     passed under current source verification. It also contradicts parity #99 and the
     stream's “later resume” re-arm story. Separately, “byte-pinned prior choice”
     (`DESIGN.md:47-49`) is too broad: resume hashes local files but not bare package
     imports or CLI/provider environment (`ARCHITECTURE.md:415-418`).
   - **Consequence:** The UI withholds an existing recovery/replay operation and gives
     users a stronger code-integrity assurance than the engine provides. Implementers also
     cannot decide whether “Resume” means launch accepted, engine preflight passed, or a
     new attempt actually started.
   - **Proposed fix:** Either allow completed resume (matching current tested behavior) or
     explicitly remove parity #99 and explain the product regression. Describe integrity
     precisely as “entry plus statically discovered local import graph pinned; environment
     and bare packages are not.” The confirmation should show that limitation and
     `graphDynamic`; the POST response should mean only `launchAccepted`, with subsequent
     state/event frames reporting preflight success or refusal.

13. **MAJOR — §§2.4-2.5 and 6.4.J: Per-agent usage, cost, duration, and “attempt” semantics are not defined across resume and retry.**

   - **Section / defect:** §6.4.J says multiple journal `result` records produce
     usage/duration/attempts but never says whether displayed usage/cost/duration is the
     latest attempt or lifetime sum (`DESIGN.md:918-926`). `Journal.load` currently
     last-wins the result while separately summing usage across every result
     (`src/journal.js:142-156`). An in-process retry calls `job.execute()` twice but writes
     only one final result record (`src/engine.js:951-964`), so E9's result-count-based
     “attempts” excludes retry attempts and schema/mail follow-up turns. The UI labels all
     of these simply “attempt.”
   - **Consequence:** The agent table, header, attempt selector, and budget attribution can
     show mutually inconsistent numbers. Two implementations can differ by the entire cost
     of failed attempts while both claim conformance.
   - **Proposed fix:** Define three separate concepts: run invocation, agent execution
     attempt (one `started`→`result` pair), and provider turn/retry. Expose
     `lifetimeUsage/lifetimeCost/lifetimeDuration` plus per-attempt values; use lifetime in
     table/rollups and selected-attempt values in the transcript selector. Add structured
     retry/turn markers if they are to appear as attempts; otherwise name E9 “run-resume
     segments.” Specify crash-window `usage-cum` attribution using the same delta-chaining
     algorithm as `Journal.load`.

14. **MAJOR — §10: Two headline performance budgets are mathematically or methodologically unachievable as written.**

   - **Section / defect:** P5 accepts 5,000 records/s, while P8 promises that a client
     offline for 20 minutes catches up in ≤2 s (`DESIGN.md:1335-1340`). At P5 that backlog
     is 6,000,000 records; P4's own 50,000-event/s fold budget needs 120 seconds before DOM
     work. P6 promises ≤64 MB heap “regardless of file size,” but its automated test checks
     only eviction bookkeeping and leaves the heap measurement manual
     (`DESIGN.md:1337,1343-1345`); 8 MiB of source can expand many-fold into parsed objects
     and React nodes.
   - **Consequence:** The review gate will either fail for correct implementations or pass
     by using a tiny unstated backlog and not measuring the claimed resource. These numbers
     do not constrain engineering behavior.
   - **Proposed fix:** Parameterize P8 by backlog bytes/records and specify asymptotic
     throughput, e.g. “100k records / 32 MiB in ≤2 s, larger gaps show catch-up progress and
     remain responsive.” Make the reconnect fixture match that bound. Enforce P6 in a
     spawned Node process using `--expose-gc` plus `process.memoryUsage()` after a defined
     8 MiB worst-case window, and separately cap rendered row count/expanded payloads.

15. **MAJOR — §12: The delivery plan is too broad to land safely and assigns overlapping core files to parallel lanes.**

   - **Section / defect:** V1 combines 15 engine changes, retention, auth, multiplexed SSE,
     paged/search APIs, a custom design system, a custom Markdown parser, ANSI, several
     virtualized projections, 120 parity items, and five differentiators. The claimed
     parallelism is unsafe: W1 and W2 both own `engine.js` and `agent-proc.js`; W2, W3, and
     W4 all edit `cli.js`; W4-W6 are said to proceed from day one even though W5/W6 depend
     on W4 (`DESIGN.md:1413-1435`). The only admitted schedule risk is the Gantt, which is
     not the largest correctness risk.
   - **Consequence:** The two lanes will build against moving event/control contracts,
     merge security-sensitive code mechanically, and reach visual work only after most of
     the architecture is committed. A partial landing is likely to be a broad but brittle
     dashboard, not a coherent product.
   - **Proposed fix:** Ship vertical, reviewable increments with one owner for core engine
     files: (A) read-only authenticated server + run list/transcript/result parity; (B)
     explicit-opt-in answer/send/cancel as the first decisive differentiator; (C) stable
     telemetry schema + Agents/Timeline; (D) DAG; (E) resume/delete/search. Freeze versioned
     fixtures between engine and viewer before SPA lanes consume them. Retention/delete
     should be a separate security review, not part of the minimum viewer merge.

16. **MAJOR — §§2-3 and W8/W11: The visual direction rejects shadcn defaults but still does not specify a reproducible designed composition.**

   - **Section / defect:** IBM Plex/JetBrains Mono, OKLCH tokens, bespoke glyphs, and terminal
     wells are genuinely more intentional than shadcn-by-default. At screen level, however,
     the document supplies only conventional dashboard nouns—header, tabs, table, right
     rail, drawer, command palette—and no annotated wireframe, reference composition, or
     view-level visual acceptance artifact. Exact grid proportions, hierarchy under load,
     default rail/panel states, timeline/DAG visual grammar, narrow-screen action priority,
     and representative dense/error/empty compositions remain open
     (`DESIGN.md:80-209,287-310`). W8 accepts token fidelity; W11 accepts feature
     walkthroughs, neither accepts a visual target (`DESIGN.md:1422-1426`).
   - **Consequence:** Two competent implementers can produce radically different products
     while using every specified token. The likely convergence point is still a generic
     developer dashboard with custom colors—designed components, but not a designed whole.
   - **Proposed fix:** Before implementation, commit annotated reference comps for four
     canonical states: attention-heavy Home, live cockpit, failed/stale cockpit, and
     two-agent comparison at desktop plus one narrow layout. Specify the page grid,
     persistent navigation decision, default-open states, density examples, timeline/DAG
     marks, truncation behavior, and action hierarchy on those artifacts. Make W8/W11
     compare built screenshots to these references at fixed viewports; token tests alone
     are not a visual gate.

17. **MINOR — §§5.4.2 and 5.7: “Journal meta is always the first line” and “cache forever by path” are both unsafe assumptions.**

   - **Section / defect:** The design cites `src/engine.js:828` to claim meta is always
     first (`DESIGN.md:509-512`). Fresh failures can write `end` before meta: control-bind
     failure does so at `src/engine.js:738-740`, and an unreadable workflow does so at
     `src/engine.js:768-778`; meta is appended only later at `:827-829`. Caching it forever
     by path also returns stale metadata if a deleted custom-id run is recreated at the
     same path between list polls.
   - **Consequence:** Precisely the preflight failures most in need of diagnosis are
     misread or cached as metadata, and reused run ids can show the prior workflow forever.
   - **Proposed fix:** Read complete bounded lines until a valid `type:'meta'` is found or a
     small byte/record cap is reached; otherwise synthesize metadata from events and
     directory stat. Key immutable-meta cache entries by directory/file identity and
     first-line fingerprint (`dev`, `ino`, size/mtime or hash), and invalidate on
     disappearance, shrink, replacement, or run-id recreation.
