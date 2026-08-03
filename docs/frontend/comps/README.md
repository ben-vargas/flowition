# W8a — reference comps for the human design gate

DESIGN §3.7 makes human approval of reference comps the **entry gate for W8**: no viewer
UI code is written until these are signed off. This directory is that deliverable.

Open the files directly in a browser — `file://` is fine. No server, no build step, no
network request of any kind.

```
docs/frontend/comps/
  tokens.html        the design system made visible
  home.html          §2.3 — attention strip + run table
  cockpit.html       §2.4 — run rail, header, budget gauge, Timeline / Structure / Agents
  transcript.html    §2.5 — every transcript row type, the steer composer, attempts
  generate.mjs       regenerates all four; FAILS if any token pair misses its §3.6 ratio
  capture-built.mjs  photographs the BUILT Home for §3.7's side-by-side (W8b)
  approvals.json     the reviewer's ledger — which compositions have been ruled on
  approve.mjs        records a ruling: `approve.mjs <id…> --by "<name>" --in "<where>"`
  built/             those photographs, plus the freshness manifest that dates them
  lib/               token definitions, OKLCH↔sRGB + contrast math, CSS, icon sprite, fixtures
  lib/type-scale.mjs the §3.1 scale validator, shared by the product and comp gates
```

**The approval gate is `approvals.json`, not prose.** All eight of §3.7's compositions —
four canonical states × two required viewports — appear there, each `approved` (with who
ruled and where) or `pending` (with what is to be ruled on and how). There is no third
status: an earlier revision had a `deferred` state that let three compositions be recorded
as somebody else's problem, and the "somebody else" was an invented unit. Both are gone.

`test/comps-captures.test.js` enforces that every state × viewport has an entry, that each
entry's `frame` is a caption that **actually appears** in the named comp file (so a ledger
row cannot stand in for a drawing nobody made), that `owner` is a real unit from DESIGN
§12's plan, that the built captures under `built/` still depict the committed `viewer/dist`,
and that the ledger's `entryGate` field states the true tally of outstanding rulings. W8c
added two more: the compare frames must render two whole panels, with a distinct agent read
from *each pane's own header*, **on the axis §2.5 specifies for their viewport** — side by
side at ≥900px, a stacked pair below the 900px breakpoint — and no comp may **draw** a death
time for a stale run, since §6.2 supplies none. The layout expectation is itself checked
against DESIGN §2.5, so the comps cannot drift ahead of the spec by editing one line of the
test. `test/comps-type-scale.test.js` holds the comp stylesheet to §3.1's scale with the
same validator the product gate uses.

It does not, and must not, assert that anything is approved: that is the human reviewer's
act, and a test that synthesized it would turn the gate into a formality.

**Gate status as committed: PASSED — all 8 compositions approved.** The operator (Ben
Vargas) ruled on the outstanding six via the flowition ask/answer channel, recorded with
`approve.mjs`; the two 1440 cockpit entries carry W8a's original sign-off. Run
`node docs/frontend/comps/approve.mjs --list` for the per-entry tally.

One ruling changed a drawing: the 800px compare is **VARIANT B, the stacked pair**, and
DESIGN §2.5 is amended to match (see below). The other five were approved as drawn.

Two entries had gone BACKWARDS, from approved to pending, before the ruling; both were
deliberate, and both are now approved as re-drawn.

`transcript-compare-1440` (round 6): W8a's ruling approved it *with a stated deviation* —
the compare was shown as the docked `?a=3` affordance rather than a rendered second panel.
Review round 3 rejected the deviation — §2.5 says "**Up to two panels side-by-side**" and
one pane plus a button is the state *before* a comparison. The deviation is withdrawn and
the composition is now actually drawn, at both viewports.

