// THE CSS SCOPE GUARD (J1).
//
// §3 describes a design system that is TOKEN-scoped, not global: a feature's stylesheet
// dresses that feature's markup and nothing else. Plain CSS with no build step gives us no
// mechanism for that — every stylesheet in `viewer/src` is concatenated into one `app.css`
// and every selector in it is live against the whole document. Scoping is therefore a
// CONVENTION, and a convention with no gate is a bug waiting for its next name.
//
// It already had three:
//
//   `.bar`     cockpit's Gantt bar vs Home's mini progress bar. The Gantt's
//              `position: absolute; transform: translateY(-50%)` escaped the Home run
//              table's flex row and painted the 34px bar straight through the "14/14"
//              digits — a completed run rendered struck through, which is the exact
//              inversion of its meaning, on the product's primary screen.
//   `.step`    transcript's step card vs the cockpit saturation strip's step bars. The
//              card's `border` + `border-radius: var(--r2)` reached every 1–2px bar in the
//              strip (`.sat-plot .step` sets only `border-top`), hairlining and rounding a
//              plot that was designed with neither.
//   `.rawgrp`  cockpit's §6.5 degradation note vs transcript's raw-group disclosure button.
//              Two different components, one name; the transcript's is later in the bundle,
//              so it overrode the note's `align-items: flex-start` and 1.5 line-height.
//
// The rule this file enforces — the one that would have caught all three the day they were
// written, and catches the fourth:
//
//   **Every selector in a feature stylesheet must be ANCHORED**: its leftmost compound has
//   to carry at least one class name that no other stylesheet in `viewer/src` mentions, or
//   a class named in `SHARED_COMPONENTS` below — and that leftmost compound, WHOLE, must
//   appear in no other feature's markup.
//
// `src/ui/*.css` is the shared layer and is exempt by definition — global names there are
// the contract (`.btn`, `.chip`, `.dim`). Everything else is a feature and owes an anchor.
//
// ROUND 1 found the guard's own blind spot, and it was a big one. The stylesheet half of the
// audit was sound; the MARKUP half read `className` with a regex that sliced the quotes off
// `className="bar"` and then searched the remainder for quoted literals — so every plain
// static attribute, the commonest form in this tree, contributed nothing. The trespass rule
// therefore saw almost no markup, and the collisions it was blind to were live:
//
//   `.answer`  home's answer composer (`display: grid; grid-template-columns: 1fr auto`) vs
//              the transcript's RENDERED agent answer (VirtualTimeline.tsx) vs control's
//              composer, which redundantly carried home's name beside its own `.ctl-answer`.
//              Every markdown answer in the transcript was being laid out two columns wide
//              by a stylesheet that has never heard of the transcript.
//   `.seg`     the segmented control, defined in cockpit.css and rendered by the RESULT
//              screen's value-rendering picker. Not a collision — a genuinely shared
//              primitive filed under one feature, which is the same failure waiting to
//              happen the next time cockpit.css tunes it.
//
// The extractor is now the TypeScript parser (`classNamesIn`), and the fixtures below feed
// it real TSX rather than hand-written class sets, so a fixture can no longer pass by
// supplying the answer the extractor failed to find.
//
// ROUND 2 found the OTHER half of the same blind spot, on the stylesheet side. Ownership was
// read off `baseClassOf` — one class, no combinator — so a MULTI-class rule claimed nothing
// and no component was ever asked whether it rendered it:
//
//   `.btn.arm` home's armed-Resume treatment, rendered by the cockpit header's
//              Resume/Replay and by control's per-agent Cancel. On the destructive one
//              (`btn arm danger`) home's stale-amber `color`/`border-color` and the
//              primitive's `.btn.danger` red are both (0,2,0), and home.css loads later —
//              so "Cancel agent 3?" was painted in the colour reserved for a run that has
//              gone quiet. `.btn.arm` now lives in the primitive layer with a (0,3,0)
//              `.btn.arm.danger` that settles the colour by meaning, not by bundle order.
//
// Claims are therefore read off the WHOLE leftmost compound, and a foreign component
// trespasses when its markup carries every class in one.

import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('..', import.meta.url))

