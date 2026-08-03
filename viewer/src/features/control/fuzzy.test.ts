// The palette matcher (§2.7 "jump to any run or agent by fuzzy name"), pure.

import { describe, expect, it } from 'vitest'
import { fuzzyMatch, rank } from './fuzzy.js'

describe('§2.7 fuzzy matching', () => {
  it('matches subsequences and refuses non-subsequences', () => {
    expect(fuzzyMatch('ab12', 'flo_ab12')).not.toBeNull()
    expect(fuzzyMatch('judge', 'judge-panel-auth')).not.toBeNull()
    expect(fuzzyMatch('zzz', 'flo_ab12')).toBeNull()
    // Order matters — a bag of characters is not a match.
    expect(fuzzyMatch('21ba', 'flo_ab12')).toBeNull()
  })

  it('is case-insensitive and ignores spaces in the query', () => {
    expect(fuzzyMatch('AB12', 'flo_ab12')).not.toBeNull()
    expect(fuzzyMatch('a b 1 2', 'flo_ab12')).not.toBeNull()
  })

  it('ranks word starts and consecutive runs above scattered hits', () => {
    const [first] = rank('auth', [
      { text: 'a-user-with-hidden-letters' },
      { text: 'judge-panel-auth-refactor' },
    ])
    expect(first!.text).toBe('judge-panel-auth-refactor')
  })

  it('prefers the shorter of two equally good matches', () => {
    const [first] = rank('flo_ab12', [
      { text: 'flo_ab12_compare_panel' },
      { text: 'flo_ab12' },
    ])
    expect(first!.text).toBe('flo_ab12')
  })

  it('keeps the caller’s order when there is no query — actions stay on top', () => {
    const items = [{ text: 'Cancel run' }, { text: 'Toggle theme' }, { text: 'flo_ab12' }]
    expect(rank('', items).map((item) => item.text))
      .toEqual(['Cancel run', 'Toggle theme', 'flo_ab12'])
  })

  it('returns the matched indices so the row can highlight them', () => {
    expect(fuzzyMatch('ab', 'flo_ab12')!.indices).toEqual([4, 5])
  })
})
