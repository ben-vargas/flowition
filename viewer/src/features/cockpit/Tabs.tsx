/**
 * The cockpit's tab strip (DESIGN §2.4), on React Aria's tab primitives.
 *
 * §16.3 adopts "hooks-level @react-aria/* primitives (dialog, focus trap/restore, menu,
 * **tabs where used**, keyboard list navigation, palette)". Tabs are used here, so the
 * behavior is `useTabListState` + `useTabList` + `useTab` + `useTabPanel` rather than three
 * buttons carrying `aria-selected` by hand. What the hooks own that the hand-wired strip
 * did not:
 *
 *   • **roving tabindex** — one stop in the Tab order for the whole strip, not three (§3.6
 *     asks for exactly this in the run/agent lists, and a tab strip is the same shape);
 *   • **arrow-key navigation with wrap**, plus Home/End, which is what a `role=tablist`
 *     promises an assistive-tech user the moment it claims that role;
 *   • the `aria-controls` / `aria-labelledby` pair between each tab and its panel — the
 *     panel that the hand-wired version never rendered, leaving the relationship implied.
 *
 * `[` and `]` (§2.7) stay the cockpit's own: they are GLOBAL shortcuts that work with focus
 * anywhere on the page, which is a different contract from the arrow keys inside the strip.
 *
 * Appearance is untouched: the same `.tabs` container, the same `<button>` rows, the same
 * `[aria-selected="true"]` CSS selector in `cockpit.css`. §16.3's line is "borrow behavior,
 * not appearance". The panel wrapper is `display: contents` so the ARIA relationship exists
 * without inserting a box into the cockpit's column layout.
 */

import { useRef } from 'react'
import type { ReactNode } from 'react'
import { useTab, useTabList, useTabPanel } from '@react-aria/tabs'
import { Item } from '@react-stately/collections'
import { useTabListState } from '@react-stately/tabs'
import type { TabListState } from '@react-stately/tabs'
import { Icon } from '../../ui/Icon.js'
import type { GlyphName } from '../../ui/icons.js'

export type CockpitTab = 'timeline' | 'structure' | 'agents'

export const TABS: readonly CockpitTab[] = ['timeline', 'structure', 'agents']

const LABEL: Record<CockpitTab, string> = {
  timeline: 'Timeline',
  structure: 'Structure',
  agents: 'Agents',
}
const GLYPH: Record<CockpitTab, GlyphName> = {
  timeline: 'gantt',
  structure: 'tree',
  agents: 'table',
}

interface TabItem { id: CockpitTab }

export function CockpitTabs(
  { tab, onTab, children }: {
    tab: CockpitTab
    onTab: (next: CockpitTab) => void
    /** The selected tab's content. Rendered inside the `role=tabpanel` this pairs it with. */
    children: ReactNode
  },
) {
  const state = useTabListState<TabItem>({
    items: TABS.map((id) => ({ id })),
    children: (item: TabItem) => <Item key={item.id}>{LABEL[item.id]}</Item>,
    selectedKey: tab,
    onSelectionChange: (key) => onTab(String(key) as CockpitTab),
  })
  const listRef = useRef<HTMLDivElement>(null)
  const { tabListProps } = useTabList({ 'aria-label': 'Cockpit views' }, state, listRef)

  return (
    <>
      <div {...tabListProps} ref={listRef} className="tabs">
        {[...state.collection].map((node) => (
          <CockpitTabButton key={node.key} itemKey={String(node.key) as CockpitTab} state={state} />
        ))}
        <div className="kb"><span className="dim micro mono">[ ] to switch</span></div>
      </div>
      {/* React Aria's labelled-panel id is selected-key-specific. Remount when the
          selection changes so useTabPanel cannot retain the first tab's generated id
          while aria-controls advances to a later tab. */}
      <CockpitTabPanel key={tab} state={state}>{children}</CockpitTabPanel>
    </>
  )
}

function CockpitTabButton(
  { itemKey, state }: { itemKey: CockpitTab; state: TabListState<TabItem> },
) {
  const ref = useRef<HTMLButtonElement>(null)
  const { tabProps, isSelected } = useTab({ key: itemKey }, state, ref)
  return (
    <button {...tabProps} ref={ref} type="button" aria-selected={isSelected}>
      <Icon name={GLYPH[itemKey]} size={14} />
      {LABEL[itemKey]}
    </button>
  )
}

/**
 * `display: contents` (see `cockpit.css`): the panel exists for ARIA and for `aria-controls`
 * to point at, and contributes no box — so the three panels lay themselves out inside the
 * cockpit column exactly as they did before the role was added.
 */
function CockpitTabPanel(
  { state, children }: { state: TabListState<TabItem>; children: ReactNode },
) {
  const ref = useRef<HTMLDivElement>(null)
  const { tabPanelProps } = useTabPanel({}, state, ref)
  return (
    <div {...tabPanelProps} ref={ref} className="tabpanel">
      {children}
    </div>
  )
}
