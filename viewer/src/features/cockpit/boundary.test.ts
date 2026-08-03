// The structural half of the honesty class fix (review round 6).
//
// `honesty.test.tsx` proves the rule holds on every screen this build renders. This file
// proves the SIXTH SITE cannot be written: liveness is derived in exactly one module, and no
// cockpit component reads a wall clock.
//
// Why a source grep rather than a behavioural test: the defect class is "a widget answered
// the liveness question for itself", and a behavioural suite can only catch the widgets that
// exist today. Five rounds of review demonstrated that fixing the widgets that exist is not
// the same as fixing the rule — each round's fix was correct and the next round found the
// same principle broken somewhere new. The boundary is what makes the next widget honest by
// construction: to claim motion at all it has to ask `honesty.ts`, and `honesty.ts` answers
// from the authoritative run state.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** The one module allowed to classify a run state, and this file, which names the rule. */
const OWNER = 'honesty.ts'
const SELF = 'boundary.test.ts'

/** Product source under `features/cockpit/` — tests are the observers, not the subject. */
const sources = (): string[] =>
  readdirSync(HERE)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f))
    .filter((f) => f !== OWNER && f !== SELF)

const read = (file: string) => readFileSync(join(HERE, file), 'utf8')

/**
 * The file with its comments removed.
 *
 * Every rule below is about what the code DOES, and these modules explain themselves at
 * length — the note above `gantt.ts`'s `execEnd` says the word `runIsLive` in order to say
 * that it must not be called. A grep that cannot tell the prohibition from the violation
 * would push the explanations out of the source, which is the opposite of what this
 * codebase is for.
 */
const code = (file: string): string =>
  read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

