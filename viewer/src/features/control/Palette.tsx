/**
 * The ⌘K / Ctrl+K command palette (DESIGN §2.7): "jump to any run or agent by fuzzy name,
 * invoke actions (answer, cancel, resume, theme)".
 *
 * **Behavior is React Aria's, appearance is §3's.** §16.3 adopts hooks-level @react-aria
 * primitives and names this surface twice — "keyboard list navigation, palette" — so the
 * combobox/listbox pairing here is `useComboBoxState` + `useComboBox` + `useListBox` +
 * `useOption`, exactly the composition React Aria specifies. What that buys, and what the
 * hand-wired version of this file owned and could get subtly wrong:
 *
 *   • the `combobox`/`listbox`/`option` role triangle and every id that links it;
 *   • `aria-activedescendant` VIRTUAL FOCUS — the input keeps DOM focus, so typing never
 *     stops working while the highlight moves;
 *   • Arrow/Home/End/PageUp/PageDown across the collection, focus wrap, and the
 *     "highlight re-homes when the collection changes" rule;
 *   • the live-region announcement of how many options are available after a filter;
 *   • press behavior on options that does not steal focus from the input.
 *
 * Two things are deliberately NOT the library's, and both are §-driven:
 *
 *   1. **Filtering.** `defaultFilter` is neutralized and the collection is handed the
 *      already-ranked rows: §2.7 asks for FUZZY name matching, which `fuzzy.ts` implements
 *      and `useFilter`'s contains/startsWith does not.
 *   2. **Escape, and the always-open menu.** This combobox lives inside a modal whose entire
 *      body is the list. React Aria's Escape reverts the input and closes the menu; here
 *      Escape must close the PALETTE (§2.7: "esc closes panel / drawer"), so it is handled
 *      before the library's handler and the menu is held open for the dialog's lifetime.
 *
 * The DOM, the class names and every pixel stay this file's and `control.css`'s — §16.3's
 * line is "borrow behavior, not appearance: no @adobe/react-spectrum, no component kit, no
 * kit CSS", and `packageGraph.test.ts` asserts the kit never enters the tree.
 *
 * §7.2 gating is the same everywhere in this feature: a capability the session did not
 * report renders the action **locked and visible**, never hidden. An operator looking for
 * "Cancel run" in the palette of a read-only viewer must find it and learn why it is off —
 * so locked rows stay ARROW-REACHABLE and carry `aria-disabled`, rather than being taken out
 * of the collection's navigation by `disabledKeys`.
 *
 * **Two gates, one contract.** A row is refused either because the VIEWER may not do it
 * (capability, §7.2) or because THIS RUN may not have it done (lifecycle eligibility,
 * §7.3 — delete refuses a live run, cancel wants a live one, resume wants a terminal one).
 * `rowDisabledReason` is the single answer both the renderer and the activator ask, so a
 * row that reads as enabled always runs and a row that reads as disabled never does.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useComboBox } from '@react-aria/combobox'
import { useListBox, useOption } from '@react-aria/listbox'
import { Item } from '@react-stately/collections'
import { useComboBoxState } from '@react-stately/combobox'
import type { RunDetail, RunSummary } from '../../api/types.js'
import { requestDestinationFocus } from '../../app/destination.js'
import { href, navigate } from '../../app/router.js'
import { Icon } from '../../ui/Icon.js'
import type { GlyphName } from '../../ui/icons.js'
import { StatusGlyph } from '../../ui/Status.js'
import type { Capability } from './capabilities.js'
import { capabilityState, explainCapability } from './capabilities.js'
import { ControlDialog } from './Dialog.js'
import { rank } from './fuzzy.js'

export interface PaletteAction {
  id: string
  /** What the fuzzy matcher sees. */
  text: string
  glyph: GlyphName
  hint?: string
  /** §7.2 capability this action needs, when it needs one. */
  capability?: Capability
  /**
   * Why this action cannot run *against this run, right now* — §7.3's lifecycle
   * eligibility, and everything else that is not a capability question. Set = the row is
   * `aria-disabled`, carries this sentence, and refuses activation without closing the
   * palette. It is deliberately SEPARATE from `capability`: the two gates have different
   * causes ("restart the viewer with --control" vs "cancel the run first") and an operator
   * given the wrong one is sent to do the wrong thing.
   */
  disabledReason?: string
  run(): void
}