/**
 * Classes that are DELIBERATELY global: one component, styled by the stylesheet that owns
 * it, rendered into more than one feature's markup. Adding a name here is a claim that the
 * two uses are the SAME component — which is exactly what was false of `.bar`, `.step` and
 * `.rawgrp`, so it is a claim a reviewer has to accept, not a way to silence the guard. The
 * tests below check the claim as far as text can: an entry must be declared somewhere, and
 * it must genuinely be reached from two features.
 */
const SHARED_COMPONENTS: Readonly<Record<string, string>> = {
  rid: 'the run-id chip (§2.3/§2.4/§2.6): Home rows and attention cards, the cockpit header, '
    + 'the result header and the transcript session handle all render the same monospace id.',
  prose: 'the output of the one markdown renderer (src/lib/markdown.tsx:580), which the '
    + 'transcript and the result screen both mount.',
  verdict: 'the §7.2 steer/mail delivery verdict pill: both inbox rails and the transcript '
    + 'mail card render it from the same journalled `delivery` word.',
  'lock-chip': 'the §7.2 read-only explanation chip, owned by control.css and positioned by '
    + 'the cockpit header that mounts <Locked/>.',
  'ro-chip': 'the §7.2 topbar read-only badge: styled by the shell that mounts it '
    + '(app/App.tsx:178) and rendered by the control feature that computes the summary '
    + '(control/Locked.tsx:113). One chip in one place — the component file is simply not '
    + 'in the directory that dresses it.',
  'markdown-degraded': 'emitted by the ONE markdown renderer (lib/markdown.tsx:583) when a '
    + 'document fails preflight, and dressed by transcript.css. The result screen mounts the '
    + 'same renderer, so the class is shared by construction rather than by coincidence.',
  'md-link-blocked': 'the §16.2 link-policy stand-in the ONE markdown renderer substitutes '
    + 'for a disallowed href (lib/markdown.tsx:540). Same construction as `markdown-degraded`: '
    + 'one emitter, dressed by transcript.css, mounted by the transcript and the result view.',
  'md-table-scroll': 'the overflow shell the ONE markdown renderer wraps every GFM table in '
    + '(lib/markdown.tsx:561), dressed by transcript.css and mounted wherever that renderer is '
    + '— the transcript and the result view. One emitter, so one component.',
  // The §2.5 inbox rail, twice. cockpit/InboxRail.tsx renders it READ-ONLY and
  // control/InboxRail.tsx renders the ANSWERABLE one ("W12's replacement for the cockpit's
  // inbox rail", control/InboxRail.tsx:2) — the same cards, the same chrome, one stylesheet.
  // `qitem` and `mf` were already registered on this argument; these are their siblings, and
  // leaving them off the list was what let the audit read as complete when it was not.
  inbox: 'the §2.4 inbox column itself (`<aside class="col inbox">`, and `.col.inbox.drawer` '
    + 'below §3.3\'s 900px): the cockpit rail and the control rail are one column in two '
    + 'modes, and cockpit.css positions the column in the §3.7 three-column grid.',
  'inbox-scrim': 'the dim behind that column when it is a drawer (<900px). Both rails render '
    + 'it, and it is the cockpit grid it dims, so cockpit.css is where it belongs.',
  qitem: 'a §2.5 open-question row; the cockpit inbox rail renders it read-only and the '
    + 'control inbox rail renders the answerable one.',
  qh: 'the header line of that same question row — asking agent, its status chip and the '
    + 'relative time — rendered identically by both rails.',
  qb: 'the question text inside that row: one type ramp for a question, on both rails, so '
    + 'the same words wrap the same way whichever rail is mounted.',
  qf: 'the footer of the read-only question row (who is waiting and for how long); the '
    + 'control rail renders it too, above its composer.',
  mitem: 'a §2.5 mail item; both rails render the same card for inbound and outbound mail, '
    + 'off the same journalled record.',
  mh: 'that mail item\'s header — direction, correspondent link and relative time — one row '
    + 'of chrome rendered by both rails.',
  mb: 'that mail item\'s body text, on the §2.5 message type ramp shared by both rails.',
  mf: 'the mail footer inside a §2.5 mail item, rendered by both inbox rails.',
}

