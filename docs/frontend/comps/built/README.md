# Built screens — W8b and W11, for the side-by-side against the approved comps

§3.7 makes W8/W11 acceptance "a side-by-side of built screens against the approved comps
**at those viewports**". The first table below is W8b's Home + run rail; the cockpit's four
compositions are photographed by the same script and are covered in **The cockpit
side-by-side (W11)**. All of them are taken at both required viewports, in both themes,
against an **attention-heavy live fixture**.

| file | what | compare against |
|---|---|---|
| `home-built-light-1440.png` | 1440 × 1000, light | `../home.html` frame 1 ("Home — attention-heavy") |
| `home-built-dark-1440.png` | 1440 × 1000, dark | same frame, dark toggle |
| `home-built-light-800.png` | 800 × 1180, light | `../home.html` frame 2 ("Home — 800px") |
| `home-built-dark-800.png` | 800 × 1180, dark | same frame, dark toggle |

`captures.json` beside them is the freshness manifest — see **Staleness is now a test
failure** below. Do not hand-edit it.

**How they were produced — `../capture-built.mjs`, committed and re-runnable.**

    node docs/frontend/comps/capture-built.mjs

Not a mock, and not a hand-written journal. The script creates a throwaway
`FLOWITION_HOME`, runs **real workflows through the real engine** on the **mock adapter**,
and produces the attention states the way an operator would:

- **the ask card** — a workflow calls `ask()` and is left unanswered, so the question text,
  the qid and the blocked-for clock are all real;
- **the stale card** — a run is `SIGKILL`ed mid-flight, and the capture then *waits for the
  server's own verdict* (`state === 'stale'`, off a dead `run.lock` past `STALE_MS`)
  rather than asserting it;
- **the over-budget spend card** — a run passes a `--budget` ceiling while an
  already-admitted agent is still working. That is the only way the state exists at all:
  `src/engine.js:981` refuses *admission* over the ceiling, so "over budget **and still
  running**" is precisely the window §2.4's "advisory, never a hard cap" describes.
  Asserted before capture: `spend.output > budgetTotal` with `state === 'running'`.

`startViewer` then serves the **committed `viewer/dist`** over loopback with the full
§7.1.4 header set, and headless Chrome loads it through the §2.2 hash-grammar token
handoff. So each capture exercises the real read API, the real static pipeline, the real
CSP and the vendored fonts — end to end.

**What differs from the comp, and why.** The comp's world is a 41-run project; the
fixture's is five runs, so the table is shorter and the "Load more" control is correctly
absent. Every **cost** cell is blank: the mock adapter reports tokens but no price, and
§2.3's "empty ≠ zero" (parity #53/#114) forbids fabricating `$0` for a number the journal
never carried — `viewer/src/format/fmt.ts#summaryCost` is where that decision lives, with
its own tests. The comp's header also carries "Stale only" and "Trash"; both are retention
(E13) affordances that land with W12, and W8b deliberately does not stub them.

## Staleness is now a test failure

These PNGs are acceptance evidence, and in round 4 they rotted without a sound: `src/`
changed the stale attention card, `viewer/dist` was rebuilt, and the committed captures
went on showing copy that no longer existed anywhere in the product. Every test stayed
green, because no test read them.

`test/comps-captures.test.js` closes that. A PNG cannot be byte-reproduced in a test —
Chrome version, font rasterization and the fixture's own clock all move it — so
`captures.json` records the **inputs** and the test recomputes them:

| pinned | why it invalidates the evidence |
|---|---|
| hash of the whole committed `viewer/dist` tree | it is literally what `startViewer` served to Chrome, so a changed bundle means these are pictures of a UI that no longer ships |
| hash of `../capture-built.mjs` | the fixture workflows, the viewports and the theme handoff are part of what the pictures show |
| hash of each PNG | a capture cannot be swapped in by hand without the manifest agreeing |

`viewer/src/dist-freshness.test.ts` separately proves the committed `dist` is what the
current source builds, so the two gates together pin these captures to the current
**source**, not merely to a bundle someone once built.

**So: after any change under `viewer/src/`, run both commands and commit both trees.**

    npm --prefix viewer run build
    node docs/frontend/comps/capture-built.mjs

(Chrome and Node ≥ 22 for the second — see the script header.)

## The cockpit side-by-side (W11)

§3.7 makes W11 acceptance "a side-by-side of built screens against the approved comps at
those viewports". The comparison itself — what matched, and every difference with its
reason — is recorded **per composition** in `../approvals.json` under `sideBySide`, and
`test/comps-captures.test.js` requires that record for every W11-built entry. The summary:

| composition | compare against | verdict |
|---|---|---|
| `cockpit-live-built-{light,dark}-1440.png` | `../cockpit.html` → "Run cockpit — Timeline (default tab, live run, budget overshoot)" | matches, with the four fixture/W12 differences listed in the ledger |
| `cockpit-live-built-{light,dark}-800.png` | `../cockpit.html` → "Run cockpit — live, at 800px" | matches annotations 14–17 |
| `cockpit-stale-built-{light,dark}-1440.png` | `../cockpit.html` → the stale frame | matches, incl. the "time of death not recorded" ruling |
| `cockpit-stale-built-{light,dark}-800.png` | `../cockpit.html` → the 800px stale frame | matches annotation 18 (resume card above the tabs, only here) |

**The live capture's world is the comp's world.** Round 1's live capture was taken against a
run that never called `ask()` and had no mail, so the shipped photograph's inbox read
"nothing open" where the approved `inboxRail()` composition carries the operator's whole
work queue. The fixture now produces that queue the way an operator would — a real `ask()`
answered through the control socket (so the answered question shows a real E7 value), a
second `ask()` left open, two `flowition post` reports (`mail dir:out`) and three steering
records (`dir:in`: the workflow's own `sendTo()` with its journalled callsite, plus two
`flowition send`s). The counts are asserted from the payload *before* the shot is taken and
from the rendered DOM *after* it, so this capture cannot silently regress to an empty screen
again.

**Two things the round-3 captures show that the comps do not draw.** (1) The stale run's
lineage segment is hatched, fixed-width and tooltipped *time of death not recorded* — it
used to be a blue bar measured through `now`, contradicting the `died` cell two rows above
it in the same photograph. (2) The live header carries §13 Q4's **show args** control,
closed: `hasArgs` puts it on screen and only a click issues the `?include=args` read, so a
capture that showed the value would be evidence of a leak rather than of the feature. Both
are recorded per composition in `../approvals.json` under `sideBySide.differences`, and both
are asserted from the capture manifest by `test/comps-captures.test.js` — the strip's class,
its measured 44px width and its tooltip, and the disclosure's label with the panel closed.

**The differences that remain, and why they are differences.** The open question shows
W11's slot note instead of the comp's answer composer — §12 gives W12 "inbox rail,
composers" and §7.2 the control bridge they post through; a disabled input that cannot send
is worse than a sentence saying where the control is. Every steer reads `queued` and the two
operator steers say "no callsite journalled": both are facts of the fixture (the mock
sleeper takes steers as queued follow-up turns; only a workflow `sendTo()` carries a source
position at all, RECON-flowition §1.4). The three judges are `ECHO` agents that finish in
milliseconds, so their bars are marks rather than the comp's wide bands, and cost reads
"not journalled" because the mock adapter prices nothing (§2.3's "empty ≠ zero").

## Approval status

**Do not hand-edit the block below.** It is generated from `../approvals.json` — the ledger
§3.7's gate is read out of — by

    node docs/frontend/comps/approvals-summary.mjs

and `test/comps-captures.test.js` fails if it drifts from the ledger. It is generated
because W11's review round 3 caught this section still saying the gate was unpassed and the
cockpit screens did not exist, three sections after this same file described the cockpit
side-by-side against them: two hand-written summaries of one machine-readable fact, one of
which had rotted when the operator's rulings landed.

<!-- approvals:begin — generated by approvals-summary.mjs; edit approvals.json -->
**The §3.7 entry gate is PASSED: 8 of 8 compositions are approved** (four canonical states × two
viewports). `approvals.json` is the authority — its `entryGate` field carries the full
ruling and each entry carries its own `decidedBy`/`decidedIn`.

| composition | status | ruled by | built captures |
|---|---|---|---|
| `home-1440` | approved | Ben Vargas (operator) | 2 committed (W8) |
| `cockpit-live-1440` | approved | human reviewer | 2 committed (W11) |
| `cockpit-stale-1440` | approved | human reviewer | 2 committed (W11) |
| `transcript-compare-1440` | approved | Ben Vargas (operator) | not built yet |
| `home-800` | approved | Ben Vargas (operator) | 2 committed (W8) |
| `cockpit-live-800` | approved | Ben Vargas (operator) | 2 committed (W11) |
| `cockpit-stale-800` | approved | Ben Vargas (operator) | 2 committed (W11) |
| `transcript-compare-800` | approved | Ben Vargas (operator) | not built yet |

Approving a composition is a human act by construction — it means editing its entry in
`approvals.json`. `test/comps-captures.test.js` checks that `entryGate` agrees with the
entries, that every entry with built captures carries a `sideBySide` record, and that
this block still matches what the ledger says.
<!-- approvals:end -->

The test enforces that the ledger is complete and honest — every state × viewport §3.7
names has an entry, every approval is attributable, every `pending` states what is to be
ruled on and how — and deliberately does **not** assert that anything is approved. A test
that could manufacture approval would turn §3.7's human gate into a formality; neither can
the generator, which only restates the `status`, `decidedBy` and `builtCaptures` already
recorded.