export interface PaletteProps {
  onClose: () => void
  /** The run the operator is looking at, when they are looking at one. */
  detail?: RunDetail | null
  /** Runs for the jump list. Fetched by the host when the palette opens. */
  runs: RunSummary[]
  runsLoading?: boolean
  runsError?: string | null
  /** How many runs the keyset sweep has adopted so far (§2.7 — no silent truncation). */
  runsListed?: number
  /** `totalOnDisk` from the listing, when a page has answered. */
  runsTotal?: number | null
  capabilities: readonly string[] | null
  capabilityError?: string | null
  /** The §7.2/§7.3 actions the host owns (they open dialogs, which this must not nest). */
  actions: PaletteAction[]
  /** §3.6's restore target for the whole modal transition — see `Dialog.tsx`. */
  restoreFocusTo?: Element | null
}

interface Row {
  id: string
  text: string
  kind: 'action' | 'run' | 'agent'
  glyph?: GlyphName
  state?: string
  hint?: string
  capability?: Capability
  disabledReason?: string
  run(): void
}

/** The state hook's return type, named once so the sub-components can take it. */
type PaletteState = ReturnType<typeof useComboBoxState<Row>>

/**
 * The single answer to "may this row run?", shared by the renderer and the activator so
 * they cannot disagree — a row that looks enabled and refuses, or looks disabled and
 * fires, is the defect either way.
 *
 * Capability first: it is the more fundamental refusal (the viewer may never do this),
 * and its sentence names the flag that fixes it. It FAILS CLOSED — `unknown` disables the
 * row too (review round 5, B1). The palette is the one surface that can fire a mutation
 * from anywhere in the app, including from inside a modal on a screen whose own controls
 * are locked; a row that runs on an unanswered permission check is that gate's widest hole.
 * The row still says which refusal it is: `explainCapability` returns the read-only sentence
 * for `locked` and the "not granted yet / the check failed" one for `unknown`.
 */
function rowDisabledReason(
  row: Pick<Row, 'capability' | 'disabledReason'>,
  capabilities: readonly string[] | null,
  capabilityError?: string | null,
): string | null {
  if (row.capability && capabilityState(capabilities, row.capability) !== 'allowed') {
    return explainCapability(capabilities, row.capability, capabilityError ?? null)
  }
  return row.disabledReason ?? null
}