/** Every stylesheet under `viewer/src`, so a new feature cannot dodge the guard by adding a file. */
function stylesheets(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.css')) found.push(path)
    }
  }
  walk(SRC)
  return found.sort()
}

/** Component sources — everything a `className` can be written in, tests excluded. */
function components(): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path)
    }
  }
  walk(SRC)
  return found.sort()
}

const rel = (path: string) => relative(SRC, path).split(sep).join('/')
/** `features/home/home.css` → `home`; `ui/…`/`lib/…` → `shared`; `app/shell.css` → `app`. */
const featureOf = (path: string): string => {
  const parts = rel(path).split('/')
  if (parts[0] === 'features') return parts[1]!
  if (parts[0] === 'app') return 'app'
  return 'shared'
}
/** The shared layer is global by contract; every other stylesheet is a feature's. */
const isShared = (path: string) => rel(path).startsWith('ui/')

/** Every selector in a stylesheet, at-rule preludes dropped and their bodies kept. */
function selectorsOf(css: string): string[] {
  const out: string[] = []
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const match of body.matchAll(/([^{}]+)\{/g)) {
    const prelude = match[1]!.trim()
    if (!prelude || prelude.startsWith('@')) continue
    for (const part of prelude.split(',')) {
      const selector = part.trim()
      // `@keyframes` stops (`0%`, `to`) are not selectors.
      if (selector && !/^(?:from|to|-?[\d.]+%)$/.test(selector)) out.push(selector)
    }
  }
  return out
}

const CLASS = /\.(-?[A-Za-z_][\w-]*)/g
const classesIn = (selector: string) => [...selector.matchAll(CLASS)].map((m) => m[1]!)
/**
 * The leftmost compound — the part that decides WHAT a rule can ever match. `:not(…)`,
 * `:is(…)` and friends are stripped first so a class buried in a functional pseudo cannot
 * be mistaken for the anchor.
 */
function leftmostCompound(selector: string): string {
  const flat = selector.replace(/:(?:not|is|where|has)\([^()]*\)/g, '')
  return flat.split(/[\s>+~]+/).filter(Boolean)[0] ?? ''
}
/** A BASE rule: one class, no combinator — `.qitem`, `.qitem:last-child`. Not `.mf .verdict`. */
function baseClassOf(selector: string): string | null {
  const flat = selector.replace(/:(?:not|is|where|has)\([^()]*\)/g, '')
  if (/[\s>+~]/.test(flat.trim())) return null
  const classes = classesIn(flat)
  return classes.length === 1 ? classes[0]! : null
}

const SHEETS = stylesheets().map((path) => {
  const selectors = selectorsOf(readFileSync(path, 'utf8'))
  return { path, name: rel(path), feature: featureOf(path), shared: isShared(path), selectors }
})

/**
 * Class names written into a `className`, per component file — read off the TSX AST rather
 * than off the text.
 *
 * Round 1 did this with a regex and got the most common form in the codebase WRONG: it
 * sliced the quotes off `className="bar"` and then looked for quoted literals INSIDE the
 * slice, so every plain static attribute contributed nothing and the trespass rule was
 * effectively blind to static markup. The parser has no such blind spot: `className="bar"`
 * and ``className={`qitem ${x ? 'answered' : ''}`}`` are both just literals under one
 * attribute node.
 */
function classNamesIn(source: string, fileName = 'component.tsx'): Set<string> {
  const out = new Set<string>()
  const add = (text: string) => {
    for (const token of text.split(/\s+/)) if (/^-?[A-Za-z_][\w-]*$/.test(token)) out.add(token)
  }
  /** Every literal chunk reachable from a className value — `${…}` holes are seams, not text. */
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) add(node.text)
    else if (ts.isTemplateExpression(node)) {
      add(node.head.text)
      for (const span of node.templateSpans) { add(span.literal.text); collect(span.expression) }
    } else node.forEachChild(collect)
  }
  // A class name is just as live when it is built one statement above the JSX as when it
  // sits in the attribute — `const className = \`seg-l ${state}\`` (RunHeader.tsx:722),
  // `const cls = ['ic']` (Icon.tsx:41), `const classes = ['prose', className]`
  // (markdown.tsx:580) are all class lists, so all of them are read.
  const NAMED = /^(?:class|className|classes|cls)$|(?:Class|Classes|ClassName)$/
  const walk = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && NAMED.test(node.name.text)) {
      if (node.initializer) collect(node.initializer)
    } else if (
      (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node))
      && ts.isIdentifier(node.name) && NAMED.test(node.name.text)
    ) {
      if (node.initializer) collect(node.initializer)
    }
    node.forEachChild(walk)
  }
  walk(ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX))
  return out
}

