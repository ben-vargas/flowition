# flowition viewer — sign-off brief

**For:** the human reviewer deciding whether to greenlight.
**Basis:** DESIGN.md (final revision), after two adversarial reviews — 7 blockers and
32 majors raised, every one fixed or rejected with source evidence (DESIGN §15). Every
factual claim about the engine was re-verified against `src/` at `96362e7`.

## Thesis

A run viewer that only watches is a window; this is a cockpit. flowition runs are *interactive* —
each run has a control socket accepting steer/answer/cancel, and resume is first-class.
This viewer is the first surface where an operator can **act** on a run: answer its
blocking `ask()` questions, steer agents mid-flight, cancel, resume/replay, delete —
plus see what the terminal structurally cannot show: queue-wait vs execution time, the
parallel/pipeline DAG, budget burn per agent, per-agent liveness, and the run's actual
result. The 120-item prior-art parity floor is the entry fee, dispositioned item-by-item
in a normative compliance matrix (DESIGN §14: 111 exact, 9 explicitly superseded with
arguments, 0 dropped).

## Screens

- **Home** — run table plus an *attention strip*: the runs blocked on you (open
  questions, with inline answering), stale runs with a Resume button, live spend
  tickers. Your work queue, not a list.
- **Run cockpit** — persistent run rail; header with state/liveness detail, budget
  gauge (output tokens vs ceiling, hatched overshoot); three tabs over the same agents:
  **Timeline** (Gantt with queue-wait segments and a concurrency-saturation strip),
  **Structure** (the parallel/pipeline DAG), **Agents** (dense sortable table + phase
  tree). Inbox rail: questions, agent reports, steering history. Full log lane.
- **Transcript panel** — virtualized (500 MB files open at the tail in ≤1 s),
  step-grouped, id-paired tool calls, safe markdown/ANSI, steer composer on live
  agents, attempt history across resumes, **two-panel compare** (judge-panel workflows
  are flowition's point).
- **Result view** — renders `result.json`, the file watch-only viewers never read.

Visual direction: "flight-deck instrument" — IBM Plex Sans/JetBrains Mono, OKLCH token
system, color reserved for state. W8 starts with human-approved reference comps; built
screens are accepted against them, not against adjectives.

## Stack decisions

- **Server:** `node:` builtins only, inside the published package — the zero-dependency
  runtime invariant holds and is CI-enforced (root suite runs without
  `viewer/node_modules`; import denylist keeps engine execution out of the viewer).
- **SPA:** Vite 6 + React 19 + TypeScript, exactly three runtime deps
  (react, react-dom, @tanstack/react-virtual). No Tailwind/shadcn/router/markdown/ANSI
  libraries — hand-rolled against the spec'd design system. Ships as prebuilt static
  assets committed to the repo, with a CI rebuild-and-hash check so
  a stale dist cannot ship. Trade-off argued in DESIGN §4.6.
- **Streaming:** one multiplexed SSE connection per run page (events + journal + N
  transcripts) with a composite byte-offset cursor; watch is latency-only, polling is
  the correctness floor. Precedence and reset semantics are specified to the header
  (this was the critics' top duplication risk; now normative with tests).

## Engine changes requested (16, all additive; risk profile)

E1–E12, E14–E16: observability additions — phase/path fields on events, queue-admission
events, terminal-event completeness (error codes, usage, durations), throttled progress
with real `lastOutputAt`, answer values, mail correlation ids, attempt records, full
prompts, tool-call ids, structured logs, listing fix, CLI-side run-id allocation.
**Risk containment:** nothing enters the resume-key derivation (`keyed`/`keys.js`) —
byte-identical keys are pinned by test; journal changes are additive fields on existing
types; old CLIs render new events as silence by design. The one genuinely destructive
addition, **E13 retention** (`flowition rm`/`prune` + viewer delete), is delete-to-trash
with a 7-day purge, takes the run lock (closing the delete-vs-resume race), refuses
symlinks and non-run directories, and gets its own security review before merge.
Highest-risk item overall: E8's touch on `AgentJob.send` emissions — bounded by an
emissions-only-never-control-flow rule and the existing mail test suite.

## Security posture

- **Read-only by default.** Every mutation capability requires an explicit
  `--control[=send,answer,cancel,resume,delete]` opt-in; auto-started viewers are
  always read-only. Mutations need a separate ephemeral control token — a shared or
  auto-start URL can never authorize control.
- Loopback-only bind (no `--host` flag exists), bearer-token auth on all reads
  (transcripts are the secrets the 0700 run dir protects), Host allowlist against DNS
  rebinding, Origin + content-type gates on writes, no cookies (no ambient-credential
  CSRF), strict CSP with zero inline script/style (CI-asserted), no-innerHTML rule for
  hostile transcript content.
- **Instance reuse is authenticated:** an HMAC challenge proves a listener knows the
  token without transmitting it — a local attacker squatting the port cannot harvest
  the token or serve the operator attacker JS (this closed a review blocker).
  `--open` never puts the token in argv.
- Lifecycle mutations are audit-logged outside the run they touch. Threat model with
  accepted residuals is explicit (DESIGN §7.4).

## Work-unit plan

14 units, two lanes (codex gpt-5.6-sol for exhaustively-specified mechanics; claude
opus-5 for security- and taste-critical work), with single ownership of core engine
files (W1→W2→W3 are one pipeline, not parallel). Delivered as five independently
mergeable increments:

**A** read-only product (auth server + list/cockpit/transcript/result) → **B** the
decisive differentiator (answer/steer/cancel behind `--control`) → **C** live streaming
+ Timeline/DAG → **D** full transcript depth → **E** hardening + packaging (perf
budgets measured, not asserted — e.g. reconnect catch-up is parameterized by gap size,
heap by a `--expose-gc` assertion). Acceptance is a 12-point gate including the §14
matrix, a security-probe checklist, a kill-9 recovery walkthrough, and a
keyboard/screen-reader pass. Biggest schedule risk is the Gantt; it degrades to the
Agents table + saturation strip behind a "beta" chip without blocking release.

**Ask:** approve the design, the 16 engine changes, and the two-lane build plan.
