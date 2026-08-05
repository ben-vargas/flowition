# flowition viewer — design & architecture

**Status:** authoritative build spec, revised to final form after two adversarial reviews
(`CRITIQUE-fable.md`, `CRITIQUE-sol.md`; dispositions in §15). The two implementation
lanes (codex gpt-5.6-sol high, claude opus-5 high) build exactly what this document says.
The recon documents are background, not acceptance evidence: where this document and a
recon conflict, **this document governs**, and every parity-floor item is dispositioned
explicitly in §14 — the incorporation-by-reference clause of the previous revision is
retired. Where behavior of flowition-as-it-is-today matters, this document cites
`file:line` at commit `96362e7` on `feat-frontend`; those citations were re-verified
against source for this revision.

Conventions: **DECISION** marks a settled choice — do not reopen it. `E<n>` = engine
change (§8). `W<n>` = work unit (§12). "Parity #N" = item N in the §14.1 feature-floor
catalogue, dispositioned in §14.

---

## 1. Goals, non-goals, thesis

### 1.1 Thesis

**A run viewer that only watches is a window; ours is a cockpit.** flowition runs are
*interactive* — a per-run control socket accepts `send`, `answer`, `cancel`, `post`
(src/control.js:69, src/engine.js:680–726) and resume is a first-class detached operation
(src/mcp.js:136–143). The one-sentence thesis: **this viewer is the first surface where an
operator can *act* on a run — answer its blocking questions, steer its agents, cancel,
resume, and see the temporal and structural truth (queue wait, DAG, budget burn, per-agent
liveness) that a flat index-ordered agent tree structurally cannot show.**

### 1.2 Goals

1. Cover the 120-item parity floor (§14.1) — every item either built as specified or
   **explicitly superseded with an equivalence argument**, per the normative
   compliance matrix in §14. Matching is the entry fee; silent substitution is not allowed.
2. Ship the five differentiators a watch-only viewer cannot have:
   - **Act:** answer `ask()` questions, steer agents, cancel (agent or run), resume, delete.
   - **Time:** a real Gantt — queue wait vs execution, concurrency saturation, per-agent
     liveness before the 30-minute stall watchdog (src/agent-proc.js:24) fires.
   - **Structure:** the parallel/pipeline DAG, not an index-ordered list.
   - **Economics:** budget gauge, live per-agent token burn, cost attribution, failure taxonomy.
   - **Outcome:** the run's `result.json` rendered, resume lineage, attempt history.
3. Keep flowition's published runtime path at **zero dependencies**: the server is
   `node:` builtins only; the SPA ships as prebuilt static assets (§4.6, §9.1).
4. Everything testable under `node scripts/test.mjs` + a viewer-local vitest suite, no
   API credits, mock adapter only (§11).
5. Degrade gracefully on **old runs** (recorded before the §8 engine changes) — every new
   UI capability has a specified fallback (§6.5).

### 1.3 Non-goals

- **No workflow execution from the viewer.** Not launching new runs, not editing workflow
  files. `resume` is the only lifecycle mutation that re-enters a workflow, and its
  integrity gate is stated precisely: the engine pins the entry file and its **statically
  discovered local import graph** by hash (fileHash/graphHash, src/engine.js:791–793) and
  refuses dynamic graphs (src/engine.js:793); it does **not** pin bare package imports,
  adapter CLIs, or provider environment (ARCHITECTURE.md, Known limitations). The resume
  confirmation UI states exactly this — never "byte-pinned" without qualification.
  Non-negotiable.
- **No remote/multi-user deployment.** Single machine, single user (the run owner). No
  `--host 0.0.0.0` support in v1 — the flag does not exist, so it cannot be misused.
- **No cross-run analytics/trends in v1** (leaderboards, per-model spend over time).
  The data model doesn't preclude it; it is deferred, not designed here.
- **No Windows support in v1.** The control socket is a unix socket; `deriveRunState`
  probes it. Document the limitation; do not partially support it.
- **No sandboxing changes.** Out of scope per ARCHITECTURE.md §Sandboxing.

---

## 2. Product design

### 2.1 The questions the product answers

Every screen exists to answer operator questions, ranked by how often they occur and how
badly the terminal answers them today:

| # | Question | Where answered |
|---|---|---|
| Q1 | "What is my run waiting on **me** for?" | Home attention strip + cockpit Inbox rail (questions, with inline answer) |
| Q2 | "Is my run stuck, or just quiet?" | Liveness ladder: run state chip (deriveRunState detail) + per-agent `lastOutputAt` age (E6) + stall-warning at 50% of the emitted `stallMs` (E4) |
| Q3 | "What did agent N actually do?" | Transcript pane: full prompt (E10), step-collapsed timeline, id-paired tool calls (E11), result, error code |
| Q4 | "Which agent is burning the budget?" | Budget gauge + per-agent token bars (live `usage-cum` join) + Agents table sorted by cost |
| Q5 | "How parallel was this actually? Where did the time go?" | Timeline tab: Gantt with queue-wait (E4) vs execution segments, saturation strip |
| Q6 | "What is the shape of this run?" | Structure tab: parallel/pipeline DAG from `path` (E2) |
| Q7 | "Why did resume re-run that agent?" | Attempt history per agent (journal `result` records + E9 attempt markers), cached badges, resume lineage strip |
| Q8 | "What did the run produce?" | Result view (`result.json`, a file watch-only viewers never read) |
| Q9 | "Which agent touched X / said Y?" | In-run search across all transcripts (server-side, §5.4.7) |
| Q10 | "Why did it fail, and what do I do?" | Failure taxonomy from `AgentError.code` (E5): `spawn_failed` → "CLI not installed — run `flowition doctor`", `stalled` → stall context, `schema_invalid` → the corrective-turn story |

### 2.2 Information architecture