const COMPONENTS = components().map((path) => ({
  name: rel(path), feature: featureOf(path), classes: classNamesIn(readFileSync(path, 'utf8'), path),
}))

type Sheet = { name: string, feature: string, shared: boolean, selectors: string[] }
type Component = { name: string, feature: string, classes: Set<string> }

/**
 * The whole rule, as one pure function of the source text — so the tests below can run it
 * against the real tree AND against a fixture that reproduces the collisions this guard was
 * written for. A guard that has never been seen to fail is not evidence of anything.
 */
function audit(sheets: Sheet[], parts: Component[], registry: Readonly<Record<string, unknown>>) {
  const scoped = sheets.filter((s) => !s.shared)
  const mentions = new Map<string, Set<string>>()
  for (const sheet of sheets) {
    for (const selector of sheet.selectors) {
      for (const cls of classesIn(selector)) {
        if (!mentions.has(cls)) mentions.set(cls, new Set())
        mentions.get(cls)!.add(sheet.name)
      }
    }
  }
  const exclusive = (cls: string, sheet: string) => {
    const owners = mentions.get(cls)
    return owners?.size === 1 && owners.has(sheet)
  }

  const unanchored: string[] = []
  const elementLed: string[] = []
  for (const sheet of scoped) {
    for (const selector of sheet.selectors) {
      const compound = leftmostCompound(selector)
      // A rule that can match without ANY class is the same failure with a wider blast
      // radius: `button { … }` in a feature file restyles the whole product.
      if (!compound.startsWith('.')) { elementLed.push(`${sheet.name}: \`${selector}\``); continue }
      const classes = classesIn(compound)
      if (classes.some((cls) => exclusive(cls, sheet.name) || Object.hasOwn(registry, cls))) continue
      const also = classes.map((cls) => (
        `.${cls} is also in ${[...mentions.get(cls)!].filter((f) => f !== sheet.name).join(', ')}`
      ))
      unanchored.push(`${sheet.name}: \`${selector}\` — ${also.join('; ')}`)
    }
  }

  // A BASE rule (`.rawgrp {}`) in two feature stylesheets is the signature of two components
  // that picked the same word: whichever loads later silently redresses the other one.
  const bases = new Map<string, Set<string>>()
  for (const sheet of scoped) {
    for (const selector of sheet.selectors) {
      const base = baseClassOf(selector)
      if (!base) continue
      if (!bases.has(base)) bases.set(base, new Set())
      bases.get(base)!.add(sheet.name)
    }
  }
  const contested = [...bases]
    .filter(([, files]) => files.size > 1)
    .map(([cls, files]) => `.${cls} has a base rule in ${[...files].sort().join(' and ')}`)

  // What a feature stylesheet CLAIMS is its leftmost compound, whole. Round 2 found that
  // reading claims off `baseClassOf` — one class, no combinator — silently exempted every
  // multi-class rule: `baseClassOf('.btn.arm')` is null, so home.css could declare
  // `.btn.arm` and the trespass rule never asked who else renders `btn arm`. Three features
  // did, and in control the rule landed on `btn arm danger`, repainting a destructive
  // confirmation in the amber of a stale run. The claim is the compound, so `.btn.arm` is
  // a claim on the PAIR and `.progress-mini .bar` is a claim on `.progress-mini`.
  const claims = new Map<string, { text: string, sheet: string, feature: string, classes: string[] }>()
  for (const sheet of scoped) {
    for (const selector of sheet.selectors) {
      const classes = classesIn(leftmostCompound(selector))
      // A registered shared component is deliberately rendered by more than one feature —
      // that is the whole content of the registry — so a compound naming one claims nothing.
      if (!classes.length || classes.some((cls) => Object.hasOwn(registry, cls))) continue
      const key = [...classes].sort().join('.')
      if (!claims.has(key)) {
        claims.set(key, { text: `.${classes.join('.')}`, sheet: sheet.name, feature: sheet.feature, classes })
      }
    }
  }

  // The stylesheet-side rules cannot see this one: a feature can render another feature's
  // class name with no CSS of its own and inherit its look silently. Home's
  // `<span className="bar">` (RunTable.tsx:185) was exactly that, and so was the cockpit's
  // `className="btn arm"`. A compound is trespassed only when the markup carries ALL of it:
  // `btn` alone is the shared primitive, `btn arm` is home's rule.
  const trespass: string[] = []
  for (const part of parts) {
    for (const claim of claims.values()) {
      if (claim.feature === part.feature) continue
      if (claim.classes.every((cls) => part.classes.has(cls))) {
        trespass.push(`${part.name} renders ${claim.text}, which ${claim.sheet} owns`)
      }
    }
  }

  return { unanchored, elementLed, contested, trespass: trespass.sort() }
}