`home-1440` (W8c): W8a approved a stale attention card reading "Engine died 26m ago" with a
21m18s runtime beside it. **Neither number exists.** `endedAt` is written from a terminal
`run` event and from nothing else (§6.2, `src/viewer/summaries.js:115-118`), and a run is
`stale` precisely because the engine went away without writing one; substituting `startedAt`
turns the run's AGE into a claim about when it died, and makes the runtime tick upward
forever. The shipped Home already gets this right — `AttentionStrip.tsx`: *"It wrote no
terminal event, so there is no time of death to report"* — so the **approved comp
contradicted its own committed built captures**, which are the §3.7 side-by-side evidence
for that very entry. The same fabrication, sourced from the `run.lock` mtime, was in the
800px stale cockpit; `run.lock` is written when the engine *acquires* the run, so its mtime
dates the start, and W6 exposes no death time at all. Both are corrected, and
`test/comps-captures.test.js` now fails if any comp *draws* a death time again (the
annotations may still describe the withdrawn claim — that history is the evidence).

A ruling on an old composition cannot carry over to a different one, so both were pending
again rather than silently inheriting an approval they did not receive. The operator has
since ruled on both re-drawn compositions, explicitly affirming that the
no-fabricated-death-time rule is binding.

## How to read them

Every file has a dashed **comp chrome** bar at the top (mono voice, dotted rules — that is
annotation, not product) carrying the filename, the DESIGN sections it realizes, and a
**light / dark** toggle. Every screen file ends with a numbered **annotation list**; the
matching numbers are placed as small accent circles on the comp itself. The annotations are
where the design argument lives — read them, they name what I want ruled on.

Fixture data is one consistent fictional world across all three screens: the run
`judge-panel-auth-refactor` (`r_2f91c4a8`), 10 agents, `--concurrency 2`, 110.3% of its
soft budget ceiling, resumed once, with one open `ask()`.

### What each file shows

| File | Screens / states | DESIGN sections realized |
|---|---|---|
| `tokens.html` | Type scale with real specimens · the neutral anchor ramp · all 9 state colors with their glyphs and chips · unknown + orphaned · 8 adapter monograms · terminal well with the full 16-color ANSI palette · spacing scale, row heights, elevation, radii, button hierarchy · 43-glyph icon sprite · motion table + easing curve · the full computed contrast table | §3.1, §3.2, §3.3, §3.4, §3.5, §3.6 |
| `home.html` | Attention-heavy Home at 1440×880 (live run with a spend ticker and overshoot gauge, run blocked on an `ask()` with inline answering, stale run offering Resume) · 8-row run table with 2 live / 1 blocked / 1 stale / 1 failed / 3 completed · **plus** the loading-skeleton, API-unreachable, and zero-runs states | §2.3, §3.2, §3.7 |
| `cockpit.html` | Four full cockpit frames: **Timeline** (default tab — Gantt with hatched queue-wait, progress notches, quiet tag, saturation strip), **Structure** (the DAG: `parallel(3)` fan + `pipeline(5 × 2)` grid), **Agents** (13-column flat table sorted by cost, log lane open), **Agents / Phases** (the §2.4.1 phase tree with the manual-override marker) · **plus** the pre-E1 degraded run, the loading skeleton, the zero-agent empty state and the stale/orphaned resume card | §2.4, §2.4.1, §2.4.2, §3.7, §6.5 |
| `transcript.html` | The transcript as a 55/45 split beside the cockpit with both rails collapsed · **plus** the same panel unrolled at its true 607px width showing all 13 row types (prompt block, attempt marker, reasoning with preview, collapsed step group, id-paired tool card, terminal well with ANSI and a real exit code, 4-action file-change card with `+N −M` and a "no diff available" row, error-tinted tool result, steer marker with delivery verdict, status line, clamped long tool header, collapsed raw group, markdown answer) · **plus** the queued-agent disabled composer, the failed-agent error card, and the dead-run / old-run notes | §2.5, §2.5.1, §3.3, §3.7, §9.7, §9.8 |

## Deviations from §3

Nine. Seven are contrast fixes the spec's own §3.6 requires; two are corrections to the
spec text.

### D1 — `color-mix()` interpolates in **oklab**, not **oklch** (spec correction)