export function Palette(props: PaletteProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const listBoxRef = useRef<HTMLUListElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  const allRows = useMemo<Row[]>(() => {
    const out: Row[] = props.actions.map((action) => ({
      id: `action:${action.id}`,
      text: action.text,
      kind: 'action',
      glyph: action.glyph,
      ...(action.hint ? { hint: action.hint } : {}),
      ...(action.capability ? { capability: action.capability } : {}),
      ...(action.disabledReason ? { disabledReason: action.disabledReason } : {}),
      run: action.run,
    }))
    // A jump is a navigation AND a focus hand-off (§2.7 + §3.6). The intent is recorded
    // beside the `navigate` and claimed by the destination's own header once the route has
    // committed — see `app/destination.ts` for why focusing anything from here cannot work.
    for (const agent of props.detail?.agents ?? []) {
      const label = agent.label ?? `agent ${agent.index}`
      const runId = props.detail!.runId
      out.push({
        id: `agent:${agent.index}`,
        text: `agent ${agent.index} ${label}`,
        kind: 'agent',
        state: agent.displayState ?? agent.state,
        hint: `${agent.adapter}${agent.model ? ` · ${agent.model}` : ''}`,
        run: () => {
          // The intent is recorded BEFORE the navigation — `app/destination.ts` reads the
          // route it is leaving to tell the destination's header from the outgoing screen's.
          requestDestinationFocus({ kind: 'agent', runId, index: agent.index })
          navigate(href.agent(runId, agent.index))
        },
      })
    }
    for (const run of props.runs) {
      out.push({
        id: `run:${run.runId}`,
        text: run.name ? `${run.name} ${run.runId}` : run.runId,
        kind: 'run',
        state: run.state,
        hint: `${run.agents.done}/${run.agents.total} agents`,
        run: () => {
          requestDestinationFocus({ kind: 'run', runId: run.runId })
          navigate(href.run(run.runId))
        },
      })
    }
    return out
  }, [props.actions, props.detail, props.runs])

  const [query, setQuery] = useState('')
  const state = usePaletteState(allRows, props, query, setQuery)

  // React Aria's combobox opens on focus and closes on Escape/commit/blur. This palette's
  // menu IS the modal's body, so it is held open for as long as the dialog is mounted; the
  // close paths that matter (Escape, the scrim, activating a row) all run `props.onClose`,
  // which unmounts the whole thing.
  useEffect(() => {
    if (!state.isOpen) state.open(null, 'manual')
  })

  // §2.7's palette always has a row under the cursor, so `↵` runs something the operator
  // can see. React Aria's combobox deliberately leaves the focused key null until an arrow
  // key or a hover moves it (an autocomplete must not commit a suggestion nobody chose);
  // a command palette is the opposite contract — the first match IS the proposal.
  //
  // It re-homes to the first row whenever the QUERY changes (a highlight left on row 7 of
  // the previous list would run something invisible), whenever the focused row has left the
  // collection, and — the round-4 fix — whenever the collection REORDERS under a highlight
  // the operator never placed.
  //
  // That last case is not hypothetical: the run list arrives asynchronously (`sweepRuns`
  // walks §5.4.2's cursor), so an operator who types a run id gets a list of actions first,
  // the highlight lands on the best action, and then the run itself arrives and ranks
  // FIRST. Before this, the highlight stayed where it was: the row presented as the
  // proposal was row 1 and `↵` ran row 2. The §12.1 walkthrough caught it doing exactly
  // that — typing a run id and activating a *disabled* Resume action instead, which
  // (correctly) did nothing at all, which is the worst possible feedback.
  //
  // "Never placed" is the whole distinction, and it is tracked rather than guessed:
  // `homed` is the key THIS effect last set, so a focused key that differs from it is one
  // the operator moved (an arrow key, Home/End, or a hover). From then on the highlight is
  // theirs until the query changes.
  const lastQuery = useRef<string | null>(null)
  const homed = useRef<unknown>(null)
  const operatorMoved = useRef(false)
  useEffect(() => {
    const first = state.collection.getFirstKey() ?? null
    const focused = state.selectionManager.focusedKey
    const orphaned = focused == null || state.collection.getItem(focused) == null
    const typed = lastQuery.current !== query
    if (typed) {
      lastQuery.current = query
      operatorMoved.current = false
    } else if (!orphaned && focused !== homed.current) {
      operatorMoved.current = true
    }
    if ((typed || orphaned || !operatorMoved.current) && focused !== first) {
      state.selectionManager.setFocusedKey(first)
      homed.current = first
    }
  })

  const { inputProps, listBoxProps, labelProps } = useComboBox(
    {
      inputRef,
      listBoxRef,
      popoverRef,
      'aria-label': 'Search runs, agents and actions',
      allowsCustomValue: true,
      shouldFocusWrap: true,
    },
    state,
  )

  return (
    <ControlDialog
      name="palette"
      size="wide"
      title="Command palette"
      onClose={props.onClose}
      restoreFocusTo={props.restoreFocusTo ?? null}
    >
      <div className="pal" ref={popoverRef}>
        <label className="vh" {...labelProps}>Search runs, agents and actions</label>
        <input
          {...inputProps}
          ref={inputRef}
          className="inp pal-input"
          autoComplete="off"
          spellCheck={false}
          placeholder="jump to a run or agent, or run an action…"
          onKeyDown={(event) => {
            // Escape belongs to the DIALOG (§2.7), not to the combobox — React Aria would
            // revert the input and close the menu, leaving an open palette with no list.
            if (event.key === 'Escape') {
              event.preventDefault()
              props.onClose()
              return
            }
            inputProps.onKeyDown?.(event)
          }}
        />
        <PaletteList
          listBoxProps={listBoxProps}
          state={state}
          listBoxRef={listBoxRef}
          capabilities={props.capabilities}
          capabilityError={props.capabilityError ?? null}
        />
        {!state.collection.size ? (
          <p className="pal-empty">
            {props.runsLoading
              ? 'Loading runs…'
              : props.runsError
                ? `Runs could not be listed (${props.runsError}) — actions and this run's agents are still here.`
                : `Nothing matches “${query}”.`}
          </p>
        ) : null}
        <p className="pal-foot dim micro">
          ↑↓ move · ↵ run · esc close
          {/* §2.7 promises "jump to ANY run", so a sweep still walking §5.4.2's cursor
              says how far it has got rather than presenting a prefix as the whole list. */}
          {props.runsLoading && (props.runsListed ?? 0) > 0
            ? ` · listing runs (${props.runsListed}${
              props.runsTotal ? ` of ${props.runsTotal}` : ''} so far)`
            : ''}
          {props.runsError ? ' · the run list is incomplete' : ''}
        </p>
      </div>
    </ControlDialog>
  )
}