const REAL = audit(SHEETS, COMPONENTS, SHARED_COMPONENTS)

describe('feature stylesheets are scoped (§3)', () => {
  it('anchors every selector on a class its own stylesheet owns', () => {
    expect(
      REAL.unanchored,
      'A feature stylesheet may only declare rules that start with a class it alone uses, or a\n'
      + 'registered SHARED_COMPONENTS name. Anchor the rule on a container this stylesheet owns\n'
      + '(that is what `.lane-track .bar` is), or rename it. Registering it instead is a claim\n'
      + 'that both features render the SAME component.',
    ).toEqual([])
  })

  it('never lets a feature stylesheet style a bare element or the universal selector', () => {
    expect(REAL.elementLed).toEqual([])
  })

  it('gives every class exactly one owning stylesheet', () => {
    expect(REAL.contested).toEqual([])
  })

  it('keeps a feature class out of every other feature’s markup', () => {
    expect(
      REAL.trespass,
      'Rename one of them, or — if they really are the same component — register the class in\n'
      + 'SHARED_COMPONENTS with the argument for why.',
    ).toEqual([])
  })
})

describe('the guard itself', () => {
  // The three collisions that shipped, rebuilt as a fixture. If a refactor ever makes the
  // audit blind to them, this fails before the real tree does.
  const sheet = (name: string, feature: string, css: string, shared = false): Sheet => (
    { name, feature, shared, selectors: selectorsOf(css) }
  )

  /** A component fixture built the way the real ones are: from SOURCE, through the extractor. */
  const part = (name: string, feature: string, source: string): Component => (
    { name, feature, classes: classNamesIn(source, name) }
  )

  it('catches the Gantt bar bleeding onto Home’s run table', () => {
    // Deliberately real TSX, not a hand-written Set. Round 1's extractor returned an empty
    // set for `className="bar"` and this fixture hid it by supplying the answer.
    const RunTable = `
      export const Row = ({ done, total }: { done: number, total: number }) => (
        <span className="progress-mini"><span className="bar" /><b>{done}/{total}</b></span>
      )
    `
    const found = audit([
      sheet('features/cockpit/cockpit.css', 'cockpit', '.lane-track{position:relative} .bar{position:absolute}'),
      sheet('features/home/home.css', 'home', '.progress-mini{display:flex} .progress-mini .bar{width:34px}'),
    ], [part('features/home/RunTable.tsx', 'home', RunTable)], {})
    expect(found.unanchored).toEqual([
      'features/cockpit/cockpit.css: `.bar` — .bar is also in features/home/home.css',
    ])
    expect(found.trespass).toEqual([
      'features/home/RunTable.tsx renders .bar, which features/cockpit/cockpit.css owns',
    ])
  })

  it('catches the transcript step card bleeding onto the saturation strip', () => {
    const found = audit([
      sheet('features/cockpit/cockpit.css', 'cockpit', '.sat-plot{height:38px} .sat-plot .step{border-top:1px}'),
      sheet('features/transcript/transcript.css', 'transcript', '.trow{display:grid} .step{border:1px solid}'),
    ], [], {})
    expect(found.unanchored).toEqual([
      'features/transcript/transcript.css: `.step` — .step is also in features/cockpit/cockpit.css',
    ])
  })

  it('catches two features declaring a base rule for the same word', () => {
    const found = audit([
      sheet('features/cockpit/cockpit.css', 'cockpit', '.rawgrp{align-items:flex-start}'),
      sheet('features/transcript/transcript.css', 'transcript', '.rawgrp{align-items:center}'),
    ], [], { rawgrp: 'registered, and still wrong' })
    // Registering it silences the anchor rule but NOT the ownership rule: two base rules for
    // one name is two components, whatever the registry claims.
    expect(found.unanchored).toEqual([])
    expect(found.contested).toEqual([
      '.rawgrp has a base rule in features/cockpit/cockpit.css and features/transcript/transcript.css',
    ])
  })

  it('catches a feature stylesheet reaching for a bare element', () => {
    const found = audit([sheet('features/home/home.css', 'home', 'button{border:0}')], [], {})
    expect(found.elementLed).toEqual(['features/home/home.css: `button`'])
  })

  it('catches home’s armed-button rule reaching the cockpit’s and control’s armed buttons', () => {
    // ROUND 2's finding, as a fixture. `.btn.arm` was home.css's, and `baseClassOf('.btn.arm')`
    // is null — two classes — so the round-1 guard registered no owner for it and asked no
    // component whether it rendered `btn arm`. Three did. In control the compound landed on
    // `btn arm danger`, where `.btn.arm`'s stale-amber `color`/`border-color` and
    // `.btn.danger`'s red are both (0,2,0): home.css loads later, so the confirmation for
    // KILLING an agent was painted in the colour of a run that has gone quiet.
    const RunHeader = '<button className="btn arm" type="button">Resume run-7?</button>'
    const SteerComposer = '<button className="btn arm danger" type="button">Cancel agent 3?</button>'
    const sheets = [
      sheet('ui/primitives.css', 'shared', '.btn{border:1px} .btn.danger{color:red}', true),
      sheet('features/home/home.css', 'home', '.btn.arm{color:orange} .acard-actions{display:flex}'),
    ]
    const found = audit(sheets, [
      part('features/cockpit/RunHeader.tsx', 'cockpit', RunHeader),
      part('features/control/SteerComposer.tsx', 'control', SteerComposer),
    ], {})
    expect(found.trespass).toEqual([
      'features/cockpit/RunHeader.tsx renders .btn.arm, which features/home/home.css owns',
      'features/control/SteerComposer.tsx renders .btn.arm, which features/home/home.css owns',
    ])
    // And the fix — the same treatment declared in the layer that owns `.btn` — is clean,
    // including the extra class the destructive use carries.
    const fixed = audit([
      sheet('ui/primitives.css', 'shared', '.btn{border:1px} .btn.arm{color:orange} .btn.arm.danger{color:red}', true),
      sheet('features/home/home.css', 'home', '.acard-actions{display:flex}'),
    ], [
      part('features/cockpit/RunHeader.tsx', 'cockpit', RunHeader),
      part('features/control/SteerComposer.tsx', 'control', SteerComposer),
    ], {})
    expect(fixed).toEqual({ unanchored: [], elementLed: [], contested: [], trespass: [] })
  })

  it('does not call a partial compound a trespass', () => {
    // The compound rule has to be exact, or every `.btn` in the product would answer for
    // home's `.btn.arm`. Markup carrying only part of a claimed compound is not wearing it.
    const found = audit([
      sheet('ui/primitives.css', 'shared', '.btn{border:1px}', true),
      sheet('features/home/home.css', 'home', '.btn.arm{color:orange}'),
    ], [part('features/cockpit/RunHeader.tsx', 'cockpit', '<button className="btn">Resume</button>')], {})
    expect(found.trespass).toEqual([])
  })

  it('lets the shared layer keep its global names', () => {
    const found = audit([
      sheet('ui/primitives.css', 'shared', '.btn{border:0} .chip{border:0}', true),
      sheet('features/home/home.css', 'home', '.rt-row .btn{margin:0} .rt-row{display:grid}'),
    ], [part('features/home/RunTable.tsx', 'home', '<b className="btn chip rt-row" />')], {})
    expect(found).toEqual({ unanchored: [], elementLed: [], contested: [], trespass: [] })
  })
})