§3.2 writes `color-mix(in oklch, var(--ink) N%, var(--canvas))`. **That formula produces
the wrong colors in the light theme.** OKLCH interpolates hue along an arc, and the light
theme's anchors are 160° apart (`--canvas` H=95 warm paper, `--ink`/`--accent` H=255 blue).
So the spec's own `--surface-selected` — `color-mix(in oklch, var(--accent) 10%, var(--canvas))`
— lands on H=111 and paints **`#e9eadc`, a pale green**. In OKLab the same mix is `#e1e8ef`,
the intended cool tint. The neutral ramp is affected too, less visibly (hairlines drift
green at C≈0.005).

Every `color-mix()` in these comps uses `in oklab`. The anchor technique, which is the
valuable part, is unchanged and still live in the CSS: move `--canvas` and every surface
follows. **Recommend §3.2 be amended.**

### D2 — light-theme `--accent` L 0.55 → **0.50**

At 0.55 it is 3.97:1 on `--surface-raised` — below 4.5:1 for link text and for the
`--on-accent` fill pairing. 0.50 gives 4.92:1 as text and 5.65:1 for the primary button.
Hue and chroma unchanged. Dark theme untouched.

### D3 — six light-theme status colors darkened

§3.2 claims "the token table above was chosen to pass". In the light theme it does not: as
label text on `--surface`, five of six saturated states fail 4.5:1 and `stale` fails badly.
Hue and chroma are unchanged in every case; only L moved.

| token | §3.2 L | fixed L | was (on `--surface`) | now |
|---|---|---|---|---|
| `--st-running` | 0.58 | **0.50** | 3.73 | 5.16 |
| `--st-done` | 0.58 | **0.49** | 3.50 | 5.08 |
| `--st-cached` | 0.60 | **0.48** | 3.22 | 5.16 |
| `--st-failed` | 0.55 | **0.52** | 4.68 (4.37 on raised) | 5.32 |
| `--st-stale` | 0.66 | **0.50** | 2.77 | 5.32 |
| `--st-blocked` / `--st-steered` | 0.56 | **0.52** | 4.37 | 5.18 |

The **dark theme is §3.2 verbatim** — all six pass comfortably there (5.37–8.34).

### D4 — `queued` and `cancelled` are ink-ramp steps, not ink 45/50/55%

§3.2 gives `queued` ink 45% (light) / 55% (dark) and `cancelled` ink 50% / 55%. As *label
text* those are 2.83 and 3.29 (light) and 4.17 (dark) — all below 4.5:1. They are now
`--text-3` (ink 62%) and `--text-2` (ink 74%) respectively, in both themes: 5.20 and 7.71.
The two states remain distinguishable, by **glyph** (dashed circle vs. slashed circle) and
by weight, which §3.6 requires anyway — state must never be carried by color alone.

### D5 — six light-theme adapter hues darkened

As a 9px/600 monogram on its own 14% badge tint, every light adapter hue failed; `amp` was
2.39:1. Hue and chroma unchanged.

| adapter | §3.2 L | fixed L | was | now |
|---|---|---|---|---|
| claude | 0.62 | **0.50** | 3.08 | 4.82 |
| codex | 0.60 | **0.47** | 3.04 | 4.81 |
| amp | 0.68 | **0.49** | 2.39 | 4.78 |
| droid | 0.64 | **0.47** | 2.62 | 4.94 |
| opencode | 0.58 | **0.50** | 3.54 | 4.80 |
| pi | 0.60 | **0.50** | 3.36 | 4.88 |

Dark adapter hues are §3.2 verbatim.

### D6 — `mock` / `unknown` adapters use the `--text-3` step, not ink 40%

Ink 40% as 9px text on its tint is 2.6:1. `--text-3` (ink 62%) gives 4.56. Still neutral,
still visibly quieter than the six real hues.

### D7 — three tokens added that §3.2 does not define

The spec's table has no text-hierarchy tokens and no control-edge token, but a dense
instrument needs them and they must be gated too.

- `--text-2` = ink 74% — meta rows, secondary cells (7.19 on `--surface-raised`)
- `--text-3` = ink 62% — micro labels, absent-value dashes, queue hatch (4.85). **Still AA
  text**, deliberately: a "quiet" label that fails contrast is not quiet, it is broken.
- `--border` = ink 52% light / 46% dark — input and control edges, ≥3:1 per WCAG 1.4.11
  (3.77 / 3.27 on `--surface`). `--hairline` at ink 12/14% is ~1.2:1 and is used **only**
  for decorative structure, never as a control edge.