/**
 * The collection half of the pairing.
 *
 * `useComboBoxState` owns the input value, the open state, the selection manager and the
 * focused key; the collection it builds is the RANKED list, because §2.7's matching is fuzzy
 * and `defaultFilter` is therefore neutralized rather than used. `selectedKey` is held at
 * `null` on purpose: a palette activation is an ACTION, not a selection that persists, and a
 * controlled null is what makes running the same row twice fire twice.
 */
function usePaletteState(
  allRows: Row[],
  props: PaletteProps,
  query: string,
  setQuery: (next: string) => void,
): PaletteState {
  const capabilities = props.capabilities
  const onClose = props.onClose
  const byId = useMemo(() => new Map(allRows.map((row) => [row.id, row])), [allRows])

  const activate = (row: Row | undefined) => {
    if (!row) return
    // §7.2/§7.3: a row the operator may not run is visible, arrow-reachable, and does
    // NOTHING — and in particular it does not close the palette on its way to doing
    // nothing, because a dialog that dismisses itself is the universal signal that
    // something happened. Both gates are checked here, before `onClose`.
    if (rowDisabledReason(row, capabilities) != null) return
    onClose()
    row.run()
  }

  return useComboBoxState<Row>({
    // The collection is the RANKED subset — `rank` is §2.7's fuzzy matcher, and the
    // library's own filter is switched off rather than layered on top of it.
    items: rank(query, allRows),
    children: (row: Row) => <Item key={row.id} textValue={row.text}>{row.text}</Item>,
    inputValue: query,
    onInputChange: setQuery,
    defaultFilter: () => true,
    allowsCustomValue: true,
    allowsEmptyCollection: true,
    menuTrigger: 'focus',
    selectedKey: null,
    onSelectionChange: (key: unknown) => { if (key != null) activate(byId.get(String(key))) },
    'aria-label': 'Search runs, agents and actions',
  } as never)
}

/**
 * The listbox. `useListBox` supplies the role, the label association and the collection
 * plumbing; every element and class below is this repo's, drawn by `control.css`.
 */