// The extractor is the half of the guard with no CSS to check it, and it is the half that
// failed review round 1: a regex that stripped the quotes off `className="bar"` and then
// searched the remainder for quoted literals found nothing, so every plain static attribute
// — the commonest form in this codebase — was invisible to the trespass rule.
describe('classNamesIn', () => {
  it('reads a plain quoted attribute, the form round 1 could not see', () => {
    expect([...classNamesIn('<span className="bar">14/14</span>')]).toEqual(['bar'])
    expect([...classNamesIn("<span className='qitem answered' />")]).toEqual(['qitem', 'answered'])
  })

  it('fails the real-tree trespass rule on static markup alone', () => {
    // The end-to-end proof: source text in, verdict out, nothing hand-supplied between them.
    const source = 'export const Row = () => <span className="bar">14/14</span>\n'
    const found = audit(
      [{
        name: 'features/cockpit/cockpit.css',
        feature: 'cockpit',
        shared: false,
        selectors: selectorsOf('.lane-track{position:relative} .bar{position:absolute}'),
      }],
      [{ name: 'features/home/RunTable.tsx', feature: 'home', classes: classNamesIn(source) }],
      {},
    )
    expect(found.trespass).toEqual([
      'features/home/RunTable.tsx renders .bar, which features/cockpit/cockpit.css owns',
    ])
  })

  it('reads expression, template and conditional forms', () => {
    const source = `
      const cls = cond ? 'sel' : 'idle'
      const node = <div className={\`qitem \${pending ? 'pending' : ''}\`} />
      const other = <div className={'seg' + (x ? ' wide' : '')} />
    `
    expect([...classNamesIn(source)].sort())
      .toEqual(['idle', 'pending', 'qitem', 'seg', 'sel', 'wide'])
  })

  it('reads a class name built one statement above the JSX', () => {
    // RunHeader.tsx:722 does exactly this: `const className = \`seg-l ${attempt.state}\``.
    const source = 'const className = `seg-l ${attempt.state}`\nreturn <button className={className} />'
    expect([...classNamesIn(source)]).toEqual(['seg-l'])
  })

  it('does not mistake unrelated strings for class names', () => {
    const source = `
      const label = 'never answered'
      fetch('/api/runs', { headers: { 'x-flowition-token': 'secret' } })
      return <div title="waiting on you" data-answer="sent" className="qtext dim" />
    `
    expect([...classNamesIn(source)].sort()).toEqual(['dim', 'qtext'])
  })
})