### D8 — ANSI 8 (bright black) raised to L 0.62; ANSI 0 (black) is the one contrast exemption

Bright black is conventionally dim *text*, so it is gated: at L 0.56 it was 3.97 on the
well, now 5.07 at L 0.62. ANSI 0 is 1.57 and **exempt with a stated reason** — it is a
background/rule color, never body text, and §9.8 already forces a legible foreground
whenever a tool applies it as a background via SGR 48. Every other ANSI slot passes 4.5:1
against the well (5.93–17.43). The well itself is §3.2 verbatim and identical in both
themes.

### D9 — the icon sprite is 43 glyphs, not "~24"

§3.5 estimates ~24 and names 21 specifically. The real count is 43, all hand-authored on
the 16px grid at 1.5px stroke, no icon library. The extra 19 are load-bearing, not
decoration:

- **11 status marks, not 9** — the nine §3.2 states plus `unknown` (parity #56 requires a
  neutral info circle that is *not* a success check) and `orphaned` (§6.4 step 8 / parity
  #58 requires a distinct mark for an agent stranded in a dead run).
- **4 file-action glyphs** — created / edited / deleted / renamed, required by §2.5.1 #79.
- **`chevdown` as its own symbol** — a rotated `chevron` would inherit the disclosure
  transition and animate when it should not.
- **`terminal`, `tool`, `reasoning`, `clock`, `drag`, `bolt`** — transcript card headers,
  the wait column, resize handles, and the budget badge.

If §3.5's "~24" is meant as a budget rather than an estimate, say so and I will fold the
four file-action glyphs into one and drop `clock`/`bolt`.

### Not a deviation — the 10px tier is gone, and so are seven 9px comp labels (rounds 6 / W8c)

§3.1 fixes the scale at 11 / 12 / 13 / 14 / 16 / 20 / 24, and §3.2 adds one sub-scale size:
the 9px adapter monogram. Two separate drifts below that floor have now been removed.

**Round 6, in the product:** an earlier revision of the shipped stylesheet defined a **10px
micro label** in `viewer/src/ui/base.css` and hard-coded it another nineteen times across
`home.css`, `shell.css` and `primitives.css`. Nothing above approved it — none of D1–D9 is a
typography change — so it was drift, not a decision, and it was removed rather than
retro-approved: every one of those labels reads `var(--fs-micro)` (11px).

**W8c, in the comps:** the gate written for that fix scanned `viewer/src` only, and this
directory's own stylesheet still carried **seven non-monogram 9px declarations** —
`.lastlog .src`, the saturation strip's `ceiling` / `pin-band` / `queue depth` labels, the
Gantt's `now` label, the phase tree's `toggled` marker, and the log lane's source label.
All seven now read `var(--fs-micro)`. Three rules moved with them: the log lane's source
column widened 62 → 76px to hold "WORKFLOW" at the larger size, the saturation rail grew
12 → 16px, and the queue-depth counter took a canvas chip so hatched strokes no longer read
through it.

That mattered more than a typography nit. §3.7 makes these comps the thing W11 builds
against, so a floor the product obeys and the reference drawings do not is a contract
disagreeing with itself. **The validator is now one module** —
`lib/type-scale.mjs`, the approved set, the `.ad` exemption and the two declaration
spellings in one place — imported by `viewer/src/ui/type-scale.test.ts` (which points it at
`viewer/src`) and by `test/comps-type-scale.test.js` (which points it at
`docs/frontend/comps/lib`, source rather than emitted HTML, so inline `style="font-size:…"`
attributes in the page modules are caught too). A tenth tier now needs a §3.1 amendment
*and* an edit to that module, which is what keeps the two stylesheets on one scale.

These edits touch approved frames and do **not** re-open their rulings: approving a comp
cannot license a violation of §3.1, so restoring conformance restores what was approved.
`approvals.json`'s `conformanceEdits` field says the same thing where a reviewer will see it.

### The 800px viewport — §3.7's second required set

§3.7 asks for all four canonical states at 1440 **and** 800. W8a comped 1440 only (its
brief fixed the viewport). **W8b round 5 closes the gap completely** — all four 800px
compositions now exist, and all of them are W8's, because §3.7 assigns the reference comps
to the W8 lane and DESIGN's delivery plan has no other lane to assign them to:

| frame | file | annotations | the decision it makes |
|---|---|---|---|
| Home — 800px | `home.html` | 8–10 | rail as a 44px icon strip (parity #42); stacked attention queue; adapter + output-token columns dropped to buy back the name column |
| Run cockpit — live, at 800px | `cockpit.html` | 14–17 | both rails as 44px drawer handles; header wraps to four rows with the gauge given its own; Gantt at label 170 / track 350 recomputed from the same fixture times; all three tabs kept inline |
| Run cockpit — failed / stale, at 800px | `cockpit.html` | 18–19 | the resume card promoted above the tabs — the one place the narrow layout reorders rather than reflows; orphaned agents dimmed, bars stopping at the last event |
| Two-panel compare at 800px | `transcript.html` | 11–13, 17 | the two panels are **stacked**, per the operator's ruling and the §2.5 amendment it carried: both panes keep the full 712px, so a row renders identically in both, and the pair scrolls sequentially with a 2px seam between them. The side-by-side drawing is retained as **ALTERNATIVE A** in the next frame (annotations 18–19) — considered, not chosen |
| Two-panel compare at 1440px | `transcript.html` | 14–16 | both rails collapse to strips on entering the compare, giving each panel 674px; one bar carries the pair's identity, Swap and the single Close, while each panel keeps only its own controls; the second panel is a FULL panel, footer included |

Home is the only one of the four whose screen is built, so it is the only one carrying
built-vs-approved captures (`built/home-built-{light,dark}-800.png`). The cockpit and
transcript are built by W11 and W10; §3.7's side-by-side for those compositions belongs to
those units' acceptance. The **ruling** on all four is W8's gate, and it has been given —
see `approvals.json`'s `entryGate`.

**The 800px compare was redrawn a third time in W8c, and that one was a choice, not a fix —
so it was put to the operator, and they chose.** Round 5 drew a tablist (a switcher —
correctly rejected). Round 6 drew a vertical stack and argued side-by-side was
arithmetically impossible at 800px. The argument is real — halving 712px leaves each pane
~355px against the 607px the row types were designed at, so the *same* row wraps differently
on the two sides — but the conclusion amends a normative sentence, and an implementation
lane cannot amend §2.5. So W8c drew both and put the choice on the gate list: (A) the
specified side-by-side pair with its costs visible, (B) the stacked pair plus a §2.5
amendment.

**The operator ruled for (B).** DESIGN §2.5 now carries a marked operator amendment:
side-by-side stays normative at ≥900px, and below §3.3's single 900px breakpoint the
two-panel compare renders as a stacked pair (full-width panels, sequential scroll). The
stacked drawing is the composition this ledger names; the side-by-side drawing stays in the
file as ALTERNATIVE A, because a ruling is only legible beside what it rejected — and
because the 340px per-pane minimum it demonstrates is still what the ≥900px composition uses
when a window is dragged toward the breakpoint. `test/comps-captures.test.js` asserts the
*layout per viewport* now, not just the pane count, checks the stylesheet makes each layout
real, checks the amendment is in DESIGN rather than only in the comps, and reads each pane's
agent identity from that pane rather than from the shared compare bar — the old check would
have passed two copies of one panel, because the bar names both agents by itself.

### 480px and the drawer — the rest of §3.3, drawn (W8c)

§3.7 requires 1440 and 800 and nothing else, so these five frames carry no ledger entry.
They exist because §3.3's rule — *"below 900px the cockpit rails collapse into drawers and
the transcript replaces the cockpit"* — has an open state and a floor that nobody had drawn,
and W11/W10 would otherwise have had to invent both.

| frame | file | annotations | what it settles |
|---|---|---|---|
| run rail OPEN as a drawer | `cockpit.html` | 20–22 | the scrim is a real click-to-dismiss element at ink 42%, not a tint on the panel; the top bar stays uncovered; **focus moves to the drawer header** on open (not the first row — a roving list that grabs focus makes the first run look selected); **Escape closes and restores focus to the 44px handle**; Tab is trapped while the scrim is up (`role=dialog aria-modal`); `prefers-reduced-motion` drops the slide and keeps the scrim |
| cockpit at 480px | `cockpit.html` | 23–25 | header metrics wrap two per line; the tab row scrolls and no tab goes into an overflow menu; **the Gantt is neither dropped nor rescaled — ruler, saturation strip and lanes scroll together** on one axis, because a track that rescales per viewport makes two screenshots of the same run uncomparable; **the saturation strip keeps full height** (it is the tab's whole argument, Q5) |
| Home at 480px | `home.html` | 12 | the run table stops being a table: one wrapped two-line record per run, header row dropped, the columns dropped at 800 stay dropped |
| transcript replaces the cockpit, 800 and 480 | `transcript.html` | 20–22 | the back affordance **names the run** it returns to rather than saying "back", and the agent stepper ("6 of 10", `j`/`k`) sits on that bar so stepping a judge panel is not ten round trips |

**There is exactly one breakpoint: 900px, per §3.3.** The 480 frames run identical rules with
less room; nothing in this set introduces a second threshold. Both themes are live in every
frame via the light/dark toggle in the comp chrome.

**Two-panel transcript compare at 1440 — DEVIATION WITHDRAWN (round 6).** The previous
revision showed this state as the docked `?a=3` affordance rather than a rendered second
panel, arguing that two panels beside a visible cockpit would be ~300px each. The argument
was sound; the conclusion was not. What follows from it is that the compare **replaces** the
cockpit rather than sitting beside it: collapse both rails and the two panels get 674px
each, over the 607px the row types were designed at. `transcript.html` now carries a real
`Two-panel compare at 1440px` frame (annotations 14–16), and the frame that shows the
affordance is labelled as what it is — the state before the comparison.

## Contrast check — §3.6

Computed by `lib/color.mjs` (OKLCH → gamut-clipped sRGB → WCAG 2.2 relative luminance) at
generate time; the numbers rendered in `tokens.html` are the same values, not transcribed.
`generate.mjs` **exits non-zero** if any gated pair misses its threshold, so a failing
swatch cannot be committed.

**71 pairs · both themes · 0 failing · 1 stated exemption (ANSI 0, see D8).**

| pair (fg on bg) | requirement | light | dark | verdict |
|---|---|---|---|---|
| `--text on --canvas` | text ≥ 4.5:1 | 16.48 | 15.68 | pass |
| `--text on --surface` | text ≥ 4.5:1 | 15.40 | 14.86 | pass |
| `--text on --surface-raised` | text ≥ 4.5:1 | 14.38 | 14.14 | pass |
| `--text on --surface-selected` | text ≥ 4.5:1 | 14.32 | 13.29 | pass |
| `--text-2 on --surface` | text ≥ 4.5:1 | 7.71 | 7.67 | pass |
| `--text-2 on --surface-raised` | text ≥ 4.5:1 | 7.19 | 7.29 | pass |
| `--text-3 on --canvas` | text ≥ 4.5:1 | 5.56 | 5.72 | pass |
| `--text-3 on --surface-raised` | text ≥ 4.5:1 | 4.85 | 5.15 | pass |
| `--accent link on --canvas` | text ≥ 4.5:1 | 5.65 | 7.76 | pass |
| `--accent link on --surface-raised` | text ≥ 4.5:1 | 4.92 | 7.00 | pass |
| `--on-accent on --accent (primary button)` | text ≥ 4.5:1 | 5.65 | 7.76 | pass |
| `--accent focus ring on --canvas` | UI ≥ 3:1 | 5.65 | 7.76 | pass |
| `--accent focus ring on --surface-raised` | UI ≥ 3:1 | 4.92 | 7.00 | pass |
| `--border (input edge) on --surface` | UI ≥ 3:1 | 3.77 | 3.27 | pass |
| `--border (input edge) on --canvas` | UI ≥ 3:1 | 4.03 | 3.45 | pass |
| `--st-queued label on --surface` | text ≥ 4.5:1 | 5.20 | 5.42 | pass |
| `--st-running label on --surface` | text ≥ 4.5:1 | 5.16 | 6.87 | pass |
| `--st-done label on --surface` | text ≥ 4.5:1 | 5.08 | 7.21 | pass |
| `--st-cached label on --surface` | text ≥ 4.5:1 | 5.16 | 7.69 | pass |
| `--st-failed label on --surface` | text ≥ 4.5:1 | 5.32 | 5.37 | pass |
| `--st-cancelled label on --surface` | text ≥ 4.5:1 | 7.71 | 7.67 | pass |
| `--st-stale label on --surface` | text ≥ 4.5:1 | 5.32 | 8.34 | pass |
| `--st-blocked label on --surface` | text ≥ 4.5:1 | 5.18 | 6.47 | pass |
| `--st-steered label on --surface` | text ≥ 4.5:1 | 5.18 | 6.47 | pass |
| `--st-queued label on --st-queued-tint (chip)` | text ≥ 4.5:1 | 4.69 | 4.87 | pass |
| `--st-running label on --st-running-tint (chip)` | text ≥ 4.5:1 | 4.67 | 6.00 | pass |
| `--st-done label on --st-done-tint (chip)` | text ≥ 4.5:1 | 4.59 | 6.26 | pass |
| `--st-cached label on --st-cached-tint (chip)` | text ≥ 4.5:1 | 4.64 | 6.63 | pass |
| `--st-failed label on --st-failed-tint (chip)` | text ≥ 4.5:1 | 4.80 | 4.83 | pass |
| `--st-cancelled label on --st-cancelled-tint (chip)` | text ≥ 4.5:1 | 6.72 | 6.61 | pass |
| `--st-stale label on --st-stale-tint (chip)` | text ≥ 4.5:1 | 4.79 | 7.10 | pass |
| `--st-blocked label on --st-blocked-tint (chip)` | text ≥ 4.5:1 | 4.69 | 5.70 | pass |
| `--st-steered label on --st-steered-tint (chip)` | text ≥ 4.5:1 | 4.69 | 5.70 | pass |
| `--st-queued glyph stroke on --canvas` | UI ≥ 3:1 | 5.56 | 5.72 | pass |
| `--st-running glyph stroke on --canvas` | UI ≥ 3:1 | 5.53 | 7.24 | pass |
| `--st-done glyph stroke on --canvas` | UI ≥ 3:1 | 5.44 | 7.61 | pass |
| `--st-cached glyph stroke on --canvas` | UI ≥ 3:1 | 5.52 | 8.12 | pass |
| `--st-failed glyph stroke on --canvas` | UI ≥ 3:1 | 5.69 | 5.67 | pass |
| `--st-cancelled glyph stroke on --canvas` | UI ≥ 3:1 | 8.25 | 8.09 | pass |
| `--st-stale glyph stroke on --canvas` | UI ≥ 3:1 | 5.69 | 8.80 | pass |
| `--st-blocked glyph stroke on --canvas` | UI ≥ 3:1 | 5.55 | 6.83 | pass |
| `--st-steered glyph stroke on --canvas` | UI ≥ 3:1 | 5.55 | 6.83 | pass |
| `adapter claude monogram on --ad-claude-tint` | text ≥ 4.5:1 | 4.82 | 6.13 | pass |
| `adapter codex monogram on --ad-codex-tint` | text ≥ 4.5:1 | 4.81 | 6.54 | pass |
| `adapter amp monogram on --ad-amp-tint` | text ≥ 4.5:1 | 4.78 | 7.64 | pass |
| `adapter droid monogram on --ad-droid-tint` | text ≥ 4.5:1 | 4.94 | 7.00 | pass |
| `adapter opencode monogram on --ad-opencode-tint` | text ≥ 4.5:1 | 4.80 | 5.78 | pass |
| `adapter pi monogram on --ad-pi-tint` | text ≥ 4.5:1 | 4.88 | 6.06 | pass |
| `adapter mock monogram on --ad-mock-tint` | text ≥ 4.5:1 | 4.56 | 4.87 | pass |
| `adapter unknown monogram on --ad-unknown-tint` | text ≥ 4.5:1 | 4.56 | 4.87 | pass |
| `budget gauge fill (--accent) on track (--hairline)` | UI ≥ 3:1 | 4.27 | 6.03 | pass |
| `gauge overshoot hatch (--st-failed) on track` | UI ≥ 3:1 | 4.31 | 4.40 | pass |
| `gantt queue-wait hatch (--text-3) on lane (--surface)` | UI ≥ 3:1 | 5.20 | 5.42 | pass |
| `saturation strip fill (--accent) on --surface` | UI ≥ 3:1 | 5.28 | 7.36 | pass |
| `well default text on --well` | text ≥ 4.5:1 | 13.70 | 13.70 | pass |
| `ANSI 0 black on --well` | decorative | 1.57 | 1.57 | exempt (D8) |
| `ANSI 1 red on --well` | text ≥ 4.5:1 | 5.93 | 5.93 | pass |
| `ANSI 2 green on --well` | text ≥ 4.5:1 | 9.08 | 9.08 | pass |
| `ANSI 3 yellow on --well` | text ≥ 4.5:1 | 11.28 | 11.28 | pass |
| `ANSI 4 blue on --well` | text ≥ 4.5:1 | 7.44 | 7.44 | pass |
| `ANSI 5 magenta on --well` | text ≥ 4.5:1 | 6.99 | 6.99 | pass |
| `ANSI 6 cyan on --well` | text ≥ 4.5:1 | 10.27 | 10.27 | pass |
| `ANSI 7 white on --well` | text ≥ 4.5:1 | 13.70 | 13.70 | pass |
| `ANSI 8 bright black on --well` | text ≥ 4.5:1 | 5.07 | 5.07 | pass |
| `ANSI 9 bright red on --well` | text ≥ 4.5:1 | 7.77 | 7.77 | pass |
| `ANSI 10 bright green on --well` | text ≥ 4.5:1 | 12.25 | 12.25 | pass |
| `ANSI 11 bright yellow on --well` | text ≥ 4.5:1 | 13.71 | 13.71 | pass |
| `ANSI 12 bright blue on --well` | text ≥ 4.5:1 | 9.84 | 9.84 | pass |
| `ANSI 13 bright magenta on --well` | text ≥ 4.5:1 | 9.41 | 9.41 | pass |
| `ANSI 14 bright cyan on --well` | text ≥ 4.5:1 | 13.28 | 13.28 | pass |
| `ANSI 15 bright white on --well` | text ≥ 4.5:1 | 17.43 | 17.43 | pass |

Ratios are computed against the **gamut-clipped** sRGB a browser actually paints, not
against the nominal OKLCH triple, so an out-of-gamut token cannot pass on paper and fail on
screen.

## Two things these comps deliberately are not

**Fonts are not loaded.** No `<link>`, no `@font-face`, no `url()`, no absolute URL — and
`generate.mjs` enforces all of that with a self-containment guard on the emitted HTML.
The stacks name `"IBM Plex Sans"` and `"JetBrains Mono"` first and fall back to the system
UI and mono faces, so the files render identically offline and on a machine with the
vendored faces installed. Judge **layout, hierarchy, density and color**; the real faces
shift metrics by 1–2% and change nothing structural. (The shipped viewer self-hosts them,
≤300 KB woff2 subset, zero third-party requests — §3.1, parity #115.)

**They are comps, not a prototype.** No data fetching, no routing, no state. The only
script in any file is the theme toggle: one attribute swap on `<html>`. The shipped viewer
does this with the external, render-blocking `/boot-theme.js` instead (§9.9) because its
CSP forbids inline script — **do not copy the comps' inline handler into the app.**

## Regenerating

```
node docs/frontend/comps/generate.mjs
```

Exits 1 with a per-pair report if the §3.6 gate fails, and throws if any emitted file
contains an external reference. `lib/color.mjs` and the `PAIRS` table in `lib/tokens.mjs`
are the seed for §3.6's "automated check of every (fg, bg) token pair in both themes" —
W8 should lift them into `test/` rather than reimplement the math.