describe('the liveness boundary (§6.4 step 8, parity #46/#58)', () => {
  it('has files to police — a boundary over an empty set proves nothing', () => {
    expect(sources().length).toBeGreaterThan(8)
    expect(sources()).toContain('AgentsTab.tsx')
    expect(sources()).toContain('RunHeader.tsx')
    expect(sources()).toContain('gantt.ts')
  })

  /**
   * `runIsLive`/`runIsDead`/`terminalOrStale` are the fold's own predicates. Every one of
   * the five reviewed defects began with a component importing one of them (or, worse,
   * writing `state === 'stale'` by hand) and reaching a verdict of its own. There is now one
   * consumer, and every widget reads its result.
   */
  it('derives liveness in exactly one module', () => {
    const offenders = sources().filter((f) => /\brunIs(Live|Dead)\b|\bterminalOrStale\b/.test(code(f)))
    expect({
      rule: `only ${OWNER} may classify a run state as live or dead`,
      offenders,
    }).toEqual({ rule: `only ${OWNER} may classify a run state as live or dead`, offenders: [] })
  })

  /**
   * The other half of the same rule, and the one that produced B3: a component that reads
   * the clock itself can build a duration out of the moment the page happened to open. The
   * cockpit's clock arrives as the `now` prop from `useTick(live)`, which does not tick at
   * all on a run that has stopped, and the ONLY thing allowed to turn it into a runtime is
   * `honesty.clock`.
   */
  it('reads no wall clock in the cockpit', () => {
    const offenders = sources().filter((f) => /\bDate\.now\s*\(|\bnew Date\s*\(|\bperformance\.now\s*\(/.test(code(f)))
    expect({ rule: 'the clock arrives as a prop, never from the component', offenders })
      .toEqual({ rule: 'the clock arrives as a prop, never from the component', offenders: [] })
  })

  /**
   * ROUND 8, B1. `agent.durationMs` is a JOURNAL-DERIVED field (§6.4 J): the join restores
   * it from the agent's last SETTLED `result` record, so on a resumed or abandoned agent it
   * dates a DIFFERENT attempt from the one on screen. Round 7 taught `gantt.ts` that and
   * stopped there, so one orphan read "end unrecorded" beside its bar while the Agents
   * table, the Structure chip and the container roll-up all printed and summed the old
   * attempt's `1m1s` — the fourth, fifth and sixth sites of a defect the third had just
   * been fixed for.
   *
   * The field therefore has ONE reader. `honesty.agentDuration` separates the five cases
   * (`recorded`/`live`/`prior`/`unrecorded`/`absent`) and `durationValue` is the only gate
   * between a reading and a rendered figure; `Duration.tsx` is the only formatter.
   *
   * `lane.durationMs` and `container.durationMs` are exempt because they are not the field:
   * they are `durationValue(honesty.duration(agent))` already, computed one line after the
   * verdict was consulted, and their names are checked by the tests that build them.
   */
  it('reads the raw durationMs in exactly one module', () => {
    const DERIVED = /\b(lane|container|child|l)\.durationMs\b/
    const offenders = sources().filter((f) => code(f).split('\n').some(
      (line) => /\.durationMs\b/.test(line) && !DERIVED.test(line),
    ))
    const rule = `only ${OWNER} may read agent.durationMs — ask honesty.duration(agent)`
    expect({ rule, offenders }).toEqual({ rule, offenders: [] })
  })

  /**
   * ROUND 8, B2, and the general form of the rule above: `displayState ?? state` is the
   * question "what does this row SHOW", and asking it by hand gets the right answer only on
   * the snapshots the server already fixed. `agents.ts` asked it inside the `state` column's
   * sort comparator, so a quiescent run's rows came back ordered as `running`/`queued` under
   * cells, glyphs and accessible names that every one of them read `orphaned` — and `j`/`k`
   * walked that same order, because the traversal calls the same comparator.
   *
   * `honesty.effectiveState` is the one answer, and this bans the shorter thing to type.
   */
  it('never re-derives the state a row shows', () => {
    const offenders = sources().filter((f) => /\.displayState\b/.test(code(f)))
    const rule = 'ask honesty.effectiveState(agent), not agent.displayState ?? agent.state'
    expect({ rule, offenders }).toEqual({ rule, offenders: [] })
  })

  /**
   * And the positive half: the two columns that are READINGS rather than record fields sort
   * by the reading. A comparator that disagrees with the cell beside it is a sort order the
   * operator cannot explain, which is exactly what "sort by any column" (§2.4) is not.
   */
  it('sorts the reading columns by the reading', () => {
    const agents = code('agents.ts')
    expect(agents).toMatch(/case 'state': return `\$\{honesty\.effectiveState\(agent\)\}/)
    expect(agents).toMatch(/case 'duration': return durationValue\(honesty\.duration\(agent\)\)/)
    // …and both consumers of the ordering pass the verdict in — the table and `j`/`k`.
    expect(code('visible.ts')).toMatch(/sortAgents\([^)]*honesty\)/)
    expect(code('AgentsTab.tsx')).toMatch(/sortAgents\([^)]*honesty\)/)
  })

  /**
   * `displayState === 'orphaned'` is the SERVER's post-pass and is authoritative when it is
   * present — but it is only as current as the snapshot, and a quiescent run reaches the
   * client with it un-applied (that is exactly what `CORRUPT_RUN` fixture models). A
   * component testing it directly gets the right answer on the runs the server already
   * fixed and the wrong one on the runs that need fixing, which is how the header's own
   * orphan count came to disagree with the table one tab away. `honesty.orphaned` layers the
   * run's liveness over the flag; `Status.tsx` still takes the resulting boolean as a prop.
   */
  it('never tests the orphaned post-pass by hand', () => {
    const offenders = sources().filter((f) => /displayState\s*===\s*['"]orphaned['"]/.test(code(f)))
    expect({ rule: 'ask honesty.orphaned(agent), not agent.displayState', offenders })
      .toEqual({ rule: 'ask honesty.orphaned(agent), not agent.displayState', offenders: [] })
  })

  /**
   * The fourth site of the class, and the one round 7 found: `a.state === 'running'` written
   * inline as if it answered "is this agent still going".
   *
   * It does not. `agent.state` is what the last event SAID; whether it is still true is a
   * fact about the run, and `dag.ts` printing "stage 0 still running" from the raw comparison
   * put that sentence into two cells of a `corrupt-result` run whose engine had been gone for
   * twenty minutes — on the same screen whose chips one tab away already read `orphaned`.
   *
   * So the raw comparison is banned outright and the two questions get two different names in
   * `honesty.ts`: `isActiveState`/`isRunningState`/`isQueuedState` for the record (which
   * timestamp applies, which chip to draw), and `honesty.moving`/`honesty.orphaned` for the
   * present. Neither is now shorter to type than the other, so the choice has to be made on
   * purpose. `!==` is included: `a.state !== 'running' && a.state !== 'queued'` is the same
   * derivation wearing a negation, and it was live in `Structure.tsx`'s container rollup.
   */
  it('never derives an active state by hand', () => {
    const RAW = /\bstate\s*[!=]==\s*['"](running|queued)['"]|['"](running|queued)['"]\s*[!=]==/
    const offenders = sources().filter((f) => RAW.test(code(f)))
    const rule = 'ask isActiveState/isRunningState for the record, honesty.moving for the present'
    expect({ rule, offenders }).toEqual({ rule, offenders: [] })
  })

  /**
   * And the wording those predicates protect. A present-tense sentence about an agent — the
   * Structure grid's empty-cell reasons are the only ones the cockpit builds in a model —
   * may only be produced where the verdict is in scope. `dag.ts` takes it as a parameter, so
   * the grep is that the parameter is actually consulted next to the claim.
   */
  it('gates the Structure grid\'s present-tense wording on the verdict', () => {
    const dag = code('dag.ts')
    expect(dag).toMatch(/still running/)
    expect(dag).toMatch(/honesty\.orphaned/)
    // The dead-run branch exists at all — a guard that only proved the live wording is what
    // let round 6 ship with this site open.
    expect(dag).toMatch(/was orphaned/)
  })

  /**
   * ROUND 11, and the LAST consumer family: the run-level state itself.
   *
   * Rounds 6–10 closed agent state, agent durations and the run clock, and every one of them
   * moved a widget onto `honesty`. None of them looked at the field the whole verdict is
   * ABOUT. `RunHonesty.state` documents in its own type that it may LEAD `detail.state` — it
   * is `deriveRunState`'s answer, polled separately from the snapshot (§6.4) — so a `stale`
   * verdict and a `running` snapshot are not a contradiction to be prevented, they are the
   * normal one-poll window this module exists to resolve. Inside it the header rendered
   * `<StatusGlyph state={detail.state} />` (a SPINNING mark, parity #58's exact prohibition,
   * an inch above its own `died: not recorded` cell), and `canResumeState(detail.state)`
   * DISABLED Resume — the one action an operator opens a dead run to take.
   *
   * The three fixed sites are the header's glyph/chip, `RunActions`' resume/replay gate and
   * `DeadRunCard`'s glyph and copy. This is what stops the fourth: a run state may be
   * displayed or gated on only where it came from the verdict.
   *
   * The single exemption is the SEED — the line that hands the snapshot's state to
   * `deriveHonesty` as the fallback for a store that has not polled `deriveRunState` yet.
   * That read is the verdict being built, not a widget answering around it, and the positive
   * assertion below pins it to that one use.
   */
  it('never displays or gates on the raw run state', () => {
    // `detail`/`view`/`run` are the RunDetail-shaped identifiers in this directory; agent,
    // lane, rollup and journal-record states are different fields and are not the rule.
    const RAW_RUN_STATE = /\b(?:detail|view|run)\s*\??\.state\b/
    // `snapshot.runState ?? detail?.state` — the store's verdict first, the snapshot only as
    // its fallback. Any other line reading a run's state is a widget deciding for itself.
    const SEED = /snapshot\.runState\s*\?\?/
    const offenders = sources().filter((f) => code(f).split('\n').some(
      (line) => RAW_RUN_STATE.test(line) && !SEED.test(line),
    ))
    const rule = `only ${OWNER} may read a run's state — render and gate on honesty.state`
    expect({ rule, offenders }).toEqual({ rule, offenders: [] })
  })

  /**
   * And the positive half, because a ban alone is satisfied by a screen that shows no state
   * at all: the three sites READ the verdict, and the one exempt seed feeds it.
   */
  it('renders and gates the run state from the verdict', () => {
    const header = code('RunHeader.tsx')
    // One reading for the header, and the glyph, the chip and the actions all take it.
    expect(header).toMatch(/const state: RunState = honesty\.state \?\? 'unknown'/)
    expect(header).toMatch(/<StatusGlyph state=\{state\}/)
    expect(header).toMatch(/<StatusChip state=\{state\}/)
    expect(header).toMatch(/<RunActions [^>]*state=\{state\}/)
    // …and the gate is computed from it, not from the snapshot.
    expect(header).toMatch(/const resumable = canResumeState\(state\)/)
    expect(header).toMatch(/const replay = state === 'completed'/)

    const cockpit = code('Cockpit.tsx')
    expect(cockpit).toMatch(/const state = honesty\.state \?\? 'unknown'/)
    expect(cockpit).toMatch(/<StatusGlyph state=\{state\}/)
    // The seed is consumed by the derivation, so the exemption above cannot become a door.
    expect(cockpit).toMatch(/deriveHonesty\(detail, \{ now, state: runState \}\)/)
    // The stale-card gate reads the store's verdict too, never the snapshot it composed.
    expect(cockpit).toMatch(/canResumeState\(runState\)/)
  })

  /**
   * ROUND 11, B1 — the same class one layer down: the CSS CLASS is a state claim too.
   *
   * `lookUpState(state)[0]` is the visual half of the status vocabulary (`icons.ts`), and
   * `.achip.r` paints the running border (`cockpit.css:445`). Derived from the raw
   * `agent.state`, the Structure chip kept that border around a glyph that said `orphaned`:
   * a dead run whose chips still wore the running colour, one element outside the mark the
   * round-6 fix had already de-animated. Coverage missed it because every assertion looked
   * at the nested `.g`, never at the parent's own class.
   *
   * So a state-derived class comes from the verdict, or the element it lands on carries the
   * `orphan` modifier that neutralises it. The Timeline is the second form — §6.4 step 8
   * says "the run's fate, DIMMED", and `.bar .exec.orphan` (`cockpit.css:361`) is that dim
   * applied to the same span the colour is; the Structure chip is the first.
   */
  it('never colours a widget from a raw agent state', () => {
    const VERDICT = /lookUpState\(\s*honesty\.effectiveState\(/
    const DIMMED = /\borphaned\s*\?\s*' orphan'/
    const offenders = sources().filter((f) => {
      const src = code(f)
      const lookups = src.split('\n').filter((line) => /\blookUpState\s*\(/.test(line))
      if (!lookups.length) return false
      return !lookups.every((line) => VERDICT.test(line)) && !DIMMED.test(src)
    })
    const rule = 'a state class comes from honesty.effectiveState, or wears the orphan modifier'
    expect({ rule, offenders }).toEqual({ rule, offenders: [] })
  })

  /** And the positive half — both forms, named, so neither can quietly become the other. */
  it('draws the Structure chip and the Timeline bar from a verdict-bearing state', () => {
    expect(code('Structure.tsx')).toMatch(/const cls = lookUpState\(honesty\.effectiveState\(agent\)\)\[0\]/)
    expect(code('Timeline.tsx')).toMatch(/exec \$\{cls\}\$\{lane\.orphaned \? ' orphan' : ''\}/)
  })

  /** And the module that owns the rule reaches for the fold's predicates, as it must. */
  it('leaves the owner actually owning it', () => {
    const owner = code(OWNER)
    expect(owner).toMatch(/runIsLive/)
    expect(owner).toMatch(/runIsDead/)
    expect(owner).toMatch(/terminalOrStale/)
  })
})