describe('the SHARED_COMPONENTS registry', () => {
  it('lists only classes that some stylesheet actually declares', () => {
    const declared = new Set<string>()
    for (const sheet of SHEETS) for (const s of sheet.selectors) for (const c of classesIn(s)) declared.add(c)
    expect(Object.keys(SHARED_COMPONENTS).filter((cls) => !declared.has(cls))).toEqual([])
  })

  it('lists only classes that more than one place genuinely reaches', () => {
    // A name that one feature alone touches — its own stylesheet and its own components — is
    // not a shared component, it is an unscoped rule with an excuse. `shared` counts as a
    // second reacher because a class emitted from `src/ui` or `src/lib` (`.prose`,
    // `.markdown-degraded`) lands in whatever feature mounts that renderer.
    const thin: string[] = []
    for (const cls of Object.keys(SHARED_COMPONENTS)) {
      const reach = new Set<string>()
      for (const sheet of SHEETS) if (sheet.selectors.some((s) => classesIn(s).includes(cls))) reach.add(sheet.feature)
      for (const component of COMPONENTS) if (component.classes.has(cls)) reach.add(component.feature)
      if (reach.size < 2) thin.push(`.${cls} is only reached by ${[...reach].join(', ') || 'nothing'}`)
    }
    expect(thin).toEqual([])
  })

  it('states a reason for every entry', () => {
    for (const [cls, why] of Object.entries(SHARED_COMPONENTS)) {
      expect(why.length, `.${cls} needs an argument, not a label`).toBeGreaterThan(40)
    }
  })
})