function PaletteList(
  { state, listBoxRef, listBoxProps, capabilities, capabilityError }: {
    state: PaletteState
    listBoxRef: RefObject<HTMLUListElement | null>
    listBoxProps: Parameters<typeof useListBox<Row>>[0]
    capabilities: readonly string[] | null
    capabilityError: string | null
  },
) {
  const { listBoxProps: ariaListBoxProps } = useListBox(
    { ...listBoxProps, shouldUseVirtualFocus: true, 'aria-label': 'Commands' },
    state,
    listBoxRef,
  )
  return (
    <ul {...ariaListBoxProps} className="pal-list" ref={listBoxRef}>
      {[...state.collection].map((node) => (
        <PaletteOption
          key={node.key}
          itemKey={node.key as string | number}
          row={node.value}
          state={state}
          capabilities={capabilities}
          capabilityError={capabilityError}
        />
      ))}
    </ul>
  )
}

/** One `role=option`. `useOption` owns selection/press/virtual focus; the row is ours. */
function PaletteOption(
  { itemKey, row, state, capabilities, capabilityError }: {
    itemKey: string | number
    row: Row | null
    state: PaletteState
    capabilities: readonly string[] | null
    capabilityError: string | null
  },
) {
  const ref = useRef<HTMLLIElement>(null)
  const { optionProps, isFocused } = useOption(
    { key: itemKey, shouldUseVirtualFocus: true },
    state,
    ref,
  )
  if (!row) return null

  // The refusal, if any — capability OR run state, one sentence, one source of truth
  // shared with `activate` above.
  const disabled = rowDisabledReason(row, capabilities, capabilityError)
  // An UNKNOWN capability is not a refusal, but it is still worth saying: the control is
  // offered and the server decides (§7.2). So it prints without disabling the row.
  const note = disabled
    ?? (row.capability ? explainCapability(capabilities, row.capability, capabilityError) : null)

  return (
    <li
      {...optionProps}
      ref={ref}
      {...(disabled ? { 'aria-disabled': true } : {})}
      className={`pal-row ${row.kind}${isFocused ? ' on' : ''}${disabled ? ' locked' : ''}`}
    >
      {row.kind === 'action'
        ? <Icon name={row.glyph ?? 'bolt'} size={14} />
        : <StatusGlyph state={row.state ?? 'unknown'} />}
      <span className="pal-text">{row.text}</span>
      <span className="pal-kind">{row.kind}</span>
      {note ? <span className="pal-why">{note}</span> : null}
      {!note && row.hint ? <span className="pal-hint">{row.hint}</span> : null}
    </li>
  )
}

/** §2.7's `?` overlay. Same dialog, same focus contract; it is a reference, not a menu. */
export function ShortcutOverlay(
  { onClose, restoreFocusTo }: { onClose: () => void; restoreFocusTo?: Element | null },
) {
  return (
    <ControlDialog name="shortcuts" size="wide" title="Keyboard" onClose={onClose}
      restoreFocusTo={restoreFocusTo ?? null}
      footer={<button className="btn" type="button" onClick={onClose}>Close</button>}
    >
      <dl className="kb-list">
        {SHORTCUTS.map(([keys, what]) => (
          <div className="kb-row" key={keys}>
            <dt><kbd>{keys}</kbd></dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </ControlDialog>
  )
}

/** §2.7, verbatim — the overlay is only useful if it is the same list the app implements. */
export const SHORTCUTS: [string, string][] = [
  ['j / k', 'move through runs (home) or agents (cockpit)'],
  ['↵', 'open the selection'],
  ['esc', 'close the panel, drawer or dialog'],
  ['[ ]', 'switch cockpit tabs'],
  ['/', 'focus search'],
  ['a', 'focus the first open question’s answer box'],
  ['l', 'toggle the log lane'],
  ['d', 'toggle the theme (ignored while typing)'],
  ['+ / −', 'zoom the timeline'],
  ['?', 'this overlay'],
  ['⌘K / ctrl K', 'command palette — jump to a run or agent, or run an action'],
  ['⌘↵', 'send from a composer'],
]