Four surfaces. Hash routing (`#/…`) so the server needs no SPA fallback (parity #26).

```
#/                         Home — run list + attention strip
#/run/:id                  Run cockpit (run rail | tabs: Timeline | Structure | Agents; rails)
#/run/:id/agent/:n         Cockpit + transcript panel (a= query for a 2nd compare panel)
#/run/:id/result           Result view
```

**Hash grammar (normative, one grammar everywhere):** `#<route>?<params>` where the
route is one of the four above and `<params>` is `key=value&…`. Three params are
reserved and stripped by the router **before route matching**: `t` (read token,
§7.1.2), `c` (control token, §7.1.2), and `a` (compare panel agent, §2.5). Every URL the CLI prints uses this grammar: the bare viewer
URL is `http://127.0.0.1:4646/#/?t=<token>`, a run deep link is
`…/#/run/<runId>?t=<token>`. On first dispatch the router copies `t` into
`sessionStorage` and rewrites the hash without it via `history.replaceState` — before any
route renders. A `t` that subsequently fails auth (401) clears `sessionStorage` and shows
the paste-token screen; it never loops. (Critique M7 / Sol-6.)

**Run rail:** the cockpit keeps a persistent left rail listing all runs (a compact
projection of the Home table: status glyph, name-or-id, agents done/total, relative time,
plus a total-run count in its header — parity #37/#38). The currently open run is marked
active (#39). The rail can be collapsed and reopened; the choice persists in
`localStorage` (#41). Below 900px it becomes an overlay drawer that closes on run
selection (#42). The rail/content split is drag-resizable within 200–480px, persisted
(#43). The rail shows the same API-unreachable error state as Home (#40). Home remains
the full-page view for filtering and the attention strip; the rail is how you switch runs
without leaving the cockpit.

### 2.3 Home (`#/`)

**Attention strip** (top, only when non-empty): cards for (a) runs blocked on unanswered
`ask()` questions — question text inline, one-click jump to the answer composer; (b) stale
runs — "engine died" with a Resume button; (c) running runs — live spend ticker. This is
Q1 made structural: the operator's work queue, not a list.

**Run table** (virtualized): each row shows status glyph, `name ?? runId`, adapter glyph
cluster (deduped, max 4 + "+n"), agents `done/total`, output tokens, cost (when journaled),
duration/elapsed, relative start time, badges: `detached log` (hasRunLog, §6.2),
`resumed ×n`, `budget`,
`?` (open question). Filters: state chips (running/blocked/failed/completed/stale), free-text
over name/runId. Sort: newest first (createdAt). Paged "Load more" (§5.4.2).

States: loading skeleton rows; error banner "API unreachable — is `flowition viewer`
running?" (parity #40); empty state for zero runs: a card with the quick-start snippet
from README (`flowition run hello.workflow.js`) — a teaching card, never a bare shrug.

### 2.4 Run cockpit (`#/run/:id`)

**Header** (always visible): name + runId (click-copies), state chip with liveness detail
(from `deriveRunState().detail` when present, e.g. "run.lock held by live pid"), elapsed
clock (ticks 1/s while live, freezes at terminal — parity #46), agents `done/total`,
tokens `in/out`, cost, the **budget gauge** — a horizontal bar plotting
**`spend.output` against `budgetTotal`; both are output tokens** (the engine checks
`usageTotal.output >= budget.total`, src/engine.js:913, and `flowition status` prints the
same number, src/cli.js:245). Input tokens and cost are separate figures and never enter
the gauge (critique M19). The bar has a hatched overshoot zone past the ceiling and the
label "soft ceiling" (the budget is pre-admission advisory, ARCHITECTURE.md Known
limitations; the UI must never present it as a hard cap), last log line (single line,
truncated — parity #59). Actions: `Cancel run`, `Resume`/`Replay` (enabled per §7.3),
`Delete` (enabled per §7.3), `Result` (jump).

**Resume lineage strip**: a thin horizontal band under the header, one segment per run
attempt derived from `run` events (`started`/`resumed`/terminal — src/engine.js:1140, :643),
each segment colored by its terminal fate. Answers Q7 at run level.

**Inbox rail** (right, collapsible): (1) **Questions** — every unanswered `ask()` with the
question text and an inline answer composer (submit = POST answer, §7.2); answered ones
collapse to a history row showing the answer value (E7). (2) **Agent reports** — `mail`
events with `dir:'out'` (src/engine.js:719–722), newest first, each linking to its agent.
(3) **Steering history** — mail `dir:'in'` with origin (operator/workflow), delivery
verdict, and callsite when journaled (journal `mail.callsite` — the only workflow source
position on disk, RECON-flowition §1.4).

**Main tabs** — three projections of the same agents:

- **Timeline** (default): a Gantt. One lane per agent, x = time. Each agent bar =
  queue-wait segment (hatched, from `queued`→`running`, E4) + execution segment (solid,
  status-colored). Progress ticks (E6) render as faint notches; a live agent whose
  `lastOutputAt` (E6) is older than 50% of its **emitted** `stallMs` (E4 puts the resolved
  value on the `running` event) gets an amber "quiet for Nm" tag (Q2). Old runs with no
  emitted `stallMs`: fall back to `1_800_000` (the engine default, src/agent-proc.js:24)
  and label the tag "quiet for Nm (stall threshold unknown)" (critique M10 / Sol-11).
  Failed/cancelled bars get real widths (E5 durationMs). Above the lanes: the
  **saturation strip** — a step chart of active-vs-`concurrency` (E3/E4), which makes
  "raise `--concurrency`" visually obvious. Bars are clickable → transcript. Zoom: fit /
  1s / 10s per px; keyboard `+ -`. Old runs (no E4/E6 data): bars start at `running`,
  strip hidden, header notes "recorded by an older engine — queue wait unavailable".
- **Structure**: the DAG. Nested containers from `path` (E2): a `parallel(n)` renders as
  a fan of n item lanes; `pipeline(n × s)` as an n-row × s-stage grid; agents are chips
  inside (status color, adapter glyph, label, duration, cost). Container headers roll up
  status/cost/duration. `cached` chips get the replay badge. Old runs: flat agent list
  with "structure unavailable for runs recorded before v0.2".
- **Agents**: a dense sortable table (parity with the tree view and beyond it — a tree
  is not sortable): columns index, label, adapter+model+effort, phase, state (+error code
  chip **and the error message inline, truncated to one row with a tooltip — parity
  #54**), wait, duration, tokens in/out (live for running agents via `usage-cum`), cost,
  **last tool** (parity #53 — `AgentView.lastTool`), attempts, steers. Fields that are
  absent are omitted, never rendered as `0`/`—` fabrications (#53). Sort by any column.
  A **Phases** grouping mode renders the §2.4.1 phase tree in place of the flat table.

#### 2.4.1 Phase tree (parity #47–#51, #119)

The Agents tab's Phases mode is a collapsible tree, phases in declaration order
(`meta.phases` via E3, then observed `phase` events appended in `phaseIndex` order —
parity #47). Each phase header shows a rolled-up status glyph (failed > running > queued
> cached > done precedence across its agents) and a `done/total` count (#49). Declared
phases not yet reached render dimmed "pending", and "not run" once the run is terminal
(#48). Agents with no phase render in a trailing "no phase" section, never dropped (#51).

Collapse behavior (#50, normative): a phase whose agents are all `done`/`cached`
auto-collapses; the phase containing the currently selected agent defaults open; an
explicit user toggle overrides both and is stored per `(runId, phaseIndex)` in component
state for the lifetime of the page — later fold updates must not revert it (the store
keeps a `userToggled` map consulted before the automatic rule). DOM tests cover the
override surviving prop churn (#119).

#### 2.4.2 Cockpit empty & loading states (parity #60–#62)

A cockpit whose snapshot hasn't loaded shows skeleton header + skeleton lanes (#61). A
loaded run with zero agents shows an explicit empty state in the tab area ("no agents
yet — the workflow hasn't called agent()"; on a terminal run: "this run started no
agents") (#60). Route `#/` with no run open is Home, which is the explicit no-selection
state (#62).

**Log lane** (bottom drawer, toggle `L`): the full `log` stream (not a last-line readout —
`logs.at(-1)` is a status, not a log view), with source lanes (workflow vs engine, E12), level
filter, and agent-index chips linking to agents. The lane renders the RunDetail log tail
immediately and pages backwards through history via the events page route (§5.4.6) —
RunDetail itself carries only a bounded tail (§6.2, Sol-8).

### 2.5 Transcript panel (`#/run/:id/agent/:n`)

Opens as a right split (drag-resizable, persisted); on narrow viewports it replaces the
cockpit with a back affordance. **Up to two panels side-by-side** (`?a=<m>` adds a compare
panel) — judge-panel and adversarial-verify workflows are the entire point of flowition;
comparing two agents' answers must not require two windows.

**Compare layout below 900px — OPERATOR AMENDMENT, 2026-07-30.** *Ruled by the operator
(Ben Vargas) on the §3.7 comp set, via the flowition ask/answer channel; recorded here
the way §16 records rulings, and it wins where the sentence above disagrees.* "Up to two
panels **side-by-side**" is normative **at ≥900px**. **Below §3.3's single 900px
breakpoint the two-panel compare renders as a stacked pair**: both panels at the full
column width, one above the other, sequential scroll, with the seam between them heavier
than any rule inside a panel and the shared pin bar anchoring both panes to the same step
so the two short viewports show the same moment. The reason the operator chose it over
the side-by-side pair that was drawn beside it: at 800px both rails are 44px handles, so
a side-by-side pair gives each pane ~355px — well under the 607px the row types are
designed at — and the *same* row then renders differently on the two sides, which defeats
the comparison the feature exists for. Stacking keeps both panes full-width and spends
scrollback depth instead. Nothing above 900px changes. The §3.7 reference comp for this
state at 800px is the stacked pair (`docs/frontend/comps/transcript.html`); the
side-by-side drawing is retained in that file as the annotated alternative that was
considered and not chosen. W10 builds the stacked form below 900px.

Header: label (or `agent N`), adapter glyph + name, model/effort, state glyph, live token
counter, duration, cost, session id (click-copies; tooltip "provider conversation
handle"), attempt selector when >1 attempts (E9): `attempt 2 of 3` steps through
transcript segments split on attempt markers (old runs: split on the sentinel string
`'— resumed run: new attempt below —'`, src/engine.js:918, labelled "approximate").

**Attempt vocabulary (normative — Sol-13).** Three distinct concepts, never conflated:
a *run invocation* (one engine process; the lineage strip's unit), an *agent execution
attempt* (one journal `started`→`result` pair; E9's unit; what the attempt selector
steps through), and a *provider turn* (schema-corrective turns, mail follow-up turns,
and the in-process retry at src/engine.js:955–957 — these happen **inside** one attempt
and produce one `result` record; they are visible as transcript content, not as
attempts). Header usage/cost/duration and the Agents-table row show **lifetime** values
(sum over all of the key's `result` records — the same aggregation `Journal.load` uses
for budget seeding, src/journal.js:146–157); the attempt selector additionally shows the
selected attempt's own usage/duration from its individual `result` record. The two are
labelled ("lifetime" / "this attempt") wherever both appear.

Body (virtualized, §9.5): the **prompt block** first — full text (E10), collapsed to 15
lines with expand, copy button, and for old runs a "may be truncated at 4000 chars" note
(G16). Then the timeline: step-collapse groups (§9.6), assistant text as safe markdown
(§9.7), reasoning as collapsible blocks *with a one-line preview* (skippable without
being opaque — never a bare "reasoning" pill), tool cards paired to results by id (E11; positional fallback labelled
approximate for old runs), terminal cards with ANSI (§9.8) — and **no fabricated exit
codes**: render `exit code N` only when the adapter reported one; otherwise omit the line
entirely (rendering `isError?1:0` as if measured is fabrication). `mail-in` /
`mail-out` records render as distinct steering markers with origin and delivery verdict.
`status` records render as muted system lines. `raw` records render as a collapsed "n
unparsed provider lines" group. Unknown future kinds render as a neutral raw-JSON row —
never dropped, never mistaken for success.

Footer: the **steer composer** is enabled **iff the agent's folded state is exactly
`running`** (the engine's `findJob` resolves only jobs inside `sem.with`,
src/engine.js:670, :948 — a queued agent is not steerable; critique M11). For a `queued`
agent the composer renders disabled with "agent hasn't started yet — steering opens when
it runs" plus its queue position from the E4 `sem` gauge. When enabled: one-line input,
`Cmd+Enter` sends (§7.2), the delivery verdict (`live`/`queued`/`dropped`) toasts inline
and appends to the timeline; a per-agent `Cancel` button. A working indicator
("Thinking…" after reasoning, "Working…" otherwise — parity #95) that is *never* shown
inside a dead run (parity #58).

Per-row timestamps: every row shows a relative time on hover and an absolute time in a
gutter at minute boundaries.

#### 2.5.1 Transcript card specifications (parity #73, #77–#82, #93, #96, #107)

- **Terminal cards** (#73): the command line clamps to two lines collapsed, expandable by
  click; a `mouseup` that follows a text selection (`window.getSelection()` non-collapsed)
  does not toggle. Exit code line per §9.8 (only when reported).
- **Generic tool cards** (#77): tool name header; JSON-object inputs render one
  `key: value` row per argument, objects/arrays pretty-printed 2-space in a mono block;
  non-JSON inputs render as a single mono block. Result or error below, error-tinted.
- **Long headers** (#78): a tool-argument header taller than 3 lines clamps with a
  bottom gradient fade and a "Show more" affordance; expanded state persists per row.
- **File-change cards** (#79–#82): one row per file with action icon and past-tense verb
  (created/deleted/renamed/edited), the path, and a `+N −M` tally computed from the diff
  body; diff bodies render addition/deletion/patch-metadata line classes; stats handle
  unified diffs, whole-file create/delete, and diffs synthesized from Edit/Write args
  (#81); a file change with no derivable diff renders an explicit "no diff available"
  card (#82), never an empty one.
- **Manual expand/collapse** (#93): every row and step group can be toggled manually;
  the manual choice is recorded per row id and **always wins** over the §9.6 automatic
  rule until the row leaves the 8 MiB window (eviction clears the map entry).
- **Failed-agent error card** (#96): a failed agent renders its error (message + E5
  code, retryable flag) as a distinct error card pinned below the last transcript row,
  in addition to the header state.
- **Scroll fades** (#107): scroll containers (transcript, log lane, rails, wells) show
  top/bottom fade affordances only when content is actually clipped in that direction,
  driven by scroll metrics, not always-on gradients.

### 2.6 Result view (`#/run/:id/result`)

Renders the result route's payload (§5.4.5): `completed` → the result value: strings
render as safe markdown with a raw toggle; objects render as a collapsible JSON tree with
copy-subtree, **capped at depth 32 and 20,000 rendered nodes** with a "download raw"
fallback beyond either cap (Sol-8 — a recursive tree on a hostile value must not exhaust
the stack or the frame budget). Values over the route's 1 MiB inline cap render the
bounded preview plus a download link to `GET …/result/raw`. `failed`/`interrupted` → the
error, prominently, with a Resume button. Pending (no result yet) → live state chip +
"no result yet". This entire screen exists because a run's product is otherwise the one
thing a viewer never shows.

### 2.7 Keyboard & command palette

`j/k` move through runs (home) or agents (cockpit); `Enter` opens; `Esc` closes panel /
drawer; `[` `]` switch cockpit tabs; `/` focuses search; `a` focuses the first open
question's answer box; `l` toggles log lane; `d` toggles theme (ignored while typing —
parity #111); `?` opens the shortcut overlay. `Cmd/Ctrl+K` command palette: jump to any
run or agent by fuzzy name, invoke actions (answer, cancel, resume, theme). Every
interactive element reachable by Tab; focus is moved into panels when they open and
restored on close (§3.6).

---

## 3. Visual design direction

The bar: it must look **designed** — a purpose-built instrument, not a template. The
aesthetic is "flight-deck instrument": calm, dense, engineered; color is reserved for
state, so when something needs you, it is the only saturated thing on screen.

### 3.1 Typography

- **UI:** IBM Plex Sans (variable, self-hosted woff2, vendored — no @fontsource package).
  Technical, characterful, excellent at 12–14px. `font-feature-settings: 'tnum'` on all
  numeric cells.
- **Data/mono:** JetBrains Mono (variable, vendored). Transcripts, ids, tokens, code.
- Scale (px): 11 (micro labels), 12 (meta rows), 13 (body/UI default), 14 (transcript
  prose), 16 (panel titles), 20 (screen title), 24 (empty-state display). Line-height
  1.45 prose, 1.3 UI rows. Weights: 400/500/600 only.
- Fonts self-hosted; the viewer makes **zero third-party network requests** (parity #115).
  Total font payload ≤ 300 KB woff2 (subset latin + latin-ext).

### 3.2 Color system

All tokens in OKLCH as CSS custom properties on `:root` / `[data-theme=dark]`. Neutrals
derive from two anchors per theme via `color-mix(in oklab, var(--ink) N%, var(--canvas))`
(the two-anchor technique): moving the canvas moves
every surface coherently.

**Interpolation space: `in oklab`, not `in oklch` — AMENDED in W8b per the W8a sign-off
(comps/README.md deviation D1, ruled to stand).** The previous revision of this section
wrote `in oklch`, which produces the wrong colors in the light theme: OKLCH interpolates
hue along an arc, and the light anchors are 160° apart (`--canvas` H=95 warm paper,
`--ink`/`--accent` H=255 blue). `color-mix(in oklch, var(--accent) 10%, var(--canvas))`
therefore lands on H=111 and paints `--surface-selected` **`#e9eadc`, a pale green**; in
OKLab the same mix is `#e1e8ef`, the intended cool tint. The neutral ramp is affected too,
less visibly (hairlines drift green at C≈0.005). The anchor technique itself is unchanged.
`viewer/src/ui/tokens.test.ts` pins that no `color-mix(in oklch, …)` reaches the emitted
stylesheet.

**The token values below are the SPEC BASELINE; the shipped values are
`viewer/src/ui/tokens.ts`, which carries the nine approved W8a deviations (D1–D9).** Seven
are contrast fixes this section's own §3.6 requires — the light theme as tabulated here
does *not* pass 4.5:1 for `--accent` as link text or for five of six saturated status
colors, and `stale` fails at 2.77:1. The dark theme is this table verbatim. Every
deviation moves L only, never hue or chroma, and each is argued per-token in
`docs/frontend/comps/README.md`. The §3.6 gate is normative and runs in the viewer suite.

| Token | Light | Dark |
|---|---|---|
| `--canvas` | `oklch(0.975 0.004 95)` warm paper | `oklch(0.165 0.012 255)` deep blue-black |
| `--ink` | `oklch(0.21 0.015 255)` | `oklch(0.93 0.006 95)` |
| `--surface` (cards) | ink 3% | ink 4% |
| `--surface-raised` | ink 6% | ink 7% |
| `--surface-selected` | accent 10% | accent 14% |
| `--hairline` | ink 12% | ink 14% |
| `--accent` | `oklch(0.55 0.15 255)` | `oklch(0.72 0.13 255)` |

**Status semantics** (the only saturated colors in the resting UI):

| State | Hue | Light | Dark | Glyph |
|---|---|---|---|---|
| queued | neutral | ink 45% | ink 55% | dashed circle |
| running | blue | `oklch(0.58 0.16 250)` | `oklch(0.70 0.14 250)` | spinning dashed circle |
| done | green | `oklch(0.58 0.14 150)` | `oklch(0.70 0.13 150)` | check circle (suppressed in quiet lists) |
| cached | teal | `oklch(0.60 0.11 190)` | `oklch(0.72 0.10 190)` | replay arrow-circle |
| failed | red | `oklch(0.55 0.20 25)` | `oklch(0.66 0.19 25)` | x circle |
| cancelled | neutral | ink 50% | ink 55% | slashed circle |
| stale | amber | `oklch(0.66 0.15 75)` | `oklch(0.76 0.14 75)` | alert triangle |
| blocked (open ask) | violet | `oklch(0.56 0.17 300)` | `oklch(0.70 0.15 300)` | question circle |
| steered | violet (annotation, never a state) | same | same | envelope tick |

Rules inherited from the recon judgments: an **unknown state renders the neutral info
glyph, never a success check** (parity #56); the steered event is an *annotation* on an
agent, not a state transition (the client fold must not let a `steered` event overwrite
`running` — note `foldEvents` at src/events.js:52 does exactly that; our fold fixes it, §6.4).

**Adapter glyphs** — two-letter monogram badges in per-adapter hue, 16×16 rounded square,
600-weight 9px Plex Sans. Never a vendor's brand mark (parity #57):

| Adapter | Badge | Hue (light / dark) |
|---|---|---|
| claude | `CL` | `oklch(0.62 0.13 40)` / `oklch(0.72 0.12 40)` coral |
| codex | `CX` | `oklch(0.60 0.11 220)` / `oklch(0.72 0.10 220)` cyan |
| amp | `AM` | `oklch(0.68 0.12 85)` / `oklch(0.78 0.11 85)` amber |
| droid | `DR` | `oklch(0.64 0.13 130)` / `oklch(0.74 0.12 130)` lime |
| opencode | `OC` | `oklch(0.58 0.13 295)` / `oklch(0.70 0.12 295)` violet |
| pi | `π` | `oklch(0.60 0.13 350)` / `oklch(0.72 0.12 350)` rose |
| mock | `MK` | neutral ink 40% |
| unknown | `·` | neutral ink 40% |

**Terminal wells** (ANSI output) render on a fixed dark surface **in both themes**
(`oklch(0.19 0.01 255)` well, `oklch(0.90 0.005 95)` default text) with a full 16-color
ANSI palette tuned for that well only. This makes 256-color/truecolor passthrough safe
without a per-theme contrast rewrite pass, and reads as intentional (a terminal is a
terminal). Decision final.

### 3.3 Spacing, density, layout

4px base scale: 4/8/12/16/20/24/32/48. Rows: run list 44px, agent table 32px, transcript
gutter 12px. Panels separated by hairlines + subtle shadow on raised surfaces — elevation
is border+shadow, never tint. Max content column in transcripts 88ch; tool/terminal cards
may break out to panel width. Desktop-first; below 900px the cockpit rails collapse into
drawers and the transcript replaces the cockpit (parity #42 behavior).

### 3.4 Motion

Durations 120ms (hover/press), 160ms (disclosure), 200ms (panel slide); easing
`cubic-bezier(0.2, 0, 0, 1)`. Collapse retains the closing body for the transition
(parity #94). The running-state spinner is the only looping animation. Live-value changes
(token counters) tick without animation — numbers just change; a brief 300ms background
pulse (accent 8%) marks a row whose state changed. `prefers-reduced-motion: reduce` kills
every transition and the spinner (replaced by a static half-dashed circle).

### 3.5 Iconography

**AMENDED in W8b per the W8a sign-off ruling 2: the sprite is 43 glyphs, and "~24" below
was an estimate, not a budget.** The extra 19 are load-bearing — 11 status marks rather
than 9 (the nine §3.2 states plus `unknown`, which parity #56 requires to be a neutral
info circle and never a success check, and `orphaned`, which §6.4 step 8 / parity #58
requires for an agent stranded in a dead run), the four file-action glyphs §2.5.1 #79
requires, `chevdown` as its own symbol (a rotated `chevron` would inherit the disclosure
transition and animate when it must not), and `terminal`/`tool`/`reasoning`/`clock`/
`drag`/`bolt` for transcript card headers, the wait column, resize handles and the budget
badge. **AMENDED further: the sprite is rendered into the document by `<IconSprite/>`
rather than fetched from `public/icons.svg`** — `<use href="/icons.svg#id">` is an
external resource load and §7.1.4's `default-src 'none'` admits no directive for it, so
browsers block it; same-document `<use href="#i-name">` needs none.

One hand-authored SVG sprite (`icons.svg`, ~24 glyphs, 1.5px stroke, 16/20px grid): status
set (§3.2), chevron, copy, check, close, search, send, cancel, resume, trash, external,
question, mail, filter, columns, gantt, tree, table, keyboard, sun/moon. No icon library
dependency. Every glyph `aria-hidden` with an adjacent visually-hidden label or an
`aria-label` on the interactive parent.

### 3.6 Accessibility — requirements, not aspirations

Verified in W13; failing any of these blocks release:

- **Contrast:** all text ≥ 4.5:1 against its surface; UI components/glyph strokes ≥ 3:1
  (WCAG 2.2 AA). The token table above was chosen to pass; W8 includes an automated
  check of every (fg, bg) token pair in both themes.
- **Keyboard:** every action reachable without a pointer (§2.7); visible
  `:focus-visible` ring (2px accent, 2px offset); no positive tabindex; roving tabindex
  in the run/agent lists.
- **Focus management:** opening a panel moves focus to its header; closing restores it.
  The confirm dialog is a focus trap (`role=dialog aria-modal`).
- **Screen readers:** run/agent lists are `role=list`; state conveyed by text, not color
  alone (glyphs carry labels); the transcript's live frontier is wrapped in an
  `aria-live=polite` region **throttled to one announcement per 5s** summarizing activity
  ("agent 3: running Bash") — never the raw stream; toasts are `role=status`.
- **Reduced motion** per §3.4; `prefers-contrast: more` bumps hairlines to ink 25%.

### 3.7 Composition — the designed whole (Sol-16)

Tokens alone don't reproduce a design; the page grid and default states are normative:

- **Cockpit grid (≥1280px):** run rail 280px (drag 200–480) | main column (fluid,
  min 640) | inbox rail 320px (drag 260–420). Log lane overlays the main column bottom
  at 240px default (drag 160–50vh). Transcript split: 55/45 default, drag-persisted.
  900–1280px: inbox rail collapses to an icon strip; <900px: rails become drawers,
  transcript replaces cockpit (§3.3).
- **Default states:** run rail open; inbox rail open iff there are open questions or
  unread mail, else collapsed; log lane closed; Timeline tab active. These are the
  states the reference comps show.
- **Action hierarchy:** exactly one primary-accent action per screen region — the
  answer composer's Send in the inbox, the steer composer's Send in the transcript
  footer. Cancel/Resume/Delete are quiet (outline) buttons; Delete additionally
  red-text. Nothing else is saturated at rest (§3's color rule).
- **Reference comps (W8 entry gate):** before W8 implementation starts, the W8 lane
  produces annotated static comps (HTML or image, checked into `docs/frontend/comps/`)
  for four canonical states — attention-heavy Home, live cockpit with running Gantt,
  failed/stale cockpit, two-panel transcript compare — at 1440px and 800px. The human
  reviewer approves the comps; W8/W11 acceptance then includes a side-by-side of built
  screens against the approved comps at those viewports. Token fidelity alone does not
  pass W8.

---

## 4. System architecture

### 4.1 Process model

The viewer is **one long-lived Node process** serving HTTP on loopback, reading run dirs
under `runsDir()` (src/util.js:10) and bridging to per-run control sockets. It never
holds a run lock, never imports `runWorkflow`, and never executes a workflow module
(RECON-flowition §7). It coexists with detached runs trivially: files are read-only
tails; control operations are one-shot socket requests exactly like the CLI's `ctl()`
(src/cli.js:58–64).

Startup ownership check (critique M17): `stat(home())` and `stat(runsDir())`; on ENOENT
create the missing dir with `mkdirSync({recursive:true, mode:0o700})` and proceed (a
fresh install has neither — src/util.js:26's `ensureDir` only runs on the run path); on
any other stat error, refuse with the error; on `uid !== process.getuid()`, refuse with
a clear message — `deriveRunState` mutates aged `.resuming` markers
(src/run-state.js:99,110) and must run as the run owner (RECON-flowition §6.3.9). The
check covers `home()` too because `viewer.token` (§7.1.2) lives there; a token file
created into a fresh home is asserted 0600 by test.

### 4.2 CLI surface

```
flowition viewer [--port N] [--control[=caps]] [--idle-shutdown] [--idle-timeout M]
                 [--open] [--print-url] [--json]
```

- Default port **4646** (`FLOWITION_VIEWER_PORT` overrides). `--port 0` binds an
  ephemeral port, **skips the collision walk entirely**, and prints/returns the resolved
  port (parity #28; §11.4 uses this). Host is always `127.0.0.1`; there is no `--host`
  flag (DECISION — see §7).
- **`--control[=send,answer,cancel,resume,delete]`** enables the write surface (§7.2).
  Default (no flag): the server is **read-only** — mutation routes return
  `403 forbidden`. Bare `--control` enables all five capabilities; the list form enables
  a subset. This replaces the previous revision's writes-on-by-default DECISION (Sol-1).
- Foreground by default; prints to stderr:
  `viewer: http://127.0.0.1:4646/#/?t=<token>  (reading ~/.flowition/runs)` — the §2.2
  grammar. `--json` prints `{url, port, home, control}` on stdout (token in `url` only).
- `--print-url`: verify a live viewer via the §4.2.1 authenticated probe, reprint its
  URL and exit; else exit 1.
- `--idle-timeout M` (minutes, default 15) configures §4.4 (parity #30).
- `--open`: after startup (or reuse), write a **0600 bootstrap file**
  `$FLOWITION_HOME/open-<random>.html` containing only a
  `<meta http-equiv="refresh">`/`location.replace` hop to the tokenized URL, spawn the
  platform opener (`open` on darwin, `xdg-open` on linux; never block, failure only
  warns) with the **file path** as its argument, and unlink the file after 10 s. The
  token never appears in any process argv (Sol-2; parity #35 — Windows dispatch omitted
  per §1.3's platform scope, documented in §14).
- SIGINT/SIGTERM close the server and exit. The library layer
  (`startViewer(opts) → {url, port, close}`) never calls `process.exit` (parity #29).
- On successful bind, the server writes `$FLOWITION_HOME/viewer.json` (0600, tmp+rename):
  `{pid, port, startedAt, control: <caps>}` — the rendezvous file — and unlinks it on
  clean shutdown. Port collision on a fixed port: try 4647–4655, then error; the
  rendezvous file always records the port actually bound.

#### 4.2.1 Instance discovery & reuse (normative — Sol-2)

An unauthenticated `/healthz` response is **readiness data only** — it authenticates
nothing, and no token-bearing URL may ever be printed on its evidence: another local
user could bind the predictable port, mimic the JSON, serve attacker JavaScript, and
read the token from `location.hash`. Discovery is instead:

1. Read `$FLOWITION_HOME/viewer.json` (0600 — same-user only). Missing/unparseable →
   no instance.
2. Read (or create, `O_EXCL` 0600) `$FLOWITION_HOME/viewer.token`.
3. **Challenge probe:** `GET http://127.0.0.1:<port>/healthz` with header
   `x-flowition-challenge: <32 random bytes, base64url>`. A genuine viewer answers
   `{app, version, proof: hmacSHA256(token, challenge)}` (hex). The caller verifies
   `proof` against the token it read itself. The token is **never sent** in the probe —
   an impersonating listener learns nothing and cannot fabricate `proof`.
4. Proof valid → reuse: print the URL built from the caller's own token. Proof
   absent/invalid → not ours: do not print anything token-bearing; a starting caller
   picks the next port.

A root-suite test runs a fake listener that returns the previous revision's healthz
shape (app + homeHash) and asserts auto-start refuses to reuse it and never emits the
token (§11.2).

### 4.3 Auto-start on `flowition run`

Parity #32–35, scoped safely: auto-start happens **only** for foreground, human-attended
runs — `run` without `--detach`, without `--json`, without `--quiet`, with
`process.stderr.isTTY`, and not disabled by `--no-viewer` or `FLOWITION_NO_VIEWER=1`.
MCP and detached paths never auto-start. Behavior:

1. The CLI allocates the run id itself (E16): `runId = flags['run-id'] ?? shortId('flo')`
   and passes it to `runWorkflow` as `opts.runId` (accepted today, src/engine.js:617) —
   the deep link is knowable **before** the run starts (Sol-6; previously the fresh id
   was born inside the engine and surfaced only at completion, src/cli.js:163).
2. Discover a live instance per §4.2.1 (rendezvous file + challenge probe, 500 ms
   timeout). Reuse on valid proof — including a read-only instance (starting a second
   would be worse); the SPA shows its "controls locked" chip (§7.2).
3. Else spawn the viewer detached — `spawn(process.execPath, [binPath, 'viewer',
   '--idle-shutdown'], {detached, stdio:'ignore'})` with `binPath` resolved
   module-relative exactly like `launchDetached` (src/mcp.js:47–55; never a literal
   `node` — critique N6) — then poll for `viewer.json` + a valid challenge proof, up
   to 5 s.
4. On verified-up only, print `view: http://127.0.0.1:<port>/#/run/<runId>?t=<token>`
   to stderr (§2.2 grammar). If it never came up, print nothing (parity #34 — never
   print a dead URL). Run startup is never blocked; discovery/spawn runs concurrently
   with the run. Auto-start **never passes `--control`** — an auto-started viewer is
   read-only until the operator opts in (Sol-1).

### 4.4 Idle shutdown

Only when started with `--idle-shutdown` (the auto-start path always passes it). Every
30s: active = (SSE clients > 0) OR (a cached run state is `running`/`starting` **and**
that run's `events.jsonl` mtime advanced within the idle window — a "running" verdict
with a static event log for the whole window does not count, so a SIGSTOPped engine or
a reused-pid lock holder (the accepted residual at src/run-state.js:23–26) cannot pin
the viewer alive forever, critique N11). After `--idle-timeout` minutes (default 15)
inactive → close server, exit 0. Timer `unref()`d (parity #30).

### 4.5 Module map

```
src/viewer/                     server — node: builtins ONLY, plain ESM (ships in files[])
  index.js       startViewer(opts) → {url, port, close}; wiring; idle shutdown;
                 rendezvous file write/cleanup (§4.2)
  http.js        request pipeline: host check → static|api split → auth → origin →
                 route dispatch → error envelope
  auth.js        token load/create (0600), constant-time compare, healthz HMAC proof
                 (§4.2.1), capability gate (§7.2)
  routes.js      route table + handlers (delegating to the modules below)
  summaries.js   run listing: readdir, per-run summary cache, pagination
  snapshot.js    RunDetail assembly: fold + journal join + deriveRunState (throttled)
  fold.js        PURE event-fold → viewer types (shared with the SPA verbatim, §6.4)
  journal-view.js incremental journal reader: meta first-line fast path (§5.4.2),
                 usage-cum tracker, result/answer/mail indices (read-only, never
                 repair:true)
  tail.js        PURE byte-domain chunked tailer (§5.6.6: 1 MiB reads, torn lines,
                 multibyte, rotation) — `flowition tail` is refactored onto it (W5)
  cursor.js      PURE composite cursor encode/parse
  stream.js      multiplexed SSE: subscriptions, watchers+poll, batching, backpressure
  pages.js       windowed byte-range JSONL pages: transcripts, events (§5.4.4, §5.4.6)
  search.js      bounded async in-run search across transcripts + events (§5.4.7)
  control-bridge.js  send/answer/cancel via controlRequest; resume via detached spawn
  audit.js       append-only 0600 mutation audit log (§7.3)
  static.js      asset serving from viewer/dist: traversal defense, CSP, content types
src/retention.js removeRun()/pruneRuns() guards (E13) — shared by CLI rm/prune and viewer
viewer/                         SPA — its own npm package, devDependencies only (§9)
  src/…  dist/  (dist committed + shipped)
```

`fold.js`, `tail.js`, `cursor.js` are pure (no fs, no net) — unit-tested exhaustively in
the root suite, and `fold.js` is imported by the SPA build directly (one fold, two
consumers — a client-side fold port, the classic drift source, cannot exist).

### 4.6 Packaging

**DECISION:** frontend toolchain as devDependencies of `viewer/` (npm, not pnpm — one
package manager, no bridge script), `viewer/dist/**` **committed** and added to root
`package.json#files`. Root `dependencies` stays absent (package.json:1–57 has none today;
that invariant is CI-enforced by a test asserting `pkg.dependencies === undefined`).

Argued (per constraint #1): shipping prebuilt assets keeps `npm i -g flowition`
zero-install-cost and the runtime path zero-dep, at three honest costs — (1) stale dist
can silently ship an old UI → neutralized by a CI job that rebuilds and fails on hash
mismatch with the committed dist (W14); (2) pack size grows ~300 KB gzip → acceptable;
(3) UI contributors need the toolchain → acceptable, the engine remains toolchain-free.
The no-build-ESM alternative was weighed and **rejected**: it forces hand-rolling
virtualization and gives up TypeScript and component tests, and its main benefit (repo
purity) is preserved anyway because `viewer/` is an isolated leaf the runtime never touches.

---

## 5. Server design

### 5.1 Principles

1. **Never trust an id:** every runId flows through `runDir()` (src/util.js:17–21), the
   single validation choke point. Percent-decoded exactly once before validation; a
   failure is `400 bad_request`, never a path join.
2. **Lossy readers only:** events/transcripts via byte-domain tailing that skips torn
   lines (the writers are `appendFileSync` with no fsync — src/util.js:28,
   src/transcript.js:19); the journal via `journal-view.js` which never passes
   `repair:true` (that flag mutates the file and is engine-only under the run lock,
   src/util.js:69–71, src/engine.js:786).
3. **Reuse `deriveRunState`, never reimplement** (src/run-state.js:116–195) — throttled
   ≥2s per run, and only for runs not already cached as terminal (§5.5).
4. **JSON in, JSON out.** The API never emits HTML. **Request** bodies ≤ 256 KB
   (413 beyond). Response sizes are bounded **per route** — pagination, tail slices,
   and inline caps are specified in §5.4; no route may inline an unbounded file or
   journal value (Sol-8). No request or response bodies are ever logged (they contain
   transcript content by definition).

### 5.2 Error envelope

Every non-2xx API response:

```ts
interface ApiError { error: { code: ErrorCode; message: string; runId?: string } }
type ErrorCode =
  | 'bad_request'      // 400 — malformed id, params, body, cursor
  | 'unauthorized'     // 401 — missing/wrong token
  | 'forbidden'        // 403 — host/origin check failed, or capability disabled (§7.2)
  | 'not_found'        // 404 — run/agent/resource absent
  | 'conflict'         // 409 — e.g. resume while running, delete while live
  | 'gone'             // 410 — run dir vanished mid-request
  | 'payload_too_large'// 413
  | 'run_not_live'     // 503 — control socket absent/refused (retryable)
  | 'internal'         // 500 — message is generic; details never leak
```

### 5.3 Route table

All under `/api`, all token-authenticated (§7.1). `GET/HEAD` only except where noted.
Non-matching `/api/*` → 404 JSON; non-GET/HEAD on read routes → 405 (parity #27).

| Route | Purpose |
|---|---|
| `GET /healthz` | **No auth.** Readiness + challenge proof: `{app:'flowition-viewer', version}`, plus `proof` when an `x-flowition-challenge` header is present (§4.2.1). Never trusted for reuse without a valid proof; carries nothing sensitive. |
| `GET /api/session` | `{version, home, control: string[], readOnly}` — the SPA's bootstrap: which capabilities are enabled (§7.2) |
| `GET /api/runs?limit&cursor&state&q` | Paged `RunSummary[]` (§5.4.2) |
| `GET /api/runs/:id?include=args` | `RunDetail` snapshot (§5.4.3) |
| `GET /api/runs/:id/stream?streams&agents&cursor` | Multiplexed SSE (§5.6) |
| `GET /api/runs/:id/agents/:n/page?from&maxBytes` | Windowed transcript page (§5.4.4) |
| `GET /api/runs/:id/agents/:n/result` | One agent's full journaled result value, bounded (§5.4.5) |
| `GET /api/runs/:id/result` | Bounded result.json projection or `{pending, state}` (§5.4.5) |
| `GET /api/runs/:id/result/raw` | result.json streamed verbatim as a download (§5.4.5) |
| `GET /api/runs/:id/events/page?from&maxBytes` | Windowed events page — log-lane & mail history paging (§5.4.6) |
| `GET /api/runs/:id/search?q&limit` | In-run search (§5.4.7) |
| `POST /api/runs/:id/send` | Steer an agent (§7.2; requires `send` capability) |
| `POST /api/runs/:id/answer` | Answer an `ask()` (§7.2; `answer`) |
| `POST /api/runs/:id/cancel` | Cancel agent or run (§7.2; `cancel`) |
| `POST /api/runs/:id/resume` | Detached resume/replay (§7.3; `resume`) |
| `DELETE /api/runs/:id` | Guarded delete-to-trash (§7.3; `delete`) |
| anything else | Static SPA assets (§5.8) |

### 5.4 Read routes, precisely

#### 5.4.1 Shared parameter validation

`:id` flows through `runDir()` (§5.1 principle 1); `:n` must be a canonical non-negative
integer (reject `03`, `1e2`, negatives). `from`/`maxBytes`/`limit` must be canonical
non-negative integers within their documented ranges; `cursor` parses per §5.6.2.
Violations → `400 bad_request`. `?include=args` on RunDetail: without it, `args` is
**absent** (not null) and `hasArgs` says whether one exists; with it, the full value is
inlined (≤ 1 MiB; beyond that `{argsTruncated: true}` and the value is omitted). Args
responses carry `cache-control: no-store` like all API responses and an `args-read`
audit line (§7.3) so secret reads are traceable (critique N2).

#### 5.4.2 `GET /api/runs`

Params: `limit` (default 50, max 200), `cursor` (opaque base64url of
`{createdAt, runId}` — keyset pagination, no offsets), `state` (comma list to filter),
`q` (substring over name/runId). Response:

```ts
interface RunsPage { runs: RunSummary[]; nextCursor: string | null; totalOnDisk: number }
```

Listing algorithm (this is the 5,000-runs answer):

1. `readdirSync(runsDir(), {withFileTypes:true})` — **unfiltered** (the CLI's
   `startsWith('flo_')` filter hides `--run-id` runs, src/cli.js:200; G19). Keep every
   directory whose name passes `runDir()` (try/catch) — **including dirs with no
   journal or events yet** (parity #2; the state `detachRun` leaves between `ensureDir`
   at src/cli.js:113 and the child's first append). Such dirs list with the state
   `deriveRunState` gives them (`unknown` for a bare dir, src/run-state.js:194), zero
   agents, `createdAt` per step 3's fallback — consistent with §5.4.3's skeleton detail
   (parity #7).
2. Per-run summary from a two-tier cache:
   - **Meta tier:** when a journal `meta` record exists it is unique and always the
     *first* line — the engine writes it before any other record on a fresh run
     (src/engine.js:828), refuses a fresh run against an existing journal
     (src/engine.js:764–766), and never writes meta on resume. But the first line is
     **not always meta**: early preflight failures write a lone `end` record first —
     control-socket bind failure (src/engine.js:739) and unreadable workflow file
     (src/engine.js:775) — and such journals are *frozen* (resume refuses meta-less
     journals, src/engine.js:789; fresh runs refuse existing journals), so:
     read the first complete line only; `type:'meta'` → cache the meta; any other
     parsed type → cache `meta: null` (render from events + deriveRunState); torn/
     unparseable first line → cache nothing, retry next pass. Cache key is
     `(path, dev, ino)` of `journal.jsonl` — **not** path alone — so a run deleted and
     recreated under the same id (routine once E13's `rm` exists) invalidates by
     identity change (critiques B3 / Sol-17).
   - **Fold tier**: keyed on `(size, mtimeMs)` of `events.jsonl` — a `(size,mtime)`
     cache with its critical correction: **the cached summary stores the
     raw folded status; liveness is re-derived per the tier rules below** (parity #3–4).
3. Sort `createdAt` desc — journal meta first; fallback `birthtimeMs` of
   `journal.jsonl`, then of the run dir, then `0`. **Never directory mtime** — it bumps
   on every entry create/unlink inside the dir (markers, tmp files, `control.sock`),
   which would reorder pagination mid-scroll (critique M16). The resolved `createdAt`
   is pinned for the process lifetime keyed on `(path, ino)` so keyset pagination over
   `(createdAt, runId)` cannot skip or duplicate rows. Slice by cursor+limit.
4. Cache entries for vanished dirs pruned each pass (parity #5).

**State-cache tiers (critiques M1/M4/Sol-5).** `deriveRunState`'s own terminal set is
`{completed, failed, interrupted}` (src/run-state.js:9). The summary cache classifies:

- **Settled** (`completed|failed|interrupted`): skip `deriveRunState`, but only after
  two cheap existence stats confirm **both `.resuming` and `run.lock` are absent** —
  the foreground resume paths (`flowition resume`, src/cli.js:174; `run --resume`,
  src/cli.js:147) write **no** marker (only the detached launchers do,
  src/cli.js:120–123, src/mcp.js:137–140), but every resume takes the run lock before
  its first journal read (src/engine.js:592, acquireRunLock at :48), so a present
  `run.lock` is the earliest resume signal and forces a full re-derive. Also
  invalidated by any `events.jsonl` (size,mtime) change.
- **Quiescent** (`stale|unknown|corrupt-result`): not terminal, but nothing changes
  them without a lock or marker appearing — re-derive on a ~30 s TTL, with the same two
  stats checked each request (a marker/lock appearing re-derives immediately). This
  keeps 500 stale runs from costing ~7 syscalls + a 300 ms socket-probe ceiling each,
  every 2 s (critique M4). The TTL is **deterministically jittered per run** (±25%
  around 30 s, FNV-1a over the run directory — not `Math.random()`, so a run keeps the
  same deadline across requests and restarts): quiescent runs are typically all
  classified in the same cold request, and a single fixed TTL would make the whole
  population expire together, dumping every re-derive on one later request — an expiry
  herd P2 measured as a 143 ms spike on an otherwise ~75 ms steady state. The spread
  bounds any 5 s poll window to roughly a third of the herd while preserving the
  amortized ~1/30 s probe rate per run.
- **Live** (`running|starting`): re-derive at most every 2 s.

The `(size,mtime)` stats for events and journal are amortized over 6 s for signal-free
settled/quiescent entries. This does not delay any legal resume: the engine creates the lock
before its first journal read, and a detached launcher creates the marker even earlier, so
either immediate existence check bypasses the artifact TTL. Out-of-band edits are visible
within 6 s. The window is deliberately longer than the runs list's 5 s client poll, so
at least one production poll reuses artifact metadata before the next refresh.

Cost at 5,000 runs, steady state at the shipped 5 s poll cadence: one root readdir + ≤2 existence stats
per settled run per request (marker, lock), zero journal parses, zero socket probes for settled
runs; quiescent runs add their probe cost at ~1/30 s each, desynchronized by the
per-run TTL jitter so the population never re-derives in one request. Probes every 2 s only for the
(few) live runs. P2 (§10) is stated against this mix, and its fixture includes 10%
stale runs so the budget is tested against the expensive case.

#### 5.4.3 `GET /api/runs/:id`

Returns `RunDetail` (§6.2): the event fold (§6.4) + journal join (§6.4.J) +
`deriveRunState` + **resume offsets** `{events, journal}` = byte offsets after the last
complete line consumed, which the client passes straight into the SSE cursor (snapshot-
then-tail: an open of a finished 500 MB run replays *nothing* over SSE — the whole-file
replay is the failure mode this design exists to avoid). Also `caps` (§6.5). `logs` and `mail` are **bounded tails** — the most recent 200
of each plus `logTotal`/`mailTotal` counts; older history pages backwards via §5.4.6
(Sol-8: RunDetail must not inline an unbounded log stream). 404 with envelope when the
dir doesn't exist; a dir with no events yet returns a valid skeleton detail (`state`
from deriveRunState, empty agents — parity #7).

Fold-cost control: the folded snapshot is cached per run keyed on `(events size, mtime,
journal size, mtime)` and **updated incrementally** — new bytes are folded onto the cached
snapshot, not re-parsed from zero (both files are append-only; a shrink resets the cache).
A 10 MB events file folds once, then every poll is a delta.

#### 5.4.4 `GET /api/runs/:id/agents/:n/page`

Windowed transcript: `from` = byte offset, or `tail` (default: last complete lines within
`maxBytes` of EOF), or `0`; `maxBytes` default 2 MiB, max 8 MiB. Response:

```ts
interface TranscriptPage {
  items: { o: number; rec: TranscriptRec }[]  // o = byte offset after the record's newline
  start: number; end: number                  // byte window actually parsed
  size: number; eof: boolean
}
```

Only complete lines are parsed (byte-domain split); a window starting mid-line skips
forward to the first newline. 404 when the file doesn't exist yet (parity #9 — the
client treats it as "no transcript yet", it may appear later; the full transcript is
obtainable by paging from 0 to EOF, which supersedes a whole-file transcript route —
§14). This route is how a 500 MB transcript opens instantly: the client fetches the
tail page, virtualizes, and pages backwards on scroll.

#### 5.4.5 Result routes (bounded — critiques M8/Sol-8)

- `GET …/result`: if `result.json` exists and parses → `200 {runId, status,
  resultBytes, result?|error?}` where `result` is inlined only when the file is ≤ 1 MiB;
  larger → `{resultTruncated: true, preview}` (first 64 KiB of the serialized value as
  a string) and the client offers `…/result/raw`. (tmp+rename writing guarantees
  never-partial, src/engine.js:640–642.) Unparseable → `200 {corrupt: true}` (the
  run-state layer already classifies `corrupt-result`, src/run-state.js:151). Absent →
  `200 {pending: true, state}` — not 404, because "no result yet" is a normal state the
  UI shows.
- `GET …/result/raw`: streams `result.json` verbatim with
  `content-type: application/json` and `content-disposition: attachment` — chunked
  `createReadStream`, never buffered whole.
- `GET …/agents/:n/result`: the full result **value** for one agent, from its **last**
  journal `result` record (last-wins, agreeing with `Journal.load`, src/journal.js:143;
  the compare-panels feature needs full values — `AgentView` itself carries only
  `resultPreview`). Same 1 MiB inline / preview+`resultBytes` contract as `/result`.
  Read via `journal-view.js`'s record index, never `Journal.load` (§5.1 principle 2).

#### 5.4.6 `GET /api/runs/:id/events/page?from&maxBytes`

The events counterpart of §5.4.4 — the same `TranscriptPage` shape over `events.jsonl`,
byte-domain windows of complete lines. This is how the log lane and mail history page
backwards past RunDetail's bounded tails (Sol-8); the client folds a page's
`log`/`mail` records with the same fold it applies to SSE batches. Same validation and
404-when-absent semantics as §5.4.4.

#### 5.4.7 `GET /api/runs/:id/search`

Case-insensitive substring `q` (2–256 chars) over `events.jsonl` + every
`agents/*.jsonl`, newest-file-first, scanning at most 64 MiB per request; response
`{matches: [{agent: number|null, o: number, kind: string, snippet: string}], truncated:
boolean}` capped at `limit` (default 100). Snippets are 160 chars centered on the match.
Regex search is deferred (risk of ReDoS on hostile transcripts; substring is safe).

**Scan mechanics (critique M9 — the server is single-threaded):** read via
`createReadStream` in 1 MiB chunks with an `await` between chunks (the event loop
breathes every ≤1 MiB), a 2 s wall-clock deadline that returns `{truncated: true}` with
whatever matched, and **one in-flight search per connection** — a concurrent second
search returns `409 conflict`. A root test asserts an SSE keepalive still lands on
schedule while a 64 MiB fixture is being searched (§11.2).

### 5.5 Watch vs poll

`fs.watch` is a **latency optimization, never a correctness mechanism** (the single most
important robustness lesson the design recon surfaced). Concretely:

- Per run with connected SSE clients: one non-recursive `fs.watch` on the run dir and one
  on `agents/` (created lazily — poll 250ms for the dir until it exists, then
  `realpath` before watching; if the resolved path is not a descendant of the
  `realpath`ed run dir, the watch is skipped and that stream is poll-only). Every
  watcher registers an `error` handler that downgrades to poll-only and logs once — an
  unhandled watcher error on a removed directory must never take the process down
  (critique N10). Watch events schedule an immediate drain of the touched stream.
- Regardless of watch: a 1s `setInterval` drain per connected run. A missed watch event
  degrades to ≤1s latency (parity #20). No recursive watch anywhere (unsupported on
  Linux Node 18).
- Run-state re-derivation for streamed runs every 2s (pushes `sys/state` frames, §5.6.4).
- The runs *list* is client-polled (5s) — no global watcher; the summary caches make the
  poll cheap.

### 5.6 Streaming: multiplexed SSE

**DECISION: SSE, one connection per run page, multiplexing all of that run's streams.**

Justification against the alternatives (required by the brief):

- **vs WebSocket:** WS buys bidirectionality we don't want — every mutation goes over
  POST for uniform auth/origin/audit treatment (§7). A zero-dependency WS server means
  hand-implementing RFC6455 framing/masking/ping; SSE is `res.write` on `node:http`.
  EventSource gives auto-reconnect with `Last-Event-ID` for free, which is precisely the
  resume semantics we need. Backpressure is identical either way (`res.write` → `drain`).
- **vs long-poll:** strictly worse: reconnect storms, no built-in resume header, per-poll
  header overhead on a stream that can carry thousands of frames.
- **The multi-file-tail problem** (a run = events.jsonl + journal.jsonl + N transcripts)
  is the real design forcer: per-file SSE endpoints hit the browser's
  ~6-connections-per-origin HTTP/1.1 cap with two transcripts + events + journal + a
  second tab. Multiplexing all files for one run over **one** EventSource with a
  composite cursor keeps the connection budget flat and gives one ordered delivery point
  for coalescing.

#### 5.6.1 Subscription model

`GET /api/runs/:id/stream?streams=events,journal&agents=3,7&cursor=<c>&token=<t>`

- `streams`: `events` (events.jsonl), `journal` (filtered journal feed, §5.6.5). Default both.
- `agents`: comma list of transcript indices to tail (0–8 of them; changing the set =
  close and reopen with a new query — the server is stateless per connection).
- `cursor`: composite start offsets. Absent → offsets from `?from` defaults: `events`/
  `journal` start at 0; agents start at `tail` unless `a<N>` given in the cursor. The
  client normally passes the snapshot's offsets (snapshot-then-tail).

#### 5.6.2 Cursor format

Human-readable, order-insensitive, versioned:

```
v1;e=182930;j=44100;a3=88211;a7=tail
```

`cursor.js` parses leniently: unknown keys ignored; malformed → treat as absent (full
restart semantics, flagged with a `reset` frame so the client drops buffers — the
fail-safe rule: ambiguity resolves to reset, which duplicates nothing).

**Resume precedence (normative — critiques M3/Sol-9):**

1. **`Last-Event-ID`, when present and parseable, always wins over `?cursor=`.** The
   query cursor is honored only on a connection with no `Last-Event-ID` header (the
   initial connect, or an explicit client `reopen()`, which builds a fresh URL from the
   client's latest composite cursor and carries no header). EventSource re-sends the
   original URL on native reconnect — honoring the stale query there would replay from
   the snapshot offset on every reconnect.
2. A `Last-Event-ID` that fails to parse → treated as absent → the `?cursor=` applies;
   if that is also absent/malformed → subscription defaults with a `reset` frame first.
3. Cursor components are compared and applied **per stream, never as a vector**: a
   header key naming a stream not in this connection's `streams`/`agents` sets is
   ignored (it does not reset the others); a stream absent from the cursor starts at its
   subscription default; a component offset greater than the stream's current file size
   (rotation while offline) triggers `sys/reset` **for that stream only, emitted before
   any of that stream's records**, then delivery from 0.

#### 5.6.3 Frame format

```
id: v1;e=183042;j=44100;a3=88530
event: batch
data: {"f":[{"s":"e","o":182991,"r":{...event rec...}},
            {"s":"a3","o":88530,"r":{...transcript rec...}}]}
```

- Frames batch up to 256 records or 64 KiB of JSON, whichever first; `id` is the
  composite cursor **after** the batch. EventSource reconnect therefore resumes exactly.
- Each record carries its own post-line byte offset `o` — the client can hand offsets to
  the transcript pager seamlessly.
- Keepalive comment `: ping` every 15s; `x-accel-buffering: no`,
  `cache-control: no-cache, no-transform` (parity #21).
- Teardown registered on `req.close`/`res.close`/error **before any awaited work**;
  idempotent; decrements the client count exactly once (parity #22).
- Backpressure: when `res.write` returns false, pause all tailers for this connection
  until `drain`. Never skip bytes; a slow client just lags.

#### 5.6.4 `sys` frames

`{"s":"sys","r":{...}}` carries out-of-band signals:

- `{type:'state', state, live?, detail?}` — deriveRunState delta (pushed on change, ≤1/2s).
- `{type:'reset', stream:'a3'}` — that file shrank/rotated (tail detected `size <
  offset`): client drops that stream's buffer and refetches its page. (parity #19)
- `{type:'gone'}` — the run dir vanished mid-stream: client shows "run was deleted",
  navigates home on ack; server closes the stream after sending it.
- `{type:'end'}` — server observed terminal fold + terminal deriveRunState + 2s of
  silence: the stream is complete and will close (the quiet-close contract, parity #100,
  #101). The client keeps polling the snapshot at 10s afterwards so a later `resume` is
  detected and re-opens the stream (parity #98–99).

#### 5.6.5 The journal feed (filtered)

The journal stream forwards **only**: `usage-cum` (live tokens; `{0,0}` is a reset
marker, not a datum — src/agent-proc semantics per RECON-flowition §1.4), `result`,
`session`, `answer`, `mail`, `mail-done`. `meta` is **not** streamed (it's served once
in RunDetail; `args` can contain secrets and doesn't belong in a long-lived stream
buffer). Records are forwarded raw with their offsets; folding happens client-side in
the shared fold.

**Per-record size cap (critique M8):** journal records are written with no truncation
(`appendJsonl`, src/util.js:28) — an agent returning a large structured value writes it
verbatim, and one 20 MB record would blow through the frame budget in a single
materialized frame. A `result` record whose serialized size exceeds 64 KiB is forwarded
as `{type:'result', key, index, status, usage, durationMs, adapter?, model?,
resultTruncated: true, resultBytes: N}` — the value stripped; the client fetches it on
demand from `GET …/agents/:n/result` (§5.4.5). The same cap applies to any other
journal record type (oversize → skipped with a `sys` note), so no single frame can
exceed ~64 KiB of payload. `RunDetail` likewise never inlines full result values.

#### 5.6.6 The tailer, specified (critiques M18, parity #16)

`tail.js` is specified independently — it is **not** a copy of the `flowition tail`
loop, whose single `Buffer.allocUnsafe(size - readOffset)` (src/cli.js:284) allocates
the whole unread region at once:

- `readChunk(fd, offset, max = 1 MiB) → {bytes, nextOffset, eof}` — reads are bounded
  at 1 MiB; the drain loop `await`s between chunks so one stream cannot monopolize the
  event loop.
- Per-subscription `pending: Buffer` carry for the torn tail (multibyte-safe: bytes,
  not strings, until a newline lands — parity #17/#18).
- Per-line cap 1 MiB: an oversize line is skipped and counted (surfaced in the §6.5
  debug row), never buffered unboundedly.
- Shrink/rotate (`size < offset`) → signal reset (§5.6.4).

W5 refactors `src/cli.js`'s tail loop onto this module (the existing tail tests are the
regression net), so "shared" is structural, not aspirational.

#### 5.6.7 Specified edge behaviors (the brief's five scenarios)

1. **Run vanishes mid-stream:** tailer gets ENOENT on a previously-existing file + the
   run dir stat fails → emit `sys/gone`, close. List prunes it next poll.
2. **Torn final JSONL line:** the byte-domain tailer only emits complete lines; the
   partial tail is carried as a raw Buffer (`pending`), never decoded until its newline
   arrives (multibyte-safe — parity #17, #18). Per §5.6.6 — bounded 1 MiB chunk reads,
   not the CLI loop's whole-region allocation.
3. **500 MB transcript:** never read whole. Snapshot-then-tail (agents default `tail`);
   history via backwards paging (§5.4.4); SSE replays only from the subscribe point.
4. **5,000 runs on disk:** §5.4.2's two-tier cache + keyset pagination + terminal-state
   probe skipping. First cold list is O(n) first-line reads (~5,000 × <1 KB), then cached.
5. **Client offline 20 minutes:** EventSource reconnects with the last composite id;
   append-only files mean the offsets are still valid — replay is exactly the gap. If a
   file was rotated/shrunk in the interim, that stream gets `sys/reset` and the client
   refetches its snapshot/page. Nothing duplicates (parity #13, #103).

### 5.7 Caching & invalidation summary

| Cache | Key | Invalidation |
|---|---|---|
| journal meta (first line) | (path, dev, ino) of journal.jsonl | identity change (delete+recreate); a torn first line is never cached (§5.4.2) |
| resolved createdAt | (path, ino) | process lifetime — pinned so pagination order is stable (§5.4.2 step 3) |
| run summary | events.jsonl (size,mtime) | mismatch, dir vanished |
| settled state (completed/failed/interrupted) | runId | `.resuming` **or `run.lock`** appears (2 stats/request), or events.jsonl changes (§5.4.2 tiers) |
| quiescent state (stale/unknown/corrupt-result) | runId, per-run 30s±25% TTL (deterministic jitter, §5.4.2) | own TTL, or marker/lock appears |
| deriveRunState (live runs) | runId, 2s TTL | TTL |
| folded snapshot | (events,journal) (size,mtime) | delta-fold on growth; reset on shrink |

HTTP caching: API responses `cache-control: no-store`. Static: hashed assets
`public, max-age=31536000, immutable`; `index.html` `no-cache` (a cached entry document
is how a stale UI outlives its own deploy).

### 5.8 Static serving

From `viewer/dist` (resolved relative to the module, with a dev fallback to
`viewer/dist` in-repo). Defense in depth: decode once → reject NUL/`..` after
normalization → join → verify `realpath(target)` stays under `realpath(root)` (the
realpath step is what closes the symlink gap) → 403 otherwise. Content-type map for
html/js/css/json/svg/woff2/woff/png/ico (parity #24); `X-Content-Type-Options: nosniff`
everywhere. `/` and
any non-`/api` path without an extension serve `index.html` (hash router — deep links are
`/` requests anyway). Security headers on **every** response (§7.1.4).

---

## 6. Data model

### 6.1 Source-of-truth inventory (what feeds what)

| Fact | Source | Cited |
|---|---|---|
| run state | `deriveRunState` | src/run-state.js:116–195 |
| run identity/defaults/budget/args | journal `meta` (first line) | src/engine.js:828 |
| phases/agents/questions/logs/mail | events.jsonl fold | src/events.js shapes; §8 additions |
| per-agent usage/cost/duration/attempts/result values | journal `result` records | src/engine.js:964, :992 |
| live tokens | journal `usage-cum` | RECON-flowition §1.4 |
| session ids | journal `session` | src/engine.js:945 |
| transcript | agents/<n>.jsonl | src/transcript.js |
| final result | result.json | src/engine.js:640–642 |
| live lastTool/queuedMail/spend | control `status` | src/engine.js:685–691 |

### 6.2 Canonical viewer-facing types (normative TypeScript)

These are the wire types of the API and the SPA's domain model. `src/viewer/fold.js`
produces them; `viewer/src/api/types.ts` re-exports them (generated `.d.ts` alongside the
JS by hand — the shapes below are the contract).

```ts
type RunState = 'running'|'starting'|'completed'|'failed'|'interrupted'
              | 'corrupt-result'|'stale'|'unknown'

type AgentState = 'queued'|'running'|'done'|'failed'|'cancelled'|'cached'
// 'steered' and 'progress' events are annotations folded INTO AgentView, never states.

// One canonical container-path schema (critiques M15/Sol-10): a container segment is
// {kind, ordinal, count, stages?} — `ordinal` is the creating branch's fanout ordinal,
// `count` the fan-out width. A fanout event's `path` is the container's OWN full path
// (it includes the container's segment); an agent's `path` extends it with item/stage.
type PathSeg =
  | { kind: 'parallel' | 'pipeline'; ordinal: number; count: number; stages?: number }
  | { kind: 'item'; i: number }
  | { kind: 'stage'; s: number }

interface RunSummary {
  runId: string
  name: string | null            // run event `name`, else derived from file basename
  workflowFile: string | null    // absolute (journal meta) else basename (event `file`)
  state: RunState
  liveDetail: string | null      // deriveRunState `detail` passthrough
  createdAt: number | null
  startedAt: number | null       // first run-start event t
  endedAt: number | null         // last terminal run event t (after the last start)
  agents: { total: number; done: number; failed: number; running: number; cached: number }
  adapters: string[]             // distinct, first-seen order
  spend: { input: number; output: number; cost: number } | null   // journal aggregate
  budgetTotal: number | null
  openQuestions: number          // §6.4 step 8: forced 0 for terminal/stale runs (M6)
  resumeCount: number            // count of run events with state 'resumed'
  hasRunLog: boolean             // run.log exists — badge reads "detached log"; NOT
                                 // proof the current attempt is detached (the file is
                                 // written by both detached launchers and persists —
                                 // src/cli.js:114, src/mcp.js:48; critique N12)
}

interface RunDetail extends RunSummary {
  defaults: { adapter: string; model?: string; effort?: string; cwd?: string } | null
  hasArgs: boolean               // args served only via ?include=args (click-to-reveal)
  args?: unknown                 // absent unless ?include=args (§5.4.1)
  graphDynamic: boolean | null   // journal meta.graphDynamic (src/engine.js:832) — the
                                 // §7.3 resume modal is required to "show graphDynamic
                                 // when set", so it has to be projected. `null` on runs
                                 // journalled before the field existed (§6.5): NOT
                                 // false — the modal must say "not recorded", because a
                                 // dynamic graph is refused by the engine's preflight and
                                 // claiming a static one nothing verified is the worse lie
  argsTruncated?: boolean        // args existed but exceeded the 1 MiB inline cap
  engine: string | null          // E3 run-event engine version; null on old runs
  concurrency: number | null     // E3; null on old runs
  declaredPhases: { title: string; detail?: string }[] | null      // E3 (meta.phases)
  phases: PhaseView[]            // current attempt scope (§6.4 step 1a)
  agents: AgentView[]
  questions: QuestionView[]
  mail: MailView[]               // bounded tail: most recent 200 (§5.4.3)
  mailTotal: number
  logs: LogView[]                // bounded tail: most recent 200 (§5.4.3)
  logTotal: number
  structure: StructNode | null   // E2; null on old runs → flat fallback
  saturation: { t: number; active: number; queued: number }[]      // E4; [] on old runs
  offsets: { events: number; journal: number }   // SSE resume points
  caps: Caps                     // §6.5
  attemptSpans: { state: 'started'|'resumed'|RunState; t: number }[] // lineage strip
}

interface PhaseView { phaseIndex: number; title: string; agentIndices: number[];
                      reached: boolean; approximate: boolean }

interface AgentView {
  index: number
  key: string | null
  label: string | null
  adapter: string
  model: string | null
  effort: string | null
  state: AgentState
  displayState: AgentState | 'orphaned'   // §6.4 step 8 (dead-run override)
  phaseIndex: number | null
  phaseApproximate: boolean               // true when heuristic-assigned (old runs)
  path: PathSeg[] | null
  promptPreview: string | null
  resultPreview: string | null
  error: string | null
  errorCode: string | null                // E5: spawn_failed|stalled|provider_error|…
  retryable: boolean | null
  queuedAt: number | null                 // E4
  startedAt: number | null                // running event t
  endedAt: number | null
  waitMs: number | null                   // E4
  stallMs: number | null                  // E4 running event; null on old runs (M10)
  durationMs: number | null               // done event; failed/cancelled via E5/journal
  usage: { input: number; output: number; cost: number } | null
      // LIFETIME: summed over all of the key's journal result records — matches
      // Journal.load's budget aggregation (src/journal.js:146–157; Sol-13)
  attemptUsage: { input: number; output: number; cost: number } | null
      // the LAST attempt's own result record; the attempt selector shows its
      // segment's values
  liveTokens: { input: number; output: number } | null   // usage-cum join, LAST record
  cumTokens: { input: number; output: number } | null
      // LIFETIME-TO-DATE from the usage-cum stream: the chained sum of POSITIVE deltas
      // across every one of the key's `usage-cum` records, which is what makes it
      // zero-reset aware. `usage-cum` speaks two dialects (src/journal.js:5–8) — a
      // provider thread's cumulative totals, and a job's own per-attempt running totals
      // whose counter restarts at `{0,0}` (src/agent-proc.js:42,482,520) — so
      // `liveTokens` is the lifetime figure in the first and the current attempt's in the
      // second, and reading it as the lifetime undercounts every resumed agent on half
      // the adapters. Chaining is correct for both, and is identical to Journal.load's
      // own budget accounting (src/journal.js:100–116,167–176), which is the point: the
      // viewer and the engine must not disagree about what an agent has spent. `null`
      // when the key reported no `usage-cum`. The displayed lifetime figure is
      // `max(usage, cumTokens)` componentwise — NEVER their sum (W11 round 4, B3).
  lastTool: string | null                 // E6 progress, or socket live payload
  lastOutputAt: number | null             // E6 — real provider-output timestamp,
                                          // never a progress event's arrival time (Sol-11)
  resultBytes: number | null              // serialized size of the last result value
  resultTruncated: boolean                // > 64 KiB — fetch via §5.4.5 agent route (M8)
  toolIds: boolean                        // E11 — THIS transcript pairs by id; per-agent
                                          // because adapters mix per run (critique N3)
  sessionId: string | null
  attempts: number                        // count of journal result records for key
                                          // (= execution attempts, §2.5 vocabulary)
  steers: { at: number; origin: 'operator'|'workflow'; delivery: string|null }[]
  cached: boolean
}

interface QuestionView { qid: string; question: string; askedAt: number;
                         answered: boolean; answer: string | null; replayed: boolean;
                         abandoned: boolean }  // asked, never answered, run terminal —
                                               // engine rejects pending asks on abort
                                               // with NO answer event (src/engine.js:667;
                                               // critique M6). Composer disabled.

interface MailView { at: number; dir: 'in'|'out'; agent: number | null; message: string;
                     origin: 'operator'|'workflow'|null; delivery: string | null;
                     mailId: string | null; callsite: string | null }

interface LogView { at: number; message: string;
                    source: 'workflow'|'engine'; level: 'info'|'warn'|'error';
                    agentIndex: number | null }

interface StructNode {
  path: PathSeg[]
  kind: 'root'|'parallel'|'pipeline'|'item'|'stage'
  children: StructNode[]
  agentIndices: number[]
  rollup: { state: AgentState|'mixed'; costUsd: number; durationMs: number }
}

type Cap = 'supported' | 'unsupported' | 'pending'

interface Caps {
  phaseAssociation: Cap       // E1
  structure: Cap              // E2
  queueEvents: Cap            // E4
  progress: Cap               // E6
  usageOnEvents: Cap          // E5
  mailIds: Cap                // E8
  attemptMarkers: Cap         // E9
}
// Caps derive from the run event's `engine` version (E3), semver-compared against the
// version that landed each E-change — NEVER from whether a field happens to have been
// observed yet (critique M2: field-presence inference makes every fresh run, and every
// zero-agent run, read "recorded by an older engine"). `engine` present and new enough
// → 'supported'. `engine` absent (a genuinely old run) → 'unsupported'. `engine`
// absent AND the run has emitted no run event yet → 'pending' (render loading states,
// no older-engine copy). Degraded-panel copy renders ONLY for 'unsupported'.
// (toolIds is per-agent — AgentView.toolIds — because one run mixes adapters, N3.)

// Transcript records pass through as written (§8 adds fields); the client-side
// projection to timeline items is §9.6. TranscriptRec is the union of the 9+1 kinds
// (meta|text|reasoning|tool|tool-result|mail-in|mail-out|status|raw|attempt) with
// `t` and the fields documented in RECON-flowition §1.3 plus E9–E11 additions.
```

### 6.3 Formatting rules

`fmtTokens` (`41k`, `1.2M`), `fmtDuration` (`820ms`, `4.2s`, `3m07s` — match
src/util.js:137–141 so CLI and viewer agree), `fmtCost` ($1+ → 2dp, ≥$0.01 → 3dp, else
4dp — never `$0.00` for nonzero, parity #114), `timeAgo`, `fmtClock`. USD only (cost is
whatever the journal's `cost` field carried; no locale conversion — documented).

### 6.4 The fold (normative algorithm)

One pure function, shared server/client:
`fold(prev: FoldState | null, recs: {o: number, rec: Event}[]) → FoldState` —
incremental by construction (server delta-folds; client folds SSE batches onto the
snapshot). Order is **byte order, never `t`** (no seq field exists; same-millisecond
events are common — G10).

1. **run** events: merge onto `run`; `state==='started'|'resumed'` appends to
   `attemptSpans` and — if a terminal state was previously latched — clears
   `endedAt`/`error` (a resumed run is live again; a fold that keeps the stale `endedAt`
   is lying about liveness — we don't). First `started` latches `startedAt`. Terminal states set
   `endedAt = t`, `error`. A terminal `run` event with **no** preceding
   `started`/`resumed` (a workflow that failed during module load emits only the
   `finalize` event — the `started` emit at src/engine.js:1140 sits after
   `await import()` at :840; critique N14) opens and closes a zero-length attempt whose
   start is journal-meta `createdAt` (else the terminal `t`); the lineage strip renders
   it as a stub segment.

   **1a. Attempt scopes (critique M5).** A `started`/`resumed` run event opens a new
   **attempt scope**. `phases`, `logs`, and `mail` accumulate per scope — a resume
   re-executes the whole workflow from the top, so every `phase()` (src/engine.js:1103),
   `log()` (:1104), and `sendTo()` (:1130) re-emits, producing `A,B,C,A,B,C`, which no
   adjacency dedupe can repair. `RunDetail.phases/logs/mail` (and their totals) expose
   the **current** scope; earlier scopes are reachable through the lineage strip
   selector. **Agents are not scoped** — they are keyed by index and legitimately
   continue across attempts. **Questions are not scoped** — `qid` is deterministic
   (src/engine.js:1108–1110) and re-asks upsert (step 4).
2. **phase** events: append `{phaseIndex: ev.phaseIndex ?? scope-local ordinal, title}`
   to the current attempt scope; identity is `phaseIndex`, not title (titles repeat
   legally — Sol-10).
3. **agent** events, keyed by `index`:
   - `queued|running|cached|done|failed|cancelled` are state transitions. On transition,
     **clear stale per-state fields** before merging: entering `queued|running|cached`
     clears `error`, `errorCode`, `durationMs`, `resultPreview`, `endedAt` (this is the
     G11 fix — `foldEvents` at src/events.js:52 spread-merges and leaks a prior attempt's
     `error` onto a succeeded agent; our fold must not, and it corrects old runs too).
   - Identity fields merge `ev.X ?? prev.X`: label, adapter, model, effort, key, phase,
     path (later terse events don't erase them).
   - `steered` is an **annotation**: append to `steers`, do not touch `state`.
   - `progress` (E6) is an annotation: set `lastTool`, `lastOutputAt` (from the
     event's `lastOutputAt` field — never the event's own `t`, Sol-11),
     `liveTokens.output`; do not touch `state`.
   - Unknown `state` values: record the raw string, render neutral (never success).
   - Timestamps: `queuedAt` from queued event `t`; `startedAt` from running `t`;
     `endedAt` from terminal `t`; `waitMs` from event field else
     `startedAt - queuedAt` else null.

     **AMENDED in W11 round 11 — timestamps are attempt-scoped even though agents are
     not.** Step 1a is right that an agent is not attempt-scoped: index 3 in attempt 2 is
     the same agent, with the same identity and the same lifetime totals. Its CLOCK is not.
     A transition that begins a new execution of the index — `queued` at all, or
     `running`/`cached` arriving on an agent that is not currently `queued` — therefore
     clears `queuedAt`, `startedAt`, `waitMs`, `stallMs`, `lastOutputAt` and `lastTool`
     before the event's own fields are merged. `running` on a `queued` agent is that
     execution ADVANCING, not a new one, and must keep `queuedAt` — `waitMs` is derived
     from it. Without the clear, a `done → resume → queued` fold reports state `queued`
     alongside the finished attempt's `startedAt`/`waitMs`/`lastOutputAt`, and every
     cockpit surface reads that pair as the present: an execution bar and an "end
     unrecorded" label under a queued lane, a wait column that prints and sorts by an old
     attempt's wait, and — on a `running` re-entry — a Q2 quiet warning and progress notch
     fired by output the new attempt never produced. Lifetime data (`usage`, `cumTokens`,
     `attempts`, `sessionId`) and `steers` survive; the journal-derived outcome fields are
     handled by the clear rule above plus the §6.4 J join.

     **Cache hits carry the replay instant in `endedAt`.** A cached agent emits one event
     and no `queued`/`running` pair (src/engine.js:959), so with the previous attempt's
     `startedAt` correctly gone it would have no timestamp at all and the Timeline's replay
     mark would fall back to the window's left edge. `endedAt` takes the cached event's own
     `t`: the mark lands where the replay happened. It is not a duration boundary —
     `durationMs` stays cleared, no bar is drawn for a cache hit, and its figure remains the
     journal's replayed lifetime.
4. **question**: upsert `{qid, question, askedAt}` (a re-ask after resume updates
   `askedAt`, never duplicates — qids are unique per run, src/engine.js:1113).
   **answer**: mark answered; take `value` when present (E7), set `replayed` flag when
   present.
5. **mail**: append MailView; `agent` coerced `Number.isInteger(+x) ? +x : null`
   (the `dir:'out'` path passes the env string through unvalidated —
   src/engine.js:719–722, src/cli.js:347).
6. **log**: append with `source ?? 'workflow'`, `level ?? 'info'` (E12); old engine-
   internal lines match the five known prefixes (RECON-flowition G23) → tagged
   `engine`/heuristic.
7. **fanout** (E2): insert StructNode scaffolding; agents attach to nodes by longest
   path prefix. No fanout events → `structure: null`.
8. **Post-pass** (needs run state, applied outside the pure fold):
   `displayState` — an agent left `queued|running` while the run **is not live**
   renders as `orphaned` (glyph: the run's fate, dimmed), never a live spinner
   (parity #58). **AMENDED in W11 round 5**: liveness is defined POSITIVELY as
   `runIsLive(runState) = runState ∈ {running, starting}` — §5.4.2's live tier — and
   everything else is dead for the purposes of this step. The earlier wording said
   "terminal/stale", which silently excluded the other two QUIESCENT verdicts §5.4.2
   names: `corrupt-result` and `unknown`. `deriveRunState` returns `corrupt-result`
   only after the control socket fails to answer AND `run.lock` holds no live pid
   (src/run-state.js:141–152), so it is a run that has stopped; under the old reading
   it kept spinners, a Gantt advancing to `now`, a ticking clock and live-only action
   gating. An unrecognised state from a newer server is treated as NOT live for the
   same reason: motion is a claim. `terminalOrStale` survives for the FOLDED engine
   status (`run.state` as the events file recorded it), where these verdicts cannot
   appear. **`openQuestions` is computed here, not in the pure fold** (critique
   M6): `runIsLive(runState) ? unanswered.length : 0` — the engine rejects
   pending questions on abort with no `answer` event (src/engine.js:667, :705), so a
   fold-only count would fill the attention strip with dead runs' phantom work; the
   corresponding `QuestionView`s get `abandoned: true` so the Inbox still shows what
   the run was blocked on, composer disabled. Phase association fallback when
   `Caps.phaseAssociation` is `'unsupported'`: assign each agent the last phase event
   **preceding its earliest event** in byte order, and set `phaseApproximate: true` on
   every such agent — the heuristic is provably unsound under concurrency (G1) and the
   UI labels it ("grouping approximate for runs from older engines").

**J. Journal join** (server-side in `snapshot.js`; client receives it in RunDetail and
maintains it from the SSE journal feed): by `key` — events carry `key` on
queued/running/cached/done/failed (src/engine.js:906,915,981,994). `result` records →
`attempts` = count of result records per key (the folded `results` map in Journal.load
is last-wins and hides attempts — read raw records); `usage` = **sum** over all the
key's result records (lifetime, Sol-13), `attemptUsage`/`durationMs` from the last;
`resultBytes`/`resultTruncated` per §5.6.5's cap; `session` → sessionId; `usage-cum` →
liveTokens (last record wins; a `{0,0}` record zeroes — reset marker) **and** `cumTokens`
(the chained sum of positive deltas across the key's `usage-cum` records — the
zero-reset-aware lifetime, §6.2; the client maintains it from the stream by measuring its
first streamed record against the snapshot's `liveTokens` so a continued cumulative report
is never banked twice); `answer` →
answer values for pre-E7 runs; `mail`/`mail-done` → origin/delivery/callsite. The mail
join to events is by `mailId` when present (E8); the legacy fallback is **two-hop**
(critique N4): journal mail records carry `key`, not an agent index (src/journal.js:9),
so first map `key → index` through `started`/`result` records, then match
`(index, text, |Δt|≤5s)`, labelled approximate. A mail record whose key never got a
`started` record renders run-scoped, not agent-scoped.

### 6.5 Degradation contract

- **Old runs** (pre-E1..E12): every Cap `'unsupported'` → flat structure, approximate
  phases, no queue segments, no progress ticks, journal-join still supplies
  usage/attempts/results. The UI states *why* a panel is reduced ("recorded by
  flowition < 0.2") — never a blank. A **new** run that simply hasn't emitted agent
  events yet has caps `'supported'` (or `'pending'` before its run event) and renders
  loading/empty states with **no** older-engine copy (critique M2); a fold test pins
  this (§11.2).
- **Future events/kinds/states:** unknown event types are counted and surfaced in a
  debug row ("3 unrecognized events — newer engine?"); unknown agent states render
  neutral; unknown transcript kinds render raw. Nothing throws; `renderEvent`'s own
  degradation precedent (src/events.js:36,41) is the model.
- **Corrupt files:** lossy readers skip torn/corrupt lines; `Journal.load`-style throws
  are impossible because the viewer never uses the strict loader.

---

## 7. Interactivity + safety

### 7.1 Baseline security architecture (applies to every request)

The 0700 run dir is the entire existing protection model (src/util.js:23–26); an HTTP
listener is a strictly weaker boundary (any local user/process can reach loopback TCP).
Browsers cannot speak unix sockets, so loopback TCP + a bearer token is the only workable
browser transport. Therefore:

1. **Bind `127.0.0.1` only.** No flag to change it. (The recon's `--host 0.0.0.0`
   complaint dies here: the capability does not exist.)
2. **Token auth on the entire `/api` surface** — reads included: transcripts are exactly
   the secrets the 0700 dir protects; serving them tokenless to any local user would be a
   downgrade. Read token: 32 random bytes base64url, created at first use (`O_EXCL`),
   stored `$FLOWITION_HOME/viewer.token` mode 0600, compared with
   `crypto.timingSafeEqual` on equal-length buffers. When `--control` is on, the server
   additionally mints an **ephemeral control token** (32 bytes, in-memory only, never
   persisted): mutation routes require it in an `x-flowition-control` header, and only
   URLs printed by `flowition viewer --control` itself carry it (`&c=<token>` in the
   fragment) — so a shared or auto-start URL can never authorize mutations (Sol-1).
   Delivery: `Authorization: Bearer` header on fetches; `?token=` query **only** for the
   SSE endpoint (EventSource cannot set headers) — never logged, and the server strips
   it from any error text. The browser receives tokens in the URL **fragment**
   (`#/?t=…`, §2.2 grammar — fragments are never sent over the network), stores them in
   `sessionStorage`, and scrubs them from the URL bar before first route dispatch. No
   token → the SPA renders a "paste token or run `flowition viewer --print-url`"
   screen. **No cookies, ever** — no cookie means CSRF-by-ambient-credential is
   structurally impossible.
3. **Host allowlist before routing:** `Host` must be exactly `127.0.0.1:<port>`,
   `localhost:<port>`, or `[::1]:<port>`; else 403. This kills DNS rebinding (a rebound
   hostname carries the attacker's Host).
4. **Headers on every response:** `Content-Security-Policy: default-src 'none';
   script-src 'self'; style-src 'self'
   'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='; img-src 'self' data:;
   connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none';
   frame-ancestors 'none'`,
   `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
   `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`.
   No CORS headers exist anywhere — cross-origin reads stay blocked by default.

   **This CSP is buildable only under the following pinned rules (critiques B1/Sol-3),
   which are part of the spec:**
   - The §9.9 theme bootstrap is a **separate first-party file** (`/boot-theme.js`,
     ~10 lines) referenced by a render-blocking `<script src>` in `<head>` — never an
     inline script. Parser-blocking preserves the no-flash guarantee (parity #109).
   - `vite.config.ts` sets `build.modulePreload.polyfill: false` — Vite 6's default
     injects an **inline** polyfill script into the built `index.html`, which
     `script-src 'self'` blocks. Targets are evergreen local browsers; the polyfill is
     dead weight.
   - CI (W14) asserts `viewer/dist/index.html` contains **zero** inline `<script>` and
     `<style>` elements, and that neither `index.html` nor `public/icons.svg` carries a
     `style=` attribute (which `style-src 'self'` would block).
   - React's dynamic styling survives untouched: React assigns styles via CSSOM
     property sets (`node.style.x = …`), which CSP's `style-src` does not govern — so
     virtualization transforms, Gantt positioning, and ANSI truecolor (all `style`
     props) are compatible with this policy as-is. No `'unsafe-inline'`, no nonces
     (nonces would force per-response HTML rewriting, breaking §5.7's static
     `index.html` caching).
   - **Exactly one `style-src` hash source exists**, and this list is closed: the
     `@layer { * { overscroll-behavior: contain; } }` rule react-aria's
     `usePreventScroll` prepends to `<head>` while a modal is open on iOS and removes
     when it closes (§16.3, injection site 2 of 2). A hash admits one byte string; it is
     not `'unsafe-inline'` and not a nonce, and `'unsafe-hashes'` is absent so the ban on
     markup `style=` attributes above is unaffected. Adding a second hash requires the
     same justification this one carries: the rule is third-party, per-modal (so it
     cannot be hoisted into `ui/base.css` without changing behavior), and has no
     injection guard to claim.
   - **The policy is verified at runtime, on every platform that can violate it.** Static
     greps over `dist/index.html` cannot see a bundle that violates the policy after it
     boots — which is how a blocked injection shipped through panel round 2. W13's
     Playwright suite installs a `securitypolicyviolation` listener before any page script
     and fails any test that raises one; because `usePreventScroll` is gated on
     `navigator.platform`, that suite MUST include an iOS-platform describe that opens a
     modal, or the gate covers only half the injection sites.
5. **Mutations additionally require** (§7.2): method POST/DELETE,
   `Content-Type: application/json` (forces preflight for any cross-origin attempt,
   which then fails on missing CORS), an `Origin` header exactly equal to the server's
   own origin (reject absent or `null`), body ≤ 256 KB, message fields ≤ 32,768 chars.
6. **XSS:** the API returns JSON only. The SPA has a repo-enforced rule — **no
   `dangerouslySetInnerHTML`, no `innerHTML`, anywhere** (a test greps the source; the
   allowlist is empty). Markdown and ANSI render to React elements (§9.7–9.8), so model
   output is never interpreted as HTML. This is strictly stronger than a
   rehypeRaw→sanitize chain.
7. **No logging of bodies or transcript content.** Access log lines are
   `method path-without-query status ms` only.
8. **Tailnet access via Tailscale Serve — opt-in, Tailscale-specific**
   (`--tailscale-origin https://machine.tailnet-name.ts.net`). The bind stays
   `127.0.0.1` (rule 1 is not relaxed); Tailscale Serve terminates tailnet TLS and
   proxies to the loopback port, and the flag teaches the request gates about exactly
   that one path. It is **not** a generic trusted-proxy flag: the value must be a
   canonical HTTPS `*.ts.net` origin — no credentials, path, query, or fragment — because
   the security argument leans on Serve's specific header contract
   (`ipn/ipnlocal/serve.go`: it deletes the known client-supplied `Tailscale-*`
   identity/Funnel headers by name, overwrites `X-Forwarded-Proto: https` at TLS
   termination, preserves the `.ts.net` Host to a TCP-port backend, and marks public
   Funnel traffic with `Tailscale-Funnel-Request: ?1`). Concretely, when the flag is
   set:
   - The closed Host map (rule 3) gains exactly one entry: the configured `.ts.net`
     authority, compared case-insensitively (DNS names), mapping to the configured
     `https://` origin for the rule-5 Origin equality check. Loopback entries keep
     their exact byte match and their `http://` origins — cross-pairs still refuse.
   - Requests carrying the Tailscale Host must also carry exactly
     `X-Forwarded-Proto: https`, else 403 — provenance that the request entered
     through Serve's TLS ingress, not a plaintext alias. This is provenance, not
     authentication: a local same-user process can forge it and is out of scope (§7.4).
   - Any request bearing `Tailscale-Funnel-Request` — in any form — is refused before
     even the Host gate: Funnel means the public internet, which the flag never
     authorizes. Serve strips the client-supplied header, so through the proxy it
     cannot be forged away.
   - The mode demands an explicit fixed `--port` (Serve forwards to one port; silent
     port-walking would strand the proxy) and refuses to run as a secondary instance.
     The rendezvous record carries `tailscaleOrigin`, and reuse (§4.2.1) matches on it:
     a policy mismatch between a live instance and the caller is a loud refusal after
     the HMAC challenge proof — never a shadow listener with different exposure.
   - Every other gate is unchanged and still applies to tailnet requests: bearer token
     on all of `/api`, Origin equality, JSON content-type, `--control` + control token
     for mutations, CSP and friends on every response. Without the flag, nothing above
     exists — the Host map has its loopback trio and the Funnel header is inert.

   Setup: `flowition viewer --port 4646 --tailscale-origin
   https://machine.tailnet-name.ts.net` then `tailscale serve --bg 4646`. Never
   `tailscale funnel` — the viewer refuses Funnel traffic by design.

### 7.2 The write surface

**The server is read-only by default — DECISION** (this reverses the previous
revision, which enabled writes by default; the brief requires explicit opt-in for
anything that mutates a run, and Sol-1 is right that a default-on write surface makes
every later token/origin/rendering defect a full-permission control-channel defect).
`flowition viewer --control[=send,answer,cancel,resume,delete]` is the opt-in: bare
`--control` enables all five capabilities, the list form a subset. Without it, mutation
routes exist but answer `403 forbidden` with `{error:{code:'forbidden',
message:'viewer is read-only — restart with --control'}}`; `GET /api/session` reports
the enabled set so the SPA renders controls disabled-with-explanation (a persistent
"controls locked" header chip) instead of dead buttons. Auto-start never passes
`--control` (§4.3). Mutations additionally require the ephemeral control token
(§7.1.2), so only URLs printed by the `--control` invocation itself can drive them.

Steering text is an instruction to a process running with full permissions
(README §Security) — an RCE-equivalent channel. The opt-in, the two-token split, and
the §7.1 request gates are the reason the bridge is defensible; they are tested as
first-class security tests (§11.2).

**Bridge timeouts (critique M13):** `controlRequest`'s default is 5000 ms
(src/control.js:156), which would pin a single-threaded server's HTTP connections to a
preflight-blocked engine. The bridge passes explicit timeouts: `status` 300 ms
(matching `CONTROL_TIMEOUT_MS`, src/run-state.js:7), `send`/`answer`/`cancel` 2000 ms.
Timeout → `503 run_not_live` with `retryAfterMs: 2000`. Mutation buttons enter a
pending (disabled) state for the request's duration — a double-click cannot
double-cancel.

| Route | Bridge | Confirmation UX | Failure mapping |
|---|---|---|---|
| `POST …/send {agent, message}` | `controlRequest(sock, {cmd:'send',…})` — one connection per request (the shipped client resolves on first line; never pipeline — src/control.js:164–167) | None (reversible-ish, auditable: engine emits `steered` + `mail` events, src/engine.js:696–697). Composer enabled only for `running` agents (§2.5, critique M11); shows the delivery verdict (`live`/`queued`/`dropped`) verbatim; `dropped` renders amber with "agent already settled". | ENOENT/ECONNREFUSED/timeout → `503 run_not_live` ("run is not live — it may have finished"); `{error}` from engine → 409 with the engine's message |
| `POST …/answer {qid, value}` | `{cmd:'answer',…}` | None — answering is the product. Optimistic UI: question greys instantly, reconciles on the `answer` event. | `no pending question` → 409 (another operator answered first; UI refreshes questions) |
| `POST …/cancel {agent}` | `{cmd:'cancel', agent}` — `agent` **must** be a non-negative canonical integer or non-empty string; a body whose `agent` key holds any other value (incl. `null`) → `400 bad_request` — the engine treats `agent == null` as whole-run cancel (src/engine.js:711) and a buggy client must not cancel a run by accident (critique N5) | Per-agent: inline confirm (button arms for 3s: "Cancel agent 3?"). Queued agents: cancel is available (the engine's abort covers admission), labelled "remove from queue". | as send |
| `POST …/cancel {}` (whole run) | `{cmd:'cancel'}` — whole-run requires the `agent` key **absent** | **Modal**: explicit two-step ("Cancel run flo_ab12? Agents in flight will be killed. [Keep running] [Cancel run]"), default focus on Keep. | as send |
| `POST …/resume` | §7.3 | Modal per §7.3 (distinct copy for replay-of-completed vs recover). | 409 `conflict` if state is running/starting |
| `DELETE …/:id` | §7.3 | **Type-to-confirm modal**: user must type the runId. Copy: "moves to flowition's trash; purged after 7 days". | 409 if live |

Every control-socket mutation is visible in the run's own event stream (steered/mail/
answer events). Lifecycle mutations (resume/delete) — where the run's stream may be
absent or *about to be deleted* — are additionally recorded in the §7.3 audit log
(Sol-4: "the audit trail is the run itself" is false for delete, which destroys it).

### 7.3 Resume and delete (lifecycle mutations)

**Resume** never runs in-process (the viewer must never hold a run lock or execute a
workflow module). It reproduces `detachResume` exactly (src/mcp.js:136–143): validate id
via `runDir()`; require `deriveRunState` ∈ {**completed**, failed, interrupted, stale} —
completed is included because the engine deliberately supports resuming a completed run
as a full cache replay (proven by `test/engine.test.js:41–46`; the previous revision
withheld it — Sol-12, parity #99). The UI labels the completed case **Replay** with its
own modal copy ("re-runs the workflow; completed agents replay from the journal, no
providers are re-invoked unless control flow changes"). Then: require a loadable journal
`meta` (try/catch, read-only); write the `.resuming` marker tmp+rename; spawn the
resume detached via `process.execPath` + module-relative binPath (src/mcp.js:47–55
pattern) with `run.log` appended fds; respond `202 {runId, launchAccepted: true}` —
the response means **launch accepted, nothing more**; preflight success/refusal arrives
through subsequent `sys/state` frames and events (Sol-12). The engine's own preflight
(fileHash/graphHash/args — src/engine.js:790–804) is the integrity gate; the viewer
adds nothing and bypasses nothing. The confirmation modal states the §1.3 integrity
scope (local graph pinned; environment/packages not) and shows `graphDynamic` when set.

**Delete** goes through `src/retention.js` (E13), shared with the CLI — the HTTP
handler contains **no filesystem deletion code** of its own. `removeRun(runId)`
(critiques M12/Sol-4):

1. Id via `runDir()`; `lstat` the run dir — a **symlink is refused outright**, never
   followed; `realpath` containment under `realpath(runsDir())`.
2. Require a recognizable flowition run: at least one of `journal.jsonl`,
   `events.jsonl`, `result.json`, `run.log` present. A bare validly-named directory
   (state `unknown`, no artifacts) is refused with `409 conflict` — `runDir()` proves
   only that a string is a safe child name, and the one irreversible operation must
   not be able to remove arbitrary directories a user happened to place under `runs/`.
3. **Acquire the run lock** (reuse `acquireRunLock`, src/engine.js:48) and hold it for
   the whole operation; if it is held by a live pid → `409 conflict` regardless of
   derived state. Re-derive `deriveRunState` **after** acquiring; refuse
   running/starting. This closes the TOCTOU where a `stale` run is deleted in the same
   seconds a resume is launching against it — the resume takes the same lock before
   its first journal read (src/engine.js:592), so exactly one side wins, and the race
   test in `test/retention.test.js` asserts delete loses.
4. Delete = **atomic rename into `$FLOWITION_HOME/trash/<runId>.<epoch>/`** (0700
   trash dir, same filesystem). `pruneRuns` purges trash entries older than 7 days
   (and terminal runs older than `--older-than`). "Irreversible" becomes
   "recoverable for a week"; `flowition rm --purge` empties trash immediately.
5. Append an audit line (below) *before* the rename.

**Audit log** (`audit.js`, Sol-4): `$FLOWITION_HOME/viewer-audit.jsonl`, 0600,
append-only: `{t, op: 'resume'|'delete'|'cancel'|'args-read', runId, outcome}` — no
message bodies, no transcript content. It survives the deletion of the run it records.

### 7.4 Threat model (explicit)

**Assets:** transcripts/prompts/results (arbitrary read data incl. credentials agents
touched — RECON-flowition §6.1), provider session ids, `args`, the steering channel into
full-permission agent processes, run lifecycle.

| Adversary | Vector | Defense |
|---|---|---|
| Malicious web page in the user's browser | DNS rebinding → same-origin API calls | Host allowlist (§7.1.3) |
| 〃 | CSRF (form/fetch simple requests) to mutation routes | Bearer token header (no cookies = no ambient credential), Origin equality, JSON content-type requirement |
| 〃 | Reading API via `<script>`/`fetch` cross-origin | No CORS headers; JSON-only responses; token required |
| 〃 | Tab-napping/XS-Leaks on the viewer origin | COOP/CORP/frame-ancestors 'none' |
| Hostile transcript content | XSS via markdown/ANSI/tool output | No-innerHTML rule; React text nodes; CSP script-src 'self'; links restricted to http(s) with `rel=noopener noreferrer` and never auto-followed; images never fetched (rendered as link chips) |
| Another local user | Connect to loopback port; read transcripts / drive mutations | Read token (0600 file they cannot read); constant-time compare; mutations additionally need the ephemeral control token |
| 〃 | **Impersonate the viewer** on the predictable port to harvest the token from a printed URL | Reuse requires an HMAC challenge proof of token knowledge (§4.2.1); the probe never transmits the token; no token-bearing URL is ever printed on unauthenticated evidence (Sol-2) |
| 〃 | Steal token from process args/logs (`ps` during `--open`) | Token never in argv — `--open` passes a 0600 bootstrap-file path, not the URL (§4.2); never logged; SSE query token redacted from errors; URL carries it in the fragment only |
| Local attacker with the user's own privileges | Anything | Out of scope — equivalent to the CLI already |
| Crafted run id from a compromised SPA | Path traversal into fs | `runDir()` choke point everywhere; static realpath containment; delete refuses symlinked dirs and artifact-less dirs and holds the run lock (§7.3) |
| Malicious/garbled run files | Parser DoS (huge lines, deep JSON) | Lossy line readers with 1 MiB per-line cap (skip+count oversize lines); chunked async search with a 2 s deadline (§5.4.7); per-record 64 KiB stream cap (§5.6.5); JSON-tree render caps (§2.6); response sizes bounded per route (§5.1) |
| Viewer bug | Executing a workflow | Structural: no code path imports `runWorkflow` (denylist test, §11.2); resume spawns the CLI which re-validates hashes |
| Mistaken/stolen control credential | Irreversible destruction, evidence loss | Delete is trash+purge with a 7-day window; lifecycle ops logged to an audit file outside the run (§7.3) |
| Public internet (misconfigured `tailscale funnel`) | Reach the viewer through Tailscale's public ingress | `Tailscale-Funnel-Request` refused unconditionally in tailscale mode (§7.1.8); Serve strips the client's copy, so the marker is trustworthy through the proxy |
| Off-tailnet network attacker | Reach the tailnet authority directly | Bind is still `127.0.0.1` — only Serve's local proxy hop reaches the listener; the `.ts.net` Host without `X-Forwarded-Proto: https` from that hop is a 403 |
| Malicious web page (tailscale mode) | DNS rebinding / CSRF against the tailnet authority | Same closed Host map (one added entry, §7.1.8) and Origin-equality rule; a rebound name matches nothing, and the tailnet authority's only legal Origin is its exact `https://` self |
| Tailnet peer without the URL | Connect to `https://machine…ts.net` and read/drive the viewer | Same bearer-token and control-token gates as loopback (§7.1.2) — tailnet reachability grants nothing tokenless; per the operator's model, tailnet devices are their own trusted machines |

Accepted residuals (documented in-app under Settings → Security): loopback TCP metadata
(port presence) is visible to local users; a same-user process can read the token file —
that adversary already has everything.

---

## 8. Engine changes required

Ground rules for every change: **nothing enters the `keyed` object** (src/engine.js:889)
or `src/keys.js` derivations — resume keys stay bit-identical (pinned by a new test that
snapshots `agentKey`/`deriveBranch` outputs before/after); journal changes are **new
record types or additive fields on existing types only** (`Journal.load` ignores unknown
types — RECON-flowition §5 blast-radius rules); old CLIs reading new events degrade
silently (`renderEvent` returns null on unknown agent states and event types,
src/events.js:36,41). Each change lands with mock-adapter tests in the existing
`node scripts/test.mjs` harness.

### Required for v1

**E1 — Phase association (G1, Sol-10).** Phase state lives **on the ALS context**, not
in a run-global variable: `phase(title)` sets `currentCtx().phase = {phaseIndex, title}`
(`phaseIndex` from a run-scoped monotonic counter — JS increments are atomic; identity
is the index, titles repeat legally). Fanout context creation (see E2's call sites)
copies the creating context's `phase` into each child ctx, so concurrent branches that
call `phase()` are isolated from each other instead of racing a global (a top-level
`phase('A'); await parallel(...)` still flows to every item). `phase` events gain
`phaseIndex`. All agent events (`queued`/`running`/`cached`/`done`/`failed`/
`cancelled`/`steered`) gain `phase: string|null` and `phaseIndex`, captured **at
`agentImpl` entry** from the current ctx (before `sem.with` — the running event fires
after admission, src/engine.js:911→915, which is why ordering heuristics are unsound).
`AgentOptions.phase?: string` overrides the ambient phase (index.d.ts addition).
*Compat:* events-only; ctx gains an observational field that is explicitly excluded
from `agentKey`/`deriveBranch` inputs (src/keys.js:28–31 unchanged). *Tests:*
key-stability pin; concurrent branches with repeated titles get distinct phaseIndexes;
explicit `phase` wins over interleaved `phase()` calls.

**E2 — Structural path (G2; restated per critiques M15/Sol-10 — the original text
specified an inheritance `makeCtx` cannot do).** `makeCtx(branchKey, runSeed)`
(src/keys.js:16) receives no parent context, so the path must be passed explicitly at
**all three construction sites**: the signature becomes
`makeCtx(branchKey, runSeed, path = [])`; `rootCtx` (src/keys.js:20) passes `[]`;
`parallel` (src/engine.js:1072) passes
`[...ctx.path, {kind:'parallel', ordinal, count: thunks.length}, {kind:'item', i}]`
where `ctx` and `ordinal = ctx.fanoutIndex` are captured **before** the `map`
(src/engine.js:1068–1069); `pipeline` (src/engine.js:1089) rebuilds a fresh ctx per
stage, so it passes
`[...ctx.path, {kind:'pipeline', ordinal, count: items.length, stages: stages.length},
{kind:'item', i}, {kind:'stage', s}]` — the item segment re-derived per stage, not
inherited. One canonical container shape: `{kind, ordinal, count, stages?}` (§6.2 —
`ordinal` disambiguates sequential sibling fanouts). `parallel()`/`pipeline()` emit
`{type:'fanout', path, kind, count, stages?}` at entry, where `path` is the
container's **own** full path (its segment included). Agent `queued`/`running`/`cached`
events carry the agent's full `path`. A pipeline item whose stage throws produces fewer
`stage` segments than declared; the Structure DAG renders the declared count with
unreached stages dimmed. *Tests:* branch-hash pin; nested parallel-in-pipeline path
shape; two sequential sibling `parallel()`s produce distinct `ordinal`s.

**E3 — Run-start metadata (G3).** The run start event (src/engine.js:1140) gains
`workflowFile` (absolute), `cwd`, `defaults: {adapter, model, effort}`, `concurrency`
(currently written nowhere — src/engine.js:807), `budgetTotal`,
`phases: meta.phases ?? null`, `engine: <pkg version>`. *Compat:* additive; `foldEvents`
spreads run events (src/events.js:50) so the CLI picks them up for free.

**E4 — Queue admission (G6; Semaphore change restated per critique B4 — the original
specified a getter that throws).** Emit `{type:'agent', state:'queued', index, key,
label, adapter, model, phase, phaseIndex, path, sem:{active,queued,limit}}` immediately
after index allocation (src/engine.js:909), before `sem.with`. `running` gains
`waitMs`, the same `sem` gauge, and **`stallMs`** (the resolved
`spec.stallMs ?? DEFAULT_STALL_MS` — known at emit time, src/engine.js:884,
src/agent-proc.js:24; the §2.4 stall warning is honest only against the real
per-agent value — critiques M10/Sol-11). `Semaphore` gains **only a `queued` getter**
returning `this.queue.length`; `active` is already an assigned public field
(src/semaphore.js:6) — read it directly; do **not** convert it to an accessor (a
prototype getter would make the constructor's `this.active = 0` throw in strict mode).
The `sem` gauge is sampled at the emit site: before `sem.with` for `queued`, inside
the `sem.with` callback for `running` — `release()` hands off directly without
decrementing (src/semaphore.js:16), so a sample taken elsewhere reads a different
instant. **Also fix the queued-forever hole:** the abort/budget throw inside
`sem.with` (src/engine.js:912–913) must emit a terminal `cancelled`/`failed` agent
event for that index before propagating. *Tests:* concurrency-2 workflow asserts
queued→running ordering and waitMs > 0; abort-while-queued yields a terminal event;
running event carries a custom `stallMs`.

**E5 — Terminal-event completeness (G4a, G17, G26, G27).** `done` event gains
`usage: job.usage` and `model`. `failed`/`cancelled` events gain `durationMs`, `usage`,
`model`, `code: err.code ?? null`, `retryable: !!err.retryable` (the engine already
branches on the code at src/engine.js:991 and then discards it), and `lastOutputAt`
(from E6's tracking — a dead run stays diagnosable, Sol-11). Journal failure record
(src/engine.js:992) gains `adapter`, `model`. *Compat:* events additive; journal
additive fields on an existing type.

**E6 — Throttled per-agent progress (G5, G25, G21, G9; Sol-11).** `AgentJob` maintains
an explicit `lastOutputAt` timestamp — initialized at turn start and advanced **only**
by real provider output (a parsed stdout line — the same signal that resets the stall
timer, src/agent-proc.js `onLine`/`resetStall`) — never by the progress timer itself.
The engine emits `{type:'agent', state:'progress', index, key, tool: lastTool,
outputTokens, lastOutputAt}` at most **once per 2,500ms per agent** and only when
something changed; a silent agent emits nothing, and the *absolute* `lastOutputAt`
(not an age, not the event's `t`) is what the client ages against `stallMs` — so a
silent agent correctly looks silent. Socket `status` payload gains `lastOutputAt` per
agent (src/engine.js:687). *Compat:* old `renderEvent` returns null for the unknown
state — `flowition tail` under an old CLI stays clean. *Volume:* worst case ~24
lines/min/agent; with the G24 constraint this is the agreed ceiling — no other
high-frequency event may be added. *Tests:* mock adapter with paced output asserts ≤1
progress event per window; a custom short `stallMs` with a silent mock asserts the
viewer-side warning math against emitted values.

**E7 — Answer visibility (G12).** `answer` events gain `value`. The resume replay path
(src/engine.js:1115–1116), which currently resolves silently, emits
`{type:'answer', qid, value, replayed: true}`. *Compat:* additive; the answer value is
already on disk in the journal — same sensitivity class.

**E8 — Mail correlation (G13 + G14).** The journal mail uuid (`id`) is surfaced:
`mail` and `steered` events gain `mailId`; the control-socket send path
(src/engine.js:697) gains `delivery` (the verdict is in hand on :695); `sendTo()`
(src/engine.js:1130) additionally emits the `steered` agent event; the `post` handler
(src/engine.js:719–722) coerces `agent` to `Number.isInteger`-or-null **and** writes a
`mail-out` transcript record via `findJob` when the agent is live (G14 — the kind is
documented at src/transcript.js:2 and never written). Transcript `mail-in` gains `id`.
*Constraint:* touch `AgentJob.send`'s emissions only, never its control flow (the replay
suppression machinery is the most subtle code in the repo — ARCHITECTURE.md §Steering);
`SendVerdict` (index.d.ts) is unchanged — the id travels via an out-param. *Tests:* extend
test/mail-drop.test.js round-trips asserting event↔journal↔transcript share one id.

**E9 — Attempt records (G15).** On a resumed index, instead of only the English sentinel,
write `{kind:'attempt', n}` (n = 1 + prior journal `result`-record count for the key —
`Journal.load` gains an additive `attemptCounts` map); transcript `meta` gains `attempt`.
The sentinel status line stays for old-CLI tail readability.

**E10 — Full prompt (G16).** Replace the silent `prompt.slice(0, 4000)`
(src/engine.js:919) with `truncate(prompt, 32768)` (explicit `… [+N chars]` marker,
src/util.js:135). An honest cap beats a silent one; 32 KiB matches the transcript's text
cap.

**E11 — Tool-call ids (G7).** Parsers carry ids where the protocol has them:
claude-stream `b.id` → `{k:'tool', id}`, `b.tool_use_id` → `{k:'tool-result', toolUseId}`
(currently dropped — src/adapters/protocols.js:36,:52); codex synthesizes both halves
from `it.id`; opencode uses `part.id`; droid/pi synthesize a per-job counter.
`handleEvent` passes them through; `Transcript.write` stores them. Ids are opaque and
adapter-scoped. *Tests:* extend test/protocols.test.js with a parallel-tool-use fixture
asserting non-positional pairing.

**E12 — Log structure (G23).** The five engine-internal `log` emit sites
(src/engine.js:665, :830, :956, :983, :1042) gain `source:'engine'`,
`level:'warn'|'error'`, and `index` where agent-scoped. Workflow `log()` stays bare
(folds as workflow/info).

**E13 — Retention (G18; guards hardened per critiques M12/Sol-4).** New
`src/retention.js`: `removeRun(runId)` — symlink refusal, artifact requirement, run
lock held across re-derive + rename, **move-to-trash** (all per §7.3) — and
`pruneRuns({olderThanDays})` (terminal runs + trash purge). New CLI commands
`flowition rm <runId> [--purge]` and `flowition prune --older-than <days>`. The only
destructive change in this list — its tests are the priority: refuse-if-live (against
a real running mock workflow), the resume-vs-delete race (delete must lose),
refuse-outside-runsDir, refuse-symlink, refuse-artifact-less dirs, traversal ids
rejected by `runDir()`, trash rename + purge.

**E14 — Listing fix (G19).** `flowition runs` and MCP `flowition_runs` drop the
`startsWith('flo_')` filter (src/cli.js:200, src/mcp.js:127) in favor of
directory + `runDir()`-valid + has-journal-or-events. Changelog note: previously hidden
`--run-id` runs appear.

**E15 — Fold staleness fix (G11).** `foldEvents` (src/events.js:52) clears `error` (and
`durationMs`/`resultPreview`) when an agent transitions to `running`/`cached`/`done` —
fixes `flowition status` showing a resumed-and-succeeded agent with its old error. The
viewer has its own fold, but the CLI bug is real and cheap.

**E16 — Foreground run id in the CLI (Sol-6).** `flowition run` (foreground path)
allocates `runId = flags['run-id'] ?? shortId('flo')` in the CLI and passes it as
`opts.runId` to `runWorkflow` (already accepted, src/engine.js:617) — today a fresh
foreground id is born inside the engine and surfaces only at completion
(src/cli.js:163), so auto-start (§4.3) could not print a deep link. Resume and
`--detach` keep their existing id handling (detachRun already allocates,
src/cli.js:107). *Compat:* no behavior change beyond who calls `shortId`; the engine's
`runDir()` validation still applies. *Tests:* the printed deep link matches the
outcome's runId.

### Deliberately later / rejected

- **L1 Cache-token telemetry (G4b):** touches all six parsers + journal usage shapes +
  the budget math (src/journal.js:146–157). Valuable (cache-hit ratio) but money-adjacent;
  separate PR with its own review.
- **L2 Tool durations (G8):** only honest for claude/amp/droid/pi; needs per-adapter
  pass-through design. The UI shows "duration unavailable" meanwhile — never 0ms bars.
- **L3 Event `seq` (G10):** byte offset already totally orders the file; not needed.
- **L4 Artifact/git-diff events (G22):** introduces a `git` subprocess into the engine's
  completion path — argued separately, not smuggled in.
- **Rejected — socket `subscribe` push (G21):** E6 makes the file stream authoritative
  and works for terminal runs; a subscribe protocol would break `serveControl`'s
  one-response-per-line contract for marginal latency.
- **Rejected — `summary.json` run index (G20):** the first-line meta read + caches make
  it unnecessary; an index file is another consistency liability.

---

## 9. Frontend architecture

### 9.1 Stack

**DECISION** *(dependency count superseded by §16 — the stack itself stands)*: Vite 6 + React 19 + TypeScript. Runtime deps — originally exactly three, now the §16.1 curated policy (adds react-markdown per §16.2, @react-aria hooks per §16.3):
`react`, `react-dom`, `@tanstack/react-virtual`, plus `react-markdown` (§16.2) and hooks-level `@react-aria/*` (§16.3). Everything else is hand-rolled:

- **No Tailwind/shadcn/radix** — the design system is §3's tokens in plain CSS
  (`tokens.css` + component co-located CSS modules). A spec'd design needs exact values,
  not utility soup; and it removes ~15 build deps.
- **No react-router** — a 60-line hash router (`useSyncExternalStore` on `hashchange`).
  Three routes don't justify a dependency.
- **No react-query** — hand-rolled `usePoll`/`useFetch` hooks; SSE is hand-rolled anyway.
- **Markdown: react-markdown (per §16.2, superseding the original no-markdown-dep
  rule)** — hardened per §16.2's input limits and renderer invariants. **ANSI stays
  dependency-free** (§9.8/§16.4). The no-innerHTML rule stands for both paths.
- `@tanstack/react-virtual` **is** justified: variable-height list virtualization with
  measurement caching and scroll anchoring is subtle, and transcript perf is a headline
  budget; hand-rolling it is where the perf bugs we budget against would come from.
- Dev deps: `vite`, `@vitejs/plugin-react`, `typescript`, `vitest`, `jsdom`,
  `@testing-library/react`, `@testing-library/dom`; plus, per §16.5, `@playwright/test`
  and `@axe-core/playwright` for the W13 browser/a11y suite. Additions beyond these
  follow §16.1's curated policy — not "nothing else", but nothing undocumented.

The honest no-build option was weighed and rejected in §4.6.

### 9.2 Directory layout

```
viewer/
  package.json  vite.config.ts  tsconfig.json  index.html
  public/fonts/*.woff2   public/icons.svg   public/boot-theme.js  (§7.1.4 — external)
  src/
    main.tsx  app.tsx  router.ts  (parses §2.2 grammar: strip reserved params →
                                   sessionStorage → replaceState → match route)
    api/     client.ts (fetch + token), sse.ts (EventSource wrapper + latch),
             types.ts (re-exports ../../src/viewer/fold.js types)
    state/   stores.ts (useSyncExternalStore pattern), runsStore.ts, runStore.ts,
             transcriptStore.ts, toastStore.ts
    fold/    index.ts (imports ../../src/viewer/fold.js), journalJoin.ts, structure.ts
    ui/      tokens.css, Button, Badge, Chip, Glyph, Disclosure, SplitPane, Dialog,
             VirtualList, Tooltip, EmptyState
    features/
      home/       RunList, AttentionStrip, RunRow, Filters
      cockpit/    Header, BudgetGauge, LineageStrip, InboxRail, LogLane,
                  timeline/ (GanttLane, SaturationStrip, TimeAxis)
                  structure/ (StructTree, ContainerCard)
                  agents/ (AgentTable)
      transcript/ TranscriptPane, PromptBlock, StepGroup, renderers/
                  (Markdown.tsx, Ansi.tsx, Terminal.tsx, Diff.tsx, ToolCall.tsx,
                   Reasoning.tsx, MailMarker.tsx), workSummary.ts, toItems.ts
      result/     ResultView, JsonTree
      control/    SendComposer, AnswerComposer, ConfirmDialog, CancelControls, ResumeButton
      palette/    CommandPalette
    format/  fmt.ts   theme/ theme.ts   a11y/ focus.ts, live.ts
  test/    (vitest; mirrors src/)
  dist/    (committed)
```

Vite config: `base: './'`, `build.modulePreload.polyfill: false` (§7.1.4), dev proxy
`/api` + `/healthz` → `http://127.0.0.1:4646`, and an fs.allow entry for `../src/viewer`
(the shared fold import).

### 9.3 State & data flow

Hand-rolled stores on `useSyncExternalStore`. Per run page: `runStore` holds
`{detail: RunDetail, foldState, connection: 'live'|'polling'|'ended'|'gone'}`. Flow:
fetch snapshot → seed fold state + offsets → open SSE with cursor → batches are folded
**at most once per animation frame** (rAF coalescing — parity #104) → subscribers re-render
from immutable snapshots. The status poll (10s) continues after terminal — that is how a
resumed run is detected once the stream quiet-closed (parity #98–99). The stream latch
follows the recon's proven rules: latch off the **folded** terminal state, never the
polled one (a poll verdict landing mid-replay must not sever a replay — parity #101);
quiet-close after server `sys/end`; the client never invents staleness from silence
(parity #102 — liveness verdicts come only from `sys/state` frames/deriveRunState).

Transcript: `transcriptStore` per open agent — a ring of parsed records bounded by
**20,000 records or 8 MiB of source bytes, whichever first** (critique M14: parsed
JSONL expands 5–15× in the heap, so a bytes-only bound cannot honor a heap budget).
Eviction unit is the whole fetched page — §5.4.4 offsets stay contiguous; scrolling up
re-fetches. Buffers are appended via chunked arrays (no `[...prev, item]` per record —
that spread is O(n²) over a stream).

### 9.4 SSE client

`sse.ts` wraps EventSource: connect(url with cursor+token) → `onBatch(frames, id)`;
reconnect handled natively (Last-Event-ID — which the server prefers over the URL
cursor per §5.6.2's precedence table); an explicit `reopen(newAgentSet)` closes and
reconnects with a **fresh URL built from the current composite cursor** (no stale
header). Reset semantics: `sys/reset` drops exactly one stream's buffers, and arrives
before that stream's replayed records (§5.6.2 rule 3). Client-side comparison is
**per stream, never vector-wide** (Sol-9): a first frame whose offset for stream S is
at-or-behind S's seen offset without a reset marker → treat S as fully replaying, drop
S's buffers only (fail-safe to reset, parity #103); other streams are untouched.

### 9.5 Virtualization

Everything long is virtualized (no long list renders unwindowed): run list,
agent table, Gantt lanes (windowed by lane), transcript feed, log lane, JSON tree.
Transcript rows: variable height with measurement cache; expanded tool outputs are
internally scroll-capped (max-height wells) so a single row never exceeds ~70vh.
Sticky-bottom follow with intent detection (pointer-held or ≤350ms after wheel/touch
breaks follow; return-to-bottom within 4px re-arms; programmatic scrolls don't break —
parity #105–106).

### 9.6 Transcript projection & step grouping

`toItems.ts` maps transcript records → timeline items: coalesce consecutive `text` /
`reasoning` (cross-flush on interleave); pair `tool`+`tool-result` by `toolUseId`→`id`
(E11), falling back to a stack-based positional pairing flagged approximate (old runs;
orphan results surface as their own completed rows, never clobbering an unrelated call —
parity #83); classify shell-family tools into terminal cards (unwrap
`[shell, -lc, script]` only when argv[0] is a known shell — parity #85); file-change
tools into diff cards (synthesize diffs from Edit/Write args — parity #81); `attempt`
records split segments (E9). `workSummary.ts` reimplements the collapsed step label
("Ran 3 commands, explored 5 files, edited 2 files") with the write-disqualification
rule and fd-redirect handling — specified behaviorally during design recon, and built
**with tests this time** (the recon'd step-grouping had zero). Grouping rules:
boundaries (text/reasoning/mail) close steps; a step expands iff single-item, contains a
pending row, or is the live frontier (parity #86–92) — **and a manual per-row toggle
always overrides the automatic rule** (§2.5.1, parity #93).

### 9.7 Markdown (safe by construction) — **SUPERSEDED by §16.2** *(operator ruling: react-markdown, hardened; the whitelist, link policy, image-chip rule, and fuzz corpus below REMAIN NORMATIVE as renderer invariants — only the parser implementation changed)*

`Markdown.tsx`: react-markdown (per §16.2), configured to emit exactly the output
contract originally specified here: an `allowedElements` allowlist covering headings,
paragraphs, lists (task items), blockquotes, hr, GFM tables, fenced code (language chip
+ copy button, no highlighting in v1), inline code/bold/italic/strikethrough, links and
autolinks (http/https only; `target=_blank rel="noopener noreferrer"`) — with custom
link and code-block components, §16.2's input limits (byte-domain pre-parse, AST bounds
in-pipeline), and no raw-HTML pipeline (no rehype-raw; enforced by the §16.7
package-graph test). **Raw HTML renders as literal text. Images render as a link chip**
(never fetched — CSP has no remote img source; prevents tracking-pixel exfiltration
from hostile transcripts). Tables scroll horizontally in a breakout container (parity
#70). Fuzz test: the 10k hostile corpus (script tags, event handlers, data: URLs,
nested brackets) must produce zero elements outside the allowlist, zero attributes
outside the allowlist, and satisfy every §16.2 renderer invariant.

### 9.8 ANSI & terminal cards

`Ansi.tsx`: incremental SGR parser → spans as React elements; carries SGR state across
appended chunks and converts **only the new suffix** (parity #75); non-append changes
rebuild. 16-color codes map to the terminal-well palette tokens; 256/truecolor pass
through as inline `color` via React style props (CSSOM — compatible with the §7.1.4
CSP). **Backgrounds (SGR 48) pass through too, and whenever a background is applied
the foreground is forced to whichever of the well's two text tokens has the higher
relative-luminance contrast against it** — a tool emitting near-white-on-near-white
on the fixed dark well must stay readable (critique N8, parity #74). OSC/cursor
sequences stripped. Exit code line rendered **only when a real exit code exists**
(§2.5).

### 9.9 Theme

`data-theme` on `<html>`; the pre-mount bootstrap is the **external, render-blocking
`/boot-theme.js`** (`<script src>` in `<head>`, before CSS) reading `localStorage.theme`
→ no wrong-theme flash (parity #109) **and** no inline script, so the §7.1.4 CSP holds
(critiques B1/Sol-3); system-follow via media query; `d` toggles; storage event syncs
tabs (parity #112); transitions suppressed during swap (parity #110).

---

## 10. Performance budget

Numbers are budgets, not aspirations — each has an owner test in W13 (CI multiplies
thresholds ×3 for machine variance; the local baseline is an M1/M2).

| # | Metric | Budget | How achieved | How measured |
|---|---|---|---|---|
| P1 | Run list TTFMP, 200 runs, warm server | ≤ 500 ms total (server ≤ 150 ms) | summary caches, keyset pagination, virtualized rows | root perf test hits `/api/runs` on a generated 200-run home; DOM test measures first commit |
| P2 | Run list server cost at 5,000 runs (90% settled, **10% stale** — the expensive mix, critique M4), steady state | ≤ 120 ms/request local / ≤ 360 ms CI; ≤ 2 immediate signal stats per settled run; artifact stats amortized over 6 s; quiescent probes amortized at ~1/30 s with deterministic per-run TTL jitter (±25%, §5.4.2) so quiescent expiries never land on one request as a herd. The former 80 ms local threshold measured an artificial within-TTL burst; real 5 s cadence samples include artifact-refresh polls (99.7 ms observed under the concurrent root suite), so 120 ms is the honest regression ceiling with 20% local headroom. *Ratified by the operator (Ben Vargas, 2026-08-01): the deviation from the original 80 ms is accepted — concurrent-load noise on the dev machine, not a code regression (the endpoint got faster in the same change); revisitable in a follow-up PR.* | §5.4.2 tiers | perf fixture with 5,000 synthetic dirs incl. 500 stale, sampled at the shipped 5 s poll cadence |
| P3 | Cockpit interactive, 10 MB events.jsonl | ≤ 1.0 s (server fold ≤ 400 ms cold, ≤ 20 ms delta) | incremental fold cache, snapshot-then-tail | perf fixture run, `performance.now` around fold; jsdom mount timing |
| P4 | Fold throughput | ≥ 50,000 events/s (pure) | single-pass fold, no per-event allocation of agents map copies | vitest bench on shared fold.js |
| P5 | Live tail sustained | 5,000 records/s ingested, ≤ 60 store commits/s, zero dropped SSE frames | server batching (§5.6.3) + client rAF coalescing | mock EventSource feeding synthetic bursts; assert commit count |
| P6 | Transcript memory | ≤ 150 MB retained heap after a worst-case full window (20k records / 8 MiB source), independent of file size — parsed JSONL expands 5–15×, so 64 MB was unreachable (critique M14/Sol-14); the budget is now measured, not aspirational | record-count + byte window (§9.3), page-unit eviction, virtualization | spawned Node with `--expose-gc`: load the worst-case window, gc, assert `process.memoryUsage().heapUsed` delta; plus jsdom eviction bookkeeping |
| P7 | Dense 100 MB transcript browser open-at-tail (the server remains bounded on a sparse 500 MB history) | ≤ 1.0 s route change to first rendered row | 2 MiB tail page + outer timeline virtualization + bounded inner virtualization for large steps | real-browser fixture from `generateTranscriptRun` (no sparse prefix); supporting HTTP bound on a sparse 500 MB file |
| P8 | Reconnect catch-up, parameterized by gap (Sol-14: "20 min" says nothing — at P5's rate that is 6M records) | 100k records / 32 MiB of gap in ≤ 2 s, zero duplicates; larger gaps show a catch-up progress indicator and keep the tab responsive (rAF coalescing holds) | composite-cursor resume + batching | integration test with a paused client and a generated 100k-record gap |
| P9 | Expand/collapse latency on a 5,000-row transcript | ≤ 100 ms | virtualization + measurement cache | DOM test with fake timers |
| P10 | Bundle | ≤ 250 KB gzip JS, ≤ 300 KB fonts, no third-party requests | dep discipline (§9.1) | CI asserts on dist sizes |

`scripts/perf-fixtures.mjs` (dev-only, root) generates synthetic run dirs of
parameterized size — including a 10 MB events file, a 100 MB transcript, and a 5,000-run
home — using the real writers' formats.

---

## 11. Test strategy

### 11.1 Harnesses

- **Root (`node scripts/test.mjs`)** — the existing 144 tests keep passing untouched;
  new server + engine tests join `test/*.test.js` (node:test, zero deps, mock adapter,
  no network beyond loopback).
- **Viewer (`viewer/`: `npm test` → vitest)** — pure logic in node env; DOM behaviors via
  per-file jsdom opt-in (a split the recon proved necessary: a suite of pure tests
  passed while the composed screen was broken).
- CI runs both; the root suite must pass with **no `viewer/node_modules` present**
  (guards the zero-dep runtime claim structurally).

### 11.2 Root-suite additions

| File | Covers |
|---|---|
| `test/engine-events.test.js` | E1–E7, E16: field presence matrices per state (incl. `stallMs` on running, `lastOutputAt` on progress/terminal); key-stability pins (agentKey/deriveBranch byte-identical); queued-forever fix; progress throttle; concurrent-branch phase isolation; sibling-fanout ordinals |
| `test/engine-mail-events.test.js` | E8–E10: id joins across event/journal/transcript; mail-out written; attempt records; full-prompt cap marker |
| `test/protocols-ids.test.js` | E11 per-adapter id/pairing incl. parallel tool_use fixture |
| `test/retention.test.js` | E13: refuse-live (against a real running mock run), **resume-vs-delete race (delete loses)**, symlink refusal, artifact-less refusal, containment, traversal, trash+purge |
| `test/viewer-tail.test.js` | tail.js: torn tail, multibyte across chunk boundary, shrink/rotate reset, missing file, huge line cap, **bounded 1 MiB chunk reads (§5.6.6)** |
| `test/viewer-cursor.test.js` | cursor round-trip, lenient parse, unknown keys |
| `test/viewer-fold.test.js` | §6.4 normative cases: G11 clearing, steered-as-annotation, resumed-run latch clearing, **attempt scopes (resume-replayed phases/logs/mail don't duplicate; re-asked question upserts — M5)**, **openQuestions zeroed + abandoned on terminal runs (M6)**, **caps from engine version: zero-agent new run reports supported, no older-engine copy (M2)**, terminal-without-started stub attempt (N14), unknown states/types, incremental == batch equivalence |
| `test/viewer-summaries.test.js` | cache hit/miss, settled/quiescent/live tiers, **run.lock invalidates a settled verdict (attached-resume regression — M1/Sol-5)**, end-first meta:null journals (B3), (dev,ino) recreation invalidation, vanished-dir pruning, pagination cursors incl. stable createdAt (M16), unfiltered listing (custom run-ids + bare dirs appear) |
| `test/viewer-http.test.js` | security matrix: Host×Origin×token×control-token×method×content-type (each failing dimension → exact code); static traversal + symlink escape; CSP headers present; **dist has zero inline script/style (B1)**; 405/404 envelopes; read-only default 403s; cancel body validation (N5) |
| `test/viewer-reuse.test.js` | §4.2.1: challenge proof round-trip; **spoofed-healthz fixture — a fake listener returning the app+homeHash shape must not be reused and must never see the token (Sol-2)**; rendezvous file lifecycle; `--open` bootstrap file is 0600 and argv is token-free |
| `test/viewer-stream.test.js` | SSE against synthetic dirs with a minimal line-parsing SSE client: replay-then-tail, Last-Event-ID resume, **precedence: stale `?cursor=` + fresh `Last-Event-ID` replays only from the header (M3/Sol-9)**, per-stream reset ordering, batching ids, journal-feed 64 KiB record cap (M8), sys reset/gone/end, backpressure pause (slow reader), keepalives |
| `test/viewer-search.test.js` | §5.4.7: chunked scan, 2 s deadline truncation, one-in-flight 409, **SSE keepalive on schedule during a 64 MiB search (M9)** |
| `test/viewer-control.test.js` | bridge against a real `serveControl` handler: send/answer/cancel mapping with per-command timeouts (M13), run_not_live mapping, resume spawn (marker written, `launchAccepted` semantics, argv correct, no in-process runWorkflow), completed-run replay allowed (Sol-12), delete guards, audit lines written |
| `test/viewer-e2e.test.js` | §11.4 |
| `test/zero-deps.test.js` | root package.json has no `dependencies`; `src/viewer/**` imports only `node:` and relative paths, **with an explicit denylist: never `../engine.js`, `../agent-proc.js`, or `../adapters/*` (critique N7 — the allowed engine-side imports are run-state, run-lock, control, util, journal, events, transcript, retention; `run-lock.js` is required only for the resume handoff and imports builtins)** |

### 11.3 Viewer-suite

Fold re-run of the normative cases (same fixtures, imported); `toItems` projection (26+
cases incl. orphan results, interleaved text/reasoning, attempt splits);
`workSummary` (every fd-redirect case the recon catalogued — parity #87–90);
Markdown fuzz + whitelist assertions (§9.7); ANSI incremental/SGR-carry;
`sse.ts` latch composition against MockEventSource with fake timers (reconnect-resume,
reconnect-reset, terminal-fold latch, resumed-run re-arm — parity #118);
DOM tests: status glyph vocabulary incl. unknown→neutral, dead-run overlay, sticky
scroll intent, answer-composer optimistic flow, confirm dialogs (focus trap, type-to-
confirm), keyboard walkthrough; the source grep test enforcing the no-innerHTML rule.

**W8b amendment — the committed-dist comparison.** §4.6 accepts "stale dist can silently
ship an old UI" against a CI job that rebuilds and hash-compares (W14). That defense is
also a TEST in this suite (`src/dist-freshness.test.ts`): it runs a clean `vite build` into
a temp directory and byte-compares the whole output tree against `viewer/dist`. W14 still
owns the CI wiring; this exists because the failure it catches already happened once — a
review round fixed two defects in `src/` and shipped a `dist/` built before the fix, with
every other test green, because every other test reads `src/`. It belongs here rather than
in the root suite: §11.1 requires the root suite to pass with **no `viewer/node_modules`**,
so the root suite structurally cannot build. Two properties make the byte comparison sound
and are verified: the build is deterministic across consecutive runs, and identical on Node
18.17.1 and Node 24 (`NODE_ENV` is pinned to `production` in the spawn, because vitest sets
`NODE_ENV=test` and a build under it emits development React).

### 11.4 End-to-end (root)

`test/viewer-e2e.test.js`: run a real workflow on the **mock adapter** with `parallel` +
`pipeline` + `phase` + `ask()` + `sendTo()`; start `startViewer` on an ephemeral port
(`--port 0` semantics) **with all control capabilities enabled**; then over real HTTP:
list shows the run live → snapshot shows structure/phases/queued→running transitions →
SSE tails an agent transcript to completion → POST answer resolves the workflow's
`ask()` (asserted by the workflow completing with the answered value) → result endpoint
serves the final result → run re-listed as completed → DELETE refused while live
earlier, succeeds after terminal and lands in trash. A second pass: cancel a run with a
pending `ask()` and assert `openQuestions` drops to 0 and the run leaves the attention
strip (critique M6); the same mutations against a viewer started **without** `--control`
all return 403. This single test walks the product's spine: observe → act → outcome.

---

## 12. Delivery plan

Lanes: **codex** = gpt-5.6-sol high (strong on exhaustively-specified algorithmic and
mechanical work). **opus** = claude opus-5 high (taste-critical UI, security-sensitive
work — note the operator's standing guidance that Sol's safeguards can stall on
security-flavored tasks, so the auth/threat-model units go to the Claude lane).
Each unit is independently verifiable; its tests are part of the unit.

**File-ownership rule (Sol-15):** every core engine file has exactly one owner at a
time. The opus lane owns `src/engine.js`, `src/agent-proc.js`, `src/keys.js` through
W1–W2; `src/cli.js` changes land in W2 (E14/E16), W3 (rm/prune), and W4 (viewer cmd)
**sequentially in that order**, rebasing on the previous unit — never in parallel.
W1→W2→W3 are one lane's pipeline, not parallel units.

| W | Scope | Files | Acceptance criteria | Deps | Lane |
|---|---|---|---|---|---|
| **W1** | Engine events change-set: E1–E7 (+E15) | src/engine.js, events.js, semaphore.js, agent-proc.js (progress hook + lastOutputAt), keys.js (path param), index.d.ts, test/engine-events.test.js | Field matrices per §8; key-stability pins pass; all 144 existing tests green; `flowition status` shows no stale errors (E15) | — | opus (determinism-adjacent core) |
| **W2** | Engine transcript/mail change-set: E8–E12, E14, E16 | agent-proc.js, protocols.js, engine.js, transcript.js, journal.js (attemptCounts), cli.js, mcp.js, tests | id joins per §11.2; mail-out written; prompt cap marker; custom run-ids listed; foreground runId in CLI | W1 | opus (same owner as W1 — shared files) |
| **W3** | Retention: E13 | src/retention.js, cli.js (rm/prune), test/retention.test.js | §7.3 guards proven against a live mock run incl. the resume race; separate security review before merge (Sol-15) | W2 | opus |
| **W4** | Server skeleton + security: http.js, auth.js (tokens + challenge proof), static.js, error envelope, CLI `viewer` cmd, discovery/reuse, auto-start, idle shutdown, audit.js | src/viewer/{index,http,auth,static,routes,audit}.js, cli.js, test/viewer-http.test.js, test/viewer-reuse.test.js | full §11.2 security matrix green; challenge-probe reuse; spoof fixture rejected; auto-start TTY-gating; never prints unverified URL; read-only default | W3 (cli.js hand-off) | opus (security) |
| **W5** | Tail engine + cursor + SSE stream; refactor CLI tail onto tail.js | src/viewer/{tail,cursor,stream}.js, src/cli.js (tail), tests | §5.6 complete incl. precedence table + all five edge scenarios; stream tests green; existing tail tests green on the shared module | W4 | codex (exhaustively specified algorithm) |
| **W6** | Read API: summaries, snapshot fold + journal join, pages (transcript+events), result routes, search | src/viewer/{summaries,snapshot,fold,journal-view,pages,search}.js, tests | §6.4 normative fold cases; 5,000-run fixture (10% stale) within P2; pages within P7; search within §5.4.7 bounds | W4 | codex |
| **W7** | Control bridge + lifecycle routes | src/viewer/control-bridge.js, routes, test/viewer-control.test.js | §7.2 mapping table exact incl. timeouts + capability gating; resume spawns CLI detached, `launchAccepted`; delete uses retention.js only | W3, W4 | opus (mutation safety) |
| **W8** | Reference comps (§3.7, human-approved) → SPA scaffold + design system: tokens, theme, fonts, icons, router, shell, home + run rail | viewer/* (ui/, home/, theme), docs/frontend/comps/ | comps approved before code; §3 tokens verbatim; contrast check passes both themes; screens match comps at fixed viewports; home + rail render against W6 API; empty/error/loading states | W6 | opus (taste) |
| **W9** | Client data layer: shared fold import, SSE client + latch, stores, journal join | viewer/src/{api,state,fold} + tests | latch tests (parity #97–104) green vs MockEventSource; per-stream reset semantics; P4/P5 benches met | W5, W6 | opus (subtlest client logic) |
| **W10** | Transcript feature: virtualization, renderers, step grouping, §2.5.1 cards, per-row times, search UI | viewer/src/features/transcript | parity #63–96 per §14; markdown fuzz green; P6/P7/P9 met; no-innerHTML grep green | W8, W9 | codex |
| **W11** | Cockpit: header, budget gauge, lineage, Timeline/Gantt + saturation, Structure DAG, Agents table + §2.4.1 phase tree, log lane | viewer/src/features/cockpit | Q2/Q4/Q5/Q6/Q7 walkthroughs; screens match approved comps; old-run degradation notes render; parity #45–62 per §14 | W8, W9 | opus (taste-critical) |
| **W12** | Interactivity UI: inbox rail, composers, confirmations, resume/delete, palette, keyboard, a11y focus wiring | viewer/src/features/control, palette | §7.2 UX table exact; e2e answer flow; keyboard-only walkthrough recorded in test | W7, W8 (Dialog primitive), W11 | opus |
| **W13** | E2E + perf + a11y hardening | test/viewer-e2e.test.js, scripts/perf-fixtures.mjs, perf tests | §11.4 green; every P# within budget (P6 measured via --expose-gc); §3.6 checklist verified | all | codex builds, opus reviews |
| **W14** | Packaging: viewer build in CI, dist commit + hash check + zero-inline-assert, files[] update, README/ARCHITECTURE docs, zero-dep guard test | package.json, CI, docs, test/zero-deps.test.js | `npm pack` contains dist; CI fails on stale dist or inline script/style in dist; root suite passes without viewer/node_modules | W10–W12 | codex |

**Ordering / demoable milestones (vertical increments, Sol-15):** the engine pipeline
W1→W2→W3 and the server track W4 (which begins once W3 releases `cli.js`) →W5/W6 are
sequenced by ownership; W5 and W6 run in parallel (disjoint files, both on W4).
Increment A (read-only product): W4+W6+W8 — authenticated list/cockpit/transcript/
result by polling. Increment B (the decisive differentiator): +W7+W12's answer/send/
cancel behind `--control`. Increment C (live + temporal): +W5+W9+W11. Increment D:
+W10 transcripts at full depth. Increment E: +W13/W14 hardening and packaging. Each
increment is mergeable and demoable on its own. Cross-checking: each lane reviews the
other lane's units at W-boundaries; the shared fold (W6) and its client consumption
(W9) are the deliberate cross-lane seam — both lanes run the same normative fold
fixtures against frozen versioned fixture dirs generated by `scripts/perf-fixtures.mjs`
(fixtures freeze at W6 merge; engine-event changes after that bump the fixture version
explicitly).

### 12.1 Final review acceptance checklist (the 3-panel gate)

The human + claude-opus-5 (high) + codex gpt-5.6-sol (xhigh) panel checks, in order:

1. The §14 compliance matrix: every row `exact` or `superseded` demonstrated or covered
   by its cited test; no row silently waived (superseded rows carry their equivalence
   argument in §14 itself).
2. Zero-dep invariants: root `package.json` has no `dependencies`; root suite passes with
   no `viewer/node_modules`; `src/viewer` imports only `node:`/relative minus the N7
   denylist.
3. Security matrix test green; manual probes: wrong Host → 403, no token → 401, mutation
   without control token → 403, cross-origin POST from a scratch page → blocked, token
   absent from every log line, spoofed healthz not reused.
4. e2e spine (§11.4) green.
5. From the UI, within one session on a live mock run started with `--control`: answer
   an `ask()` (≤2 clicks from home), steer an agent and see the delivery verdict, cancel
   one agent, cancel the run via the confirm modal, resume it, delete a terminal run via
   type-to-confirm and find it in trash. On a read-only viewer: the same controls render
   locked with the explanation chip.
6. New-engine run shows: DAG, queue-wait segments, saturation strip, progress ticks,
   budget gauge with overshoot, error-code chips. Old-run fixture (pre-E1 events)
   degrades per §6.5 with visible "older engine" notes and zero blank panels.
7. A 100 MB transcript fixture opens at tail ≤1s, scrolls back smoothly, heap within P6.
8. Kill -9 a running engine: run flips to stale (server-derived, never client-guessed);
   agents render orphaned; Resume works from the stale card.
9. Keyboard-only walkthrough of the §5 flow; screen-reader spot-check of run list, state
   chips, live region; both themes pass the contrast script; reduced-motion honored.
10. Perf budget table (§10) with measured numbers attached to the review.
11. `flowition run` on a TTY auto-starts/reuses the viewer, prints a working deep link;
    `--json`/`--detach`/MCP runs never do.
12. Existing 144 tests green; resume-key pin tests green (byte-identical keys).

---

## 13. Open questions — with the architect's answers

Implementers cannot ask; these are the answers.

1. **Windows?** Out of scope v1 (§1.3). The server refuses to start on `win32` with a
   clear message. The engine's control socket story on Windows is unresolved upstream;
   do not partially support it.
2. **Multiple `FLOWITION_HOME`s?** One viewer per home. Each home has its own
   `viewer.json` rendezvous + `viewer.token`; the §4.2.1 challenge proof fails against
   a different home's instance (different token), so a starting caller picks the next
   port. No multi-home UI.
3. **Token rotation/loss?** `flowition viewer --print-url` reprints; deleting
   `viewer.token` regenerates on next start (invalidating open tabs — acceptable).
   The control token is ephemeral by design — restart `--control` to rotate. No
   rotation UI.
4. **Show `args`?** Yes, behind an explicit "show args" disclosure in the cockpit header
   (RunDetail `?include=args`), because args may contain secrets and must not sit in the
   default payload or the stream (§5.6.5). Same-user, token-gated — serving it at all is
   consistent with the threat model.
5. **`usage-cum` stream volume on journal-heavy runs?** Forward as-is (records are tiny
   and it's the live token feed); the client samples per agent per rAF. The §5.6.5
   64 KiB per-record cap applies in principle but never bites here; batching bounds
   frame overhead. No rate-limiting of usage-cum in v1.
6. **Many tabs?** Each run page = 1 SSE connection. The browser's per-origin cap (~6)
   bounds it naturally; the UI shows "live updates paused — too many open tabs" if
   EventSource errors persist while healthz succeeds. No SharedWorker in v1.
7. **Concurrent viewers (two `flowition viewer` processes)?** Prevented per home by the
   port-reuse protocol; a second instance on a custom port against the same home is
   read-safe (all readers are lossy; `deriveRunState`'s marker sweeps are the sanctioned
   mutation and are same-user) — though both share one `viewer.token`, so a credential
   rotation stops both, and a `--tailscale-origin` instance refuses to start as a
   secondary, and while its rendezvous record lives no secondary can start against it
   (§7.1.8). (A secondary that outlived an EARLIER local primary can still be running
   when a tailscale primary starts — it stays loopback-only and shares no policy.)
8. **Delete while a tab watches?** Stream emits `sys/gone`; the list prunes; the cockpit
   shows "run was deleted" (§5.6.4). No tombstone.
9. **Costs when the journal has no `cost`?** Render tokens only; never estimate prices
   client-side. A pricing table is a maintenance liability and a lie generator.
10. **Syntax highlighting / diff highlighting?** Deferred (bundle + dep budget). The
    renderer components isolate where a lazy highlighter could attach later.
11. **Cross-run search / analytics?** Deferred by design (§1.3); the summaries layer is
    the natural future home.
12. **Biggest schedule risk:** the Gantt (W11) is the largest bespoke-UI item. Mitigation:
    it is data-complete after W1 (E4/E6) — if it slips, the Agents table + saturation
    strip ship first and the Timeline tab lands behind a "beta" chip; the release gate
    (§12.1 item 6) then re-runs on its completion. Second risk: E8's touch on
    `AgentJob.send` emissions — bounded by the touch-emissions-never-control-flow rule
    and the existing mail test suite.

---

## 14. Parity-floor compliance matrix (normative)

Statuses: **exact** = built as the recon describes; **superseded** = replaced by an
equivalent-or-better mechanism, argument given here. No other statuses exist — nothing
is silently dropped. Acceptance gate 1 (§12.1) is checked against this table, not
against the catalogue prose in §14.1.

| # | Status | Where / argument | Owner |
|---|---|---|---|
| 1 | superseded | `RunsPage {runs, nextCursor, totalOnDisk}` — 5,000 runs force keyset pagination; the summary array is the `runs` field with the same per-run facts. A bare array cannot carry a cursor. §5.4.2 | W6 |
| 2 | exact | bare dirs listed as `unknown` — §5.4.2 step 1 | W6 |
| 3 | exact | fold tier keyed (size,mtime) — §5.4.2 | W6 |
| 4 | superseded | cached summaries store raw folded status; liveness re-derived per tier — settled runs check `.resuming` and `run.lock` on every request instead of doing a full derivation; `acquireRunLock` occurs at src/engine.js:588–592 before the resume journal load at :789–793, so the 6 s artifact-stat amortization cannot hide a revival. §5.4.2 | W6 |
| 5 | exact | §5.4.2 step 4 | W6 |
| 6–7 | exact | §5.4.3 (incl. skeleton for empty dirs) | W6 |
| 8 | exact | §5.1 principle 1, §5.4.1 | W4 |
| 9 | superseded | windowed page route; the full transcript is the page loop from 0 (same data, bounded memory — a whole-file route means a 500 MB response); 404-when-absent identical. §5.4.4 | W6 |
| 10 | exact | events stream replays from cursor 0 then tails — §5.6.1 | W5 |
| 11 | superseded | agent streams default to `tail` + snapshot offsets; full history via §5.4.4 paging or an explicit `a<n>=0` cursor. Replaying a 500 MB transcript over SSE is the failure mode this design exists to fix. §5.6.1 | W5 |
| 12 | exact | per-record `o` + composite frame `id` — §5.6.3 | W5 |
| 13 | exact | + normative precedence table — §5.6.2 | W5 |
| 14–15 | exact | §5.5, §5.6.7-1 | W5 |
| 16–18 | exact | §5.6.6 (bounded 1 MiB chunks, byte-domain pending, multibyte-safe) | W5 |
| 19 | exact | per-stream `sys/reset` — §5.6.4 | W5 |
| 20 | exact | 1 s drain — §5.5 | W5 |
| 21 | exact | 15 s keepalive, `x-accel-buffering: no` — §5.6.3 | W5 |
| 22 | exact | §5.6.3 teardown | W5 |
| 23 | exact | lossy readers — §5.1 | W5/W6 |
| 24 | exact | woff included — §5.8 | W4 |
| 25 | exact | §5.8 | W4 |
| 26 | exact | §5.8 + hash routing §2.2 | W4/W8 |
| 27 | exact | §5.3 | W4 |
| 28 | exact | `--port 0` defined — §4.2 | W4 |
| 29 | exact | §4.2 library layer | W4 |
| 30 | exact | `--idle-timeout` — §4.4 | W4 |
| 31 | exact | §4.2 | W4 |
| 32 | exact | §4.3 | W4 |
| 33 | superseded | the probe is an authenticated HMAC challenge, not a plain API probe — strictly stronger (an unauthenticated probe is impersonable; Sol-2). §4.2.1 | W4 |
| 34 | exact | §4.3 step 4 | W4 |
| 35 | superseded | deep link printed (§4.3); `--open` opens via a 0600 bootstrap file (token never in argv); macOS/Linux dispatch only — Windows is out of scope v1 (§1.3), an explicit narrowing | W4 |
| 36 | exact | §4.6 | W14 |
| 37–43 | exact | cockpit run rail: list+count, active mark, unreachable state, hide+persist, overlay drawer, drag-resize — §2.2 | W8 |
| 44 | exact | §2.2 routes, reload-safe | W8 |
| 45–46 | exact | §2.4 header | W11 |
| 47–51 | exact | §2.4.1 phase tree | W11 |
| 52–54 | exact | §2.4 Agents table (incl. lastTool, inline error) | W11 |
| 55 | exact | §2.5 | W10 |
| 56–57 | exact | §3.2 (unknown → neutral; monograms, never brand marks) | W8 |
| 58 | exact | orphaned displayState — §6.4 step 8, over every non-live run state (quiescent included) | W9/W11 |
| 59 | exact | §2.4 header | W11 |
| 60–62 | exact | §2.4.2 | W11/W8 |
| 63–65 | exact | §2.5 (split, header, prompt block with E10 cap marker) | W10 |
| 66 | exact | §9.7 | W10 |
| 67 | superseded | the floor item sanitizes raw HTML and pins the raw→sanitize plugin order; flowition renders raw HTML as **literal text** and therefore has no raw pipeline to order. A remark-stage transform rewrites every mdast `html` node into a text node before hast exists, so the markup is visible and inert; react-markdown runs with no rehype-raw (absence enforced by the §16.7 package-graph test) under an `allowedElements` allowlist. Stronger than sanitizing — nothing to sanitize — and honest to the reader, which dropping was not (CORRECTED, panel round 3: this row previously claimed HTML "stays literal" while the shipped renderer discarded it). §9.7/§16.2 | W10 |
| 68–70 | exact | §9.7 | W10 |
| 71 | exact | §2.5 (reasoning + one-line preview) | W10 |
| 72 | superseded | terminal card with command + output; exit code **only when an adapter reported one** — rendering `isError?1:0` *as if* it were an exit code is fabrication, and no flowition adapter reports real codes today (src/adapters/protocols.js:90–93). Honest omission beats fabricated parity; L2 adds pass-through where adapters can be honest. §2.5, §9.8 | W10 |
| 73 | exact | §2.5.1 | W10 |
| 74–75 | exact | §9.8 (incl. forced-contrast rule on SGR-48 backgrounds) | W10 |
| 76 | superseded | escaping is structural — React text nodes; there is no HTML string path on initial or appended output. §9.8 | W10 |
| 77–82 | exact | §2.5.1 | W10 |
| 83–90, 92 | exact | §9.6 | W10 |
| 91 | superseded | Catalogue #91 is "a single-row step is never wrapped in a summary"; the build DOES wrap it — `VirtualTimeline.tsx` renders every step as a `<section class="step">` with a `.step-head` summary button, and `grouping.ts` creates a step unit for a lone work item, so a one-row step carries a header ("Ran 1 tool" / "1 row"). §9.6 replaces the never-wrap rule with an **expansion** rule — a step expands iff it is single-item, contains a pending row, or is the live frontier — and that is what shipped. The argument: uniform step chrome means one row shape, one keyboard target and one manual-toggle contract (#93) at every step size, instead of a second unwrapped shape that #93 could not address; and because single-item steps auto-expand, **nothing is ever hidden** — the summary is a label above the row, not a disclosure the operator must open. Cost is one header line per single-row step, which is the whole delta. Relabelled from `exact` in panel round 2: the behavior is defensible, the label was not, and §14 is only worth having if `exact` means what its preamble says. | W10 |
| 93 | exact | §2.5.1 manual override | W10 |
| 94 | exact | §3.4 | W10 |
| 95 | exact | §2.5 footer | W10 |
| 96 | exact | §2.5.1 error card | W10 |
| 97–98 | exact | §5.5 list poll, §9.3 status poll | W9 |
| 99 | exact | completed-run resume allowed (§7.3) + stream re-arm (§5.6.4, §9.3) | W7/W9 |
| 100–104 | exact | §5.6.4 end, §9.3 latch rules, §9.4 per-stream resets, rAF coalescing | W9 |
| 105–106 | exact | §9.5 | W10 |
| 107 | exact | §2.5.1 fades | W10 |
| 108–112 | exact | §9.9 (theme; pre-paint via external boot-theme.js), §2.7 (`d` key) | W8 |
| 113–114 | exact | §6.3 | W8 |
| 115–116 | exact | §3.1 (self-hosted fonts, zero third-party requests; offline-clean) | W8 |
| 117–118 | exact | §11.3 (pure layer + behavioral latch composition) | W9/W10 |
| 119 | exact | §2.4.1 collapse override + §11.3 DOM tests | W11 |
| 120 | exact | §11.1 harness constraints | W13 |

Tally: 110 exact, 10 superseded (#1, #4, #9, #11, #33, #35, #67, #72, #76, #91), 0 dropped.

### 14.1 Feature-floor catalogue

The 120 items the matrix above scores, catalogued during design recon from the
strongest prior-art run viewer studied. Each is a user-visible or externally-verifiable
capability that existed before this design; matching the floor is the entry fee, not
success (§1.2 goal 1). Item numbers are stable identifiers — "parity #N" anywhere in
this document or the source tree means the item below.

**Server / transport**

1. `GET /api/runs` returns a JSON array of run summaries (`runId, name, status, agents, startedAt, endedAt`) sorted newest-first.
2. A run directory that exists but has no events still appears in the list, with status `unknown` and 0 agents.
3. Run summaries are cached keyed on `(size, mtime)` of the run's event log and recomputed only when it changes.
4. The cached summary stores the pre-liveness status, and liveness is re-derived from live on-disk state on every request, so a cached "running" run flips to dead without a restart.
5. Cache entries for deleted run directories are evicted.
6. `GET /api/runs/:id` returns a full folded snapshot including phases, agents, logs, workflow name, start/end times, and error.
7. `GET /api/runs/:id` returns 404 JSON for a nonexistent run and 200 for a run directory that exists but is empty.
8. An invalid or malformed-percent-encoded run id returns 400, never a 500 or a path escape.
9. `GET /api/runs/:id/agents/:n` returns the full transcript chunk array, or 404 JSON when the transcript file doesn't exist yet.
10. `GET /api/runs/:id/stream` is an SSE endpoint that replays the entire existing event log then tails it live.
11. `GET /api/runs/:id/agents/:n/stream` is an SSE endpoint that replays then tails one agent's transcript.
12. Each SSE frame carries `id:` = the byte offset immediately after that line.
13. A reconnect with `Last-Event-ID` resumes from that byte offset and replays nothing already delivered; a malformed or absent header starts from 0.
14. The SSE tail tolerates a file that does not exist yet and begins delivering once it appears.
15. The SSE tail tolerates a directory that does not exist yet (polling until it appears) rather than hanging forever.
16. The SSE tail reads in bounded chunks and never allocates the whole unread region at once.
17. A multibyte UTF-8 character split across a read boundary is delivered intact, never as U+FFFD.
18. A partial trailing line (no newline yet) is carried over and emitted only once complete.
19. A file that shrinks or rotates resets the tail to offset 0 and the client re-syncs without duplication.
20. File-change delivery does not depend on `fs.watch` alone: a periodic drain bounds staleness to ≤1 s if a watch event is missed.
21. The SSE connection sends a keepalive comment frame at least every 20 s and sets `x-accel-buffering: no`.
22. Disconnecting mid-replay tears down the watcher, the keepalive, and the poll, and decrements the live-client count exactly once.
23. Malformed JSON lines in either log are skipped, not fatal.
24. Static SPA assets are served with correct content types for html/js/css/json/svg/woff2/woff/png/ico.
25. Static serving rejects path traversal (`../`, absolute, encoded) with 403 and never serves outside the asset root.
26. `/` serves the SPA entry document; deep links work without a server-side fallback route.
27. Non-GET/HEAD requests return 405; unmatched `/api/*` paths return 404 JSON.
28. The server binds `127.0.0.1` by default and supports an explicit port and an ephemeral (0) port.
29. The server can be started as a library returning `{url, close}` and never calls `process.exit` itself.
30. With idle-shutdown enabled, the viewer fires its idle handler after a configurable idle period with no SSE clients and no live runs, and the idle timer does not by itself keep the process alive.
31. A CLI `serve` command starts the viewer, prints its URL and the directory it reads to stderr, and shuts down cleanly on SIGINT/SIGTERM.
32. Running a workflow auto-starts the viewer if one isn't already listening, reuses it if one is, and can be disabled with a flag.
33. Auto-start detects an already-running viewer by probing its API with a short timeout.
34. Auto-start never prints a URL it could not verify is live.
35. The run command prints a deep link to that specific run, and an `--open` flag launches it in the platform browser (macOS/Windows/Linux).
36. The published package ships prebuilt viewer assets; no frontend toolchain is required at install or runtime.

**Run list & navigation**

37. A sidebar lists all runs with name-or-id, a status indicator, agent count, and a relative start time.
38. The sidebar shows a total run count.
39. The currently-viewed run is visually marked as active.
40. An API-unreachable state is shown explicitly in the sidebar rather than an empty list.
41. The sidebar can be hidden and reopened, and that choice persists across reloads.
42. Below a narrow viewport breakpoint the sidebar becomes an overlay drawer that closes after selecting a run.
43. The sidebar/content split is drag-resizable within sane min/max bounds.
44. Routing is deep-linkable to a run and to a specific agent within a run, and survives a page reload.

**Run detail**

45. A run header shows the workflow name, run status, and aggregate stats: completed/total agents, total tokens, total cost, elapsed time.
46. Elapsed time ticks live once per second while the run is in progress and freezes at the final duration when it ends.
47. Phases render as a tree of collapsible groups, in declaration order.
48. Phases declared but not yet entered render as dimmed plan slots labelled "pending", and as "not run" once the run has ended.
49. Each phase shows a rolled-up status glyph and a completed/total agent count.
50. A phase that completes cleanly auto-collapses; a phase containing the selected agent defaults open; an explicit user toggle overrides both and is not reverted by later prop changes.
51. Agents with no phase render in their own ungrouped section rather than disappearing.
52. Each agent row shows a provider mark, the agent label (or an index fallback), and a cached indicator when the result was replayed.
53. Each agent row shows model and effort (including effort alone when the model is implicit), total tokens, last tool, duration, and cost, omitting fields that are absent.
54. A failed agent row shows its error message inline.
55. Clicking an agent row opens its transcript pane.
56. An unknown or future status value renders as a neutral indicator, never as a success check.
57. An unknown provider renders as a neutral badge, never another vendor's brand mark.
58. A run whose process died renders a distinct "stale/dead" indicator, and its agents that were left `running` render the run's fate rather than a perpetual spinner.
59. The most recent workflow log line is shown in the run header.
60. A run with no agents yet shows an explicit empty state.
61. A run whose snapshot hasn't loaded yet shows an explicit loading state.
62. With no run selected, the app shows an explicit empty state.

**Agent transcript**

63. The transcript pane opens beside the run detail in a drag-resizable split and can be closed back to the run view.
64. The transcript header shows the agent label, provider mark and name, model/effort, tokens, duration, cost, and status.
65. The agent's prompt renders as a distinct user message, collapsed past a line threshold with a show-more toggle, hard-capped in length with a truncation marker, and copyable.
66. Assistant prose renders as markdown with GFM (tables, task lists, strikethrough).
67. Markdown raw-HTML rendering is sanitized, with the raw→sanitize plugin order enforced.
68. Markdown links open in a new tab with `rel="noopener noreferrer"`.
69. Fenced code blocks render with their language label and a copy-to-clipboard button.
70. Markdown tables can exceed the content column width and scroll horizontally without breaking the layout.
71. Reasoning renders as its own collapsible block, visually distinct from prose.
72. Shell commands render as a terminal card with the command line, output, and exit code.
73. The command line is clamped to two lines collapsed and expandable, and text selection inside it does not trigger the toggle.
74. Terminal output renders ANSI colors mapped to theme variables, works in both light and dark, and forces a readable foreground on colored backgrounds.
75. ANSI conversion of streaming output is incremental — only the new suffix is converted, with SGR state carried — and a non-append change rebuilds cleanly.
76. Terminal output HTML-escapes its content on both the initial and appended conversion paths.
77. Generic tool calls render the tool name, each argument as `key: value` (objects pretty-printed), and the result or error.
78. A long tool-argument header clamps with a gradient-faded "Show more" affordance and expands.
79. File changes render per file with an action icon and past-tense verb (created/deleted/renamed/edited), the path, and a `+N -M` tally.
80. Diff bodies render with additions, deletions, and patch-metadata lines visually distinguished.
81. Diff stats are computed correctly for unified diffs, for whole-file create/delete bodies, and for synthesized diffs from edit-tool arguments.
82. A file change with no diff renders an explicit "no diff available" rather than an empty card.
83. Tool results are paired to their tool call by id; an id-less result pairs to the most recent unpaired call; an unknown-id result never clobbers an unrelated call; a fully orphan result surfaces as its own completed row.
84. Consecutive text chunks coalesce into one message block, and consecutive reasoning chunks into one reasoning block, with correct interleaved ordering.
85. Shell commands wrapped as `<shell> -lc "<script>"` display the inner script, and non-shell `-c` invocations (`python3 -c`, `rg -c`) are not mangled.
86. Consecutive tool/command/file-change rows group into a step; a completed step collapses to a one-line work summary that expands to its rows.
87. The work-summary label counts distinct explored files, searches, lists, commands, tools, and created/deleted/edited/renamed files, and reads in the order the work happened.
88. A command that writes to a real file is classified as work, not exploration; `/dev/null` and fd-duplication redirects do not disqualify it.
89. Structured read/search/list tools are classified as exploration equivalently to their shell counterparts.
90. A step's label is past-tense when complete and gerund when active, with correct pluralization.
91. A single-row step is never wrapped in a summary.
92. The live frontier — the trailing step, and the last pending row — stays expanded and streams its output while the run is in progress.
93. Any row can be manually expanded or collapsed, and the manual choice overrides the automatic one.
94. Expand/collapse is animated, the closing body is retained for the duration of the animation, and collapsed bodies are not rendered.
95. A working indicator is shown while the agent is live, reading "Thinking" when the last activity was reasoning and "Working" otherwise, and is never shown for an agent the run has already settled or inside a dead run.
96. A failed agent shows its error in a distinct error card below the transcript.

**Live behavior**

97. The run list refreshes automatically without a page reload.
98. Run status is polled independently of the event stream so a killed run is detected even when no further events arrive.
99. A run resumed after finishing re-opens its event stream and the page updates without a reload.
100. The event stream closes once the run has definitively ended, so an auto-started viewer can idle out.
101. A terminal status verdict arriving mid-replay does not sever the stream or truncate the agent list.
102. A live-but-quiet run (no events for longer than the stale window) is never shown as dead by the client on its own.
103. A reconnect that replays from the beginning resets client buffers so nothing is duplicated; a reconnect that resumes keeps them.
104. A burst of thousands of replayed frames is coalesced to one render per animation frame and does not freeze the tab.
105. The transcript pane sticks to the bottom while streaming, stops following once the user scrolls up with intent, and resumes when they return to the bottom.
106. Programmatic scrolls do not break the follow behavior.
107. Scroll containers show top/bottom fade affordances only when content is actually clipped in that direction.

**Presentation & platform**

108. Light, dark, and system themes, with the choice persisted.
109. The correct theme is applied before first paint (no flash of the wrong theme).
110. Theme changes do not produce a transition flash across the whole UI.
111. A keyboard shortcut toggles the theme, ignored while typing in an input.
112. Theme changes propagate across open tabs.
113. Token counts, durations, costs, relative times, and elapsed clocks are rendered in compact human units.
114. Sub-dollar costs are rendered with enough precision to be distinguishable, never collapsed to `$0.00`.
115. Fonts are self-hosted; the viewer makes no third-party network requests.
116. The viewer works offline against a purely local server.

**Engineering**

117. The pure data layer — event folding, chunk→item projection, work summarization, formatting, incremental ANSI — is unit-tested.
118. The live composition (stream latch × fold × status poll, including reconnect, resume, and deadman paths) is tested behaviorally against a mock event source, not just via pure predicates.
119. Component-level behaviors (status glyph vocabulary, phase collapse override, dead-run overlay, sticky scroll wiring) are covered by DOM tests.
120. The whole suite runs with no network access, no API credits, and no real agent CLI.

---

## 15. Critique disposition

Every BLOCKER and MAJOR from both critiques, plus the MINORs. "FIXED §x" = the
document was changed at that location. Where a finding was factually wrong, the
rejection cites source.

### CRITIQUE-fable.md

| Id | Disposition |
|---|---|
| B1 | **FIXED** — §7.1.4 pins: external `/boot-theme.js` (§9.9), `modulePreload.polyfill: false` (§9.2), CI zero-inline assertion + no `style=` attributes (W14, §11.2). Nonces rejected for the reason the critique gave. |
| B2 | **FIXED** — §14 compliance matrix replaces the incorporation clause; run rail added (§2.2, #37–43); new specs §2.4.1 (#47–51), §2.4.2 (#60–62), §2.5.1 (#73–107 subset); #2 in §5.4.2; #16 in §5.6.6; #24 in §5.8; #28/#35 in §4.2; #50/#93 collapse/override rules written. |
| B3 | **PART FIXED / PART REJECTED** — the end-first counterexamples are real and the meta tier is rewritten around them with `(path, dev, ino)` identity keying (§5.4.2). **Rejected:** "nothing anywhere refuses `--run-id` reuse; a second meta gets appended" — the engine refuses a fresh run against any existing journal at src/engine.js:764–766 (`run <id> already has a journal`), so a journal can never hold two `meta` records and the proposed E16 guard already exists. The frozen-journal property this guard creates is what makes the first-line fast path sound. |
| B4 | **FIXED** — E4 rewritten: `queued` getter only; `active` stays a field; `sem` gauge sampling sites specified. |
| M1 | **FIXED** — settled tier checks `.resuming` **and** `run.lock` by stat before trusting a cached terminal verdict (§5.4.2, §5.7). |
| M2 | **FIXED** — Caps are three-state, derived from the E3 `engine` version, never field presence (§6.2, §6.5); pin test added. |
| M3 | **FIXED** — normative precedence table: `Last-Event-ID` wins; `?cursor=` initial-connect/reopen only; unknown-stream keys ignored (§5.6.2); stream test added. |
| M4 | **FIXED** — settled/quiescent/live tiers defined with explicit membership and TTLs; P2 restated against a 10%-stale fixture (§5.4.2, §10). |
| M5 | **FIXED** — attempt scopes for phases/logs/mail; agents and questions explicitly unscoped; three fold tests added (§6.4 step 1a, §11.2). |
| M6 | **FIXED** — `openQuestions` moved to the post-pass, zeroed for terminal/stale; `QuestionView.abandoned` added; e2e case added (§6.4 step 8, §6.2). |
| M7 | **FIXED** — one hash grammar with reserved params, parse order, sessionStorage hand-off, and non-looping auth failure (§2.2); both CLI print sites updated (§4.2, §4.3). |
| M8 | **FIXED** — 64 KiB per-record stream cap with `resultTruncated`/`resultBytes`; new `GET …/agents/:n/result`; `AgentView` fields added; RunDetail never inlines full values (§5.6.5, §5.4.5, §6.2). |
| M9 | **FIXED** — chunked async scan, 2 s deadline, one-in-flight per connection, keepalive-under-search test (§5.4.7, §11.2). |
| M10 | **FIXED** — resolved `stallMs` emitted on `running` (E4); `AgentView.stallMs`; labelled fallback for old runs (§2.4). |
| M11 | **FIXED** — composer gate is `state === 'running'`; queued agents get a disabled composer with queue position (§2.5, §7.2). |
| M12 | **FIXED** — delete acquires the run lock, re-derives after, refuses symlinks; race test asserts delete loses (§7.3, E13). Also upgraded to trash+purge per Sol-4. |
| M13 | **FIXED** — per-command bridge timeouts (300 ms status / 2000 ms mutations), `retryAfterMs`, pending-disabled buttons (§7.2). |
| M14 | **FIXED** — window bounded by 20k records or 8 MiB; page-unit eviction; P6 re-budgeted at a measured 150 MB with an `--expose-gc` assertion (§9.3, §10). |
| M15 | **FIXED** — E2 restated with the `makeCtx` signature change and all three construction sites, including pipeline's per-stage rebuild and the unreached-stage rendering rule. |
| M16 | **FIXED** — birthtime fallback chain, never dir mtime; createdAt pinned per (path, ino) (§5.4.2 step 3, §5.7). |
| M17 | **FIXED** — ENOENT branch creates 0700 dirs; `home()` checked too; 0600 token-file test (§4.1). |
| M18 | **FIXED** — tail.js specified independently (§5.6.6); W5 refactors the CLI loop onto it. |
| M19 | **FIXED** — gauge plots `spend.output` vs `budgetTotal`, stated in §2.4 with source cites; DOM test added. |
| N1 | **FIXED** — §5.4 renumbered contiguously 5.4.1–5.4.7, with the suggested validation subsection as 5.4.1. |
| N2 | **FIXED** — §5.4.1 (`args` absent-not-null, no-store, audit line). |
| N3 | **FIXED** — `toolIds` moved to `AgentView`; the pairing badge reads it (§6.2). |
| N4 | **FIXED** — two-hop `key → index` join; keyless mail renders run-scoped (§6.4.J). |
| N5 | **FIXED** — cancel body validation: present-but-invalid `agent` (incl. null) → 400 (§7.2). |
| N6 | **FIXED** — `process.execPath` + module-relative binPath, citing src/mcp.js:47–55 (§4.3, §7.3). |
| N7 | **FIXED** — explicit import denylist in zero-deps test (§11.2). |
| N8 | **FIXED** — SGR-48 passthrough with luminance-forced foreground (§9.8). |
| N9 | **FIXED** — capabilities surface moved to `/api/session` + rendezvous file; SPA shows a persistent "controls locked"/read-only chip; auto-start still reuses (§4.2, §4.3, §7.2). |
| N10 | **FIXED** — realpath containment for watch targets; error handlers downgrade to poll (§5.5). |
| N11 | **FIXED** — idle requires event-log progress, not just a `running` verdict (§4.4). |
| N12 | **FIXED** — field renamed `hasRunLog`; badge copy "detached log" (§6.2). |
| N13 | **FIXED** — W11 deps gain W8; W12 deps note the Dialog primitive (§12). |
| N14 | **FIXED (fold rule) / REJECTED (engine change)** — the stub-attempt fold rule is normative (§6.4 step 1). Moving the `started` emit before module load is rejected: the event's `name` comes from the imported module's `meta` (src/engine.js:1140, :841), so an early emit is either nameless or a second run event — worse than the fold rule for old and new CLIs alike. |

### CRITIQUE-sol.md

| Id | Disposition |
|---|---|
| Sol-1 | **FIXED** — read-only by default; `--control[=caps]` opt-in; ephemeral control token separate from the read token; capabilities in `/api/session`; auto-start never passes control (§4.2, §4.3, §7.1.2, §7.2). Routes stay registered but 403 with an explanatory envelope — capability discovery beats route-absence 404 ambiguity; the SPA renders locked controls either way. |
| Sol-2 | **FIXED** — healthz demoted to readiness; HMAC challenge proof (token never transmitted); 0600 rendezvous file; `--open` via 0600 bootstrap file so argv is token-free; spoofed-listener fixture test (§4.2.1, §11.2). |
| Sol-3 | **PART FIXED / PART REJECTED** — inline theme script and Vite polyfill: fixed with B1. **Rejected:** "`style-src 'self'` blocks virtualization/Gantt/ANSI positioning" — React applies the `style` prop through CSSOM property assignment (`node.style.x = …`), which `style-src` does not govern; only markup `style=` **attributes** are blocked, and the spec now bans those from `index.html`/`icons.svg` with a CI check (§7.1.4). No `style-src-attr 'unsafe-inline'` needed. |
| Sol-4 | **FIXED** — delete requires the `delete` capability; refuses artifact-less dirs (bare `unknown` dirs undeletable via API); symlink refusal; atomic move to `$FLOWITION_HOME/trash/` with 7-day purge; 0600 audit log for resume/delete/cancel/args-read that survives the deletion (§7.3). |
| Sol-5 | **FIXED** — same as M1: settled-tier lock+marker stats; attached-resume regression test (§5.4.2, §11.2). |
| Sol-6 | **FIXED** — E16 (CLI allocates foreground runId); port discovery via rendezvous + challenge; one hash grammar with specified parse order (§2.2, §4.3). |
| Sol-7 | **FIXED** — §14 matrix with per-item status and arguments; #99 resolved by allowing completed resume (Sol-12); #1/#4/#9/#11/#33/#35/#67/#72/#76 carry explicit supersession arguments; #30/#28/#74/#107/#109/#119 now specified exactly. |
| Sol-8 | **FIXED** — 256 KB restated as request-body cap; RunDetail carries bounded tails + totals; events page route for history; journal feed strips oversize values; result routes bounded with raw download; JSON tree caps (§5.1, §5.4.3, §5.4.5, §5.4.6, §5.6.5, §2.6). |
| Sol-9 | **FIXED** — precedence table; per-stream comparison only; reset-before-records ordering; reopen sends fresh cursor without stale header (§5.6.2, §9.4). |
| Sol-10 | **FIXED** — phase state lives on the ALS ctx, inherited at fanout-ctx creation, identified by run-scoped `phaseIndex` (E1); one canonical path schema `{kind, ordinal, count, stages?}`; fanout `path` = container's own path (E2, §6.2); key-pin + concurrent-branch tests. |
| Sol-11 | **FIXED** — explicit `lastOutputAt` in AgentJob, advanced only by real provider output; absolute timestamp in progress events, socket status, and terminal events (E5/E6); silent-agent test. |
| Sol-12 | **FIXED** — completed-run resume allowed and labelled Replay (matching `test/engine.test.js:41–46`); POST means `launchAccepted` only; integrity wording narrowed to the pinned local graph (§1.3, §7.3). |
| Sol-13 | **FIXED** — three-concept vocabulary (invocation / execution attempt / provider turn) in §2.5; lifetime vs per-attempt usage split in `AgentView` matching `Journal.load` aggregation; E9 stays result-record-based with turns explicitly excluded. |
| Sol-14 | **FIXED** — P8 parameterized by gap size with a responsiveness requirement; P6 re-budgeted and measured via `--expose-gc` (§10). |
| Sol-15 | **PART FIXED / PART REJECTED** — fixed: single-owner rule for engine files, W1→W2→W3 sequenced, W4 waits for cli.js hand-off, vertical increments A–E each independently mergeable, retention gets its own security review. **Rejected:** cutting v1 scope — the increments make a partial landing coherent (the critique's real risk), and the parity floor plus five differentiators is the brief's stated bar, not optional ambition. |
| Sol-16 | **PART FIXED / PART REJECTED** — fixed: §3.7 normative grid/default-state/action-hierarchy spec plus a human-approved reference-comp gate that W8/W11 acceptance compares against. **Rejected as stated:** embedding annotated wireframes in this document — a text spec cannot carry them; the comp deliverable moves the visual decision before implementation, which is the finding's substance. |
| Sol-17 | **FIXED** — same as B3's fix: first-line-as-hint with frozen-journal reasoning, identity-keyed cache, recreate invalidation (§5.4.2). (The `:768–778` unreadable-workflow cite is confirmed as a second end-first path.) |

---

## 16. Operator amendments — 2026-07-30 (dependency policy for W10–W13)

Ruled by the operator mid-implementation (after W7/W8b, before W10–W13), following a
cross-model consultation on the dependency posture. These amendments SUPERSEDE the
conflicting language in §9.1, §9.7 and the §12 rows for W10/W12/W13. §16 wins where they
disagree.

**16.1 Policy replaces count.** The "exactly three runtime dependencies" rule in §9.1 is
retired as a number and replaced by policy: the published Node server stays absolutely
zero-dependency (unchanged, still CI-enforced); the private SPA may take CURATED runtime
dependencies where they solve parsing, accessibility, or browser-compatibility problems;
no dependency for trivial wrappers or flowition-specific domain logic (fold, run-state,
control semantics, tailing, cursor, router, design tokens all stay hand-rolled). Every
dependency carries a documented reason and removal cost in viewer/package.json (a
`//deps` comment block or README section), locked versions, and a bundle-budget check.

**16.2 Markdown (W10): react-markdown IS adopted** — operator ruling, overriding the
§9.7 hand-rolled parser (§9.7's output contract remains normative). Hardening is
mandatory, not advisory:

*Input limits* — **before parsing**: maximum bytes, characters, lines, and single-line
length (pre-parse limits are byte/line-domain only — markdown nesting depth cannot be
known without parsing, so it is NOT gated pre-parse). **Inside the pipeline, before
React elements are produced**: maximum AST node count, tree depth, link count,
table-cell count, and code-block size. On any violation: render bounded plaintext with
an explicit truncation/degradation marker — never throw, never freeze. A wall-clock
assertion runs the hostile corpus under a time bound.

*Renderer invariants* (the fuzz/property suite asserts ALL of these, as output
properties): only an enumerated `allowedElements` set is produced (an allowlist, so no
future plugin can widen output without failing tests); no `img`, `svg`, `iframe`,
`object`, `embed`, `form`, `meta`, `style`, or media elements; no event-handler
attributes; links restricted to `http:`/`https:` with `target="_blank"
rel="noopener noreferrer"`; images render as link chips per §9.7 (never fetched); no
network request occurs while rendering hostile markdown; **raw HTML renders as LITERAL
TEXT — never interpreted (no rehype-raw, ever), and never silently discarded**
(TIGHTENED, panel round 3: the original "literal or discarded" let an implementation
bless the drop, which §9.7 never permitted — a reader who cannot see the markup a
provider emitted cannot tell a hostile transcript from a plain one. A remark-stage
transform rewrites every mdast `html` node into a text node before hast exists, so the
markup is visible and inert; literal text is terminal — it is never fed back through
the GFM/autolink transform, so literalizing opens no interpretation path); no `dangerouslySetInnerHTML`
anywhere in the render path (the §11.3 grep also guards this). The §9.7 10k-line fuzz
corpus is RETAINED and pointed at the new renderer.

**16.3 Interactive primitives (W12): React Aria hooks ARE adopted** — hooks-level
@react-aria/* primitives (dialog, focus trap/restore, menu, tabs where used, keyboard
list navigation, palette) under the approved §3 visual system unchanged. Borrow
behavior, not appearance: no @adobe/react-spectrum, no component kit, no kit CSS. The
§3.6 requirements (focus restoration on every close path, keyboard operability) remain
the acceptance criteria; React Aria is the implementation vehicle, not a substitute for
testing them.

**CORRECTION (panel rounds 2 and 3) — the adoption does NOT rest on "these ship no CSS",
because that was not true.** The scoped packages re-export from the `react-aria`
monopackage, and that monopackage writes a `<style>` element into `document.head` from
**two** places. Round 2 found the first and asserted it was the only one; round 3 found the
second. The inventory is now stated as a closed, mechanically checkable list — every
`createElement('style')` and every `head.prepend` in `react-aria/dist`:

| # | Site | When it fires | Rule |
|---|---|---|---|
| 1 | `private/interactions/usePress.mjs:607,621` | once per document, first pressable mount, on every platform | `@layer { [data-react-aria-pressable] { touch-action: pan-x pan-y pinch-zoom } }` |
| 2 | `private/overlays/usePreventScroll.mjs:102,111` | per modal open, **iOS only** (`navigator.platform` ~ `/^iPhone|^iPad/`), removed on close | `@layer { * { overscroll-behavior: contain } }` |

Under §7.1.4's `style-src 'self'` both were `style-src-elem` violations: the policy blocked
them (fail-closed — the security property held), and the consequence was that each rule
never applied, invisibly, on the only devices it was for. Site 2 additionally explains why
round 2's evidence looked clean: `usePreventScroll` is gated on the platform, and the
Playwright suite ran Desktop Chrome only, so the code path was never executed.

The adoption stands on the narrower and true claim: **these packages render no element and
ship no stylesheet**; the two declarations they inject are small, known, and each one's
disposition is decided by whether it is ours to own. NORMATIVE resolution, and the shape
any future finding of this class must take:
1. **Site 1 is prevented.** Its rule is document-lifetime, so it can simply be ours:
   `viewer/src/ui/base.css` ships the declaration verbatim, in an anonymous `@layer` as
   react-aria had it, and `viewer/src/ui/pressableStyle.ts` claims the element id
   `usePress` checks (`react-aria-pressable-style`) with a `<meta>` marker before the first
   render, so the injection never runs at all.
2. **Site 2 is hash-allowed**, by the single `'sha256-…'` source §7.1.4 pins. It cannot be
   prevented — `usePreventScroll` has no id guard — and it must not be hoisted into
   `base.css`, because `* { overscroll-behavior: contain }` applied at all times is a
   different product than the same rule applied only while a modal is up: scroll chaining
   out of a transcript pane into the page is correct when there is no modal. Hashing keeps
   react-aria's exact modal-scoped lifecycle (added on open, `style.remove()` on close).
   The policy is **not** relaxed in the sense §7.1.4 rejects — a hash admits one byte
   string and nothing else, whereas `unsafe-inline` admits every inline stylesheet and a
   nonce admits every one the document marks. No `unsafe-inline`, no nonce (§7.1.4's
   rejection of nonces is unchanged — note `usePreventScroll` reads `getNonce()` and would
   have used one), no `unsafe-hashes` (so `style=` attributes stay blocked).
   `viewer/src/ui/preventScrollStyle.ts` holds the rule text and the digest;
   `preventScrollStyle.test.ts` mounts a real `ControlDialog` with the platform forced to
   iPhone and fails if react-aria's bytes drift from either; `test/viewer-http.test.js`
   fails if the served policy stops carrying that digest, or carries a second one.
3. `viewer/e2e/viewer.spec.ts` asserts **zero `securitypolicyviolation` and zero
   `pageerror` events on every route the suite visits**, and — round 3's addition — does so
   **on the iOS platform as well as the desktop one**. The static zero-inline assertions in
   `test/viewer-http.test.js` grep the committed dist HTML and by construction cannot see a
   policy the bundle violates at *runtime*, which is why site 1 survived every gate; a
   runtime gate that runs on one platform cannot see a platform-conditional injection,
   which is why site 2 survived the round-2 fix for site 1. The iOS describe asserts the
   *computed* `overscroll-behavior` flips to `contain` while the palette is open and back to
   `auto` when it closes — a blocked `<style>` still sits in the DOM with its text intact,
   so only the computed value distinguishes "allowed" from "blocked".

**16.4 ANSI (W10): stays hand-rolled** per §9.8 — operator ruling. The SGR subset with
incremental carry is small, spec'd, and the third-party category has a documented
supply-chain/ReDoS history. The properties that justified this ruling are NORMATIVE:
single-pass character-scan state machine; no regex over untrusted output (zero ReDoS
class, linear time by construction); bounded style-carry across chunks; OSC and
malformed sequences consumed with bounded buffering and discarded incrementally;
structured React spans as the only output (never HTML strings); unknown escape/control
sequences are STRIPPED — the sequence bytes are consumed and dropped, surrounding
printable text is preserved verbatim — and that rule is tested (decided here; W10 does
not choose).

**16.5 Browser + a11y testing (W13): Playwright + @axe-core/playwright ARE adopted as
devDependencies** of viewer/ (never shipped). The W13 suite must exercise, at minimum:
token bootstrap and URL cleanup; keyboard-only Home operation; drawer focus restoration
(the scrim path specifically — it regressed once); confirmation dialogs; cockpit tabs;
transcript virtualization; SSE reconnect; both themes; the sub-900px layout; and an axe
scan at each major UI state with ZERO automated WCAG A/AA violations — any exception
lives in a small reviewed allowlist with rationale and expiry, and the manual keyboard +
screen-reader pass remains mandatory (automated scans do not replace it). This automates the
defect class that review rounds repeatedly caught by manual browser QA.

**16.6 Unchanged invariants**, restated so no reviewer relaxes them by inference: root
package.json ships zero `dependencies`; the root suite passes without viewer/node_modules;
src/viewer/** imports only node:/relative minus the N7 denylist; viewer/dist stays
committed, shipped, and freshness-gated; the §3.6 contrast gate stays normative.

**16.7 Version discipline for security-sensitive rendering deps.** "Pinned via
lockfile" alone is insufficient: caret ranges authorize future drift whenever the
lockfile is regenerated. **Direct** dependencies — react-markdown itself and each
@react-aria package — use EXACT versions in viewer/package.json (no ^ or ~).
**Transitive** dependencies are pinned by the committed, integrity-hashed lockfile
(listing an entire ecosystem in package.json is not practical and is not required).
Dependency updates are explicit reviewed changes, each followed by the dist
rebuild-and-compare; and a package-graph test asserts forbidden packages (rehype-raw at
minimum) never enter the resolved tree.

**16.8 `flowition viewer --stop` (operator request, 2026-08-02).** The ergonomic form of
"kill the pid in viewer.json", with the property the raw kill lacks: the recorded pid is
signalled only after the §4.2.1 challenge proof has shown the recorded port is held by
our live instance — a stale record naming a recycled pid reports "no live viewer", it
never signals. Per-home like every other viewer command (§13.2/§13.7): it stops the
registered instance for the current home and nothing else; an explicit `--port N`
side-instance is stopped from its own terminal. SIGTERM only (the parity #31 clean-stop
path); success is a settled fact — process exited, rendezvous removed — not a request
receipt. `--stop` is an action, not a modifier: it refuses every other viewer flag
except `--json`. Foreground semantics of `flowition viewer` are unchanged (the operator
runs it in tmux and wants it visible and killable); no `--detach` is introduced.

**16.9 The live-session walkthrough is a local release gate (2026-08-04).** The §12.1
item-5 live session (`features/control/e2e.test.tsx`, the single marathon test driving a
real engine, a real viewer server, SSE and the shipped App through
answer→steer→cancel→resume→delete) runs in every local `npm test` as its own vitest
invocation, and self-skips on GitHub's shared runners. Four hardening rounds (worker
heap ceiling, CI-scaled wait windows, a solo invocation) ended with forensics showing
the runner executing every step correctly at 30–100× local latency — 38 s for an
answer→steer sequence that takes ~2 s locally — which no honest window survives. This
is the same standing §11/§12 already give the Playwright suite and the perf P-block:
release gates run on the reference machine, not on burst-throttled shared hardware. CI
retains the API-stubbed walkthrough, this file's smaller live-server tests, the full
root suite, and the dist byte-determinism check.



*End of DESIGN.md.*
