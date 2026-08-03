import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'transcript.css'), 'utf8')

describe('two-panel compare operator ruling', () => {
  it('is side-by-side at the desktop layout', () => {
    expect(css).toMatch(/compare-panes\[data-layout="side-by-side"\][\s\S]*grid-template-columns:\s*repeat\(2/)
  })

  it('uses the single 899px max boundary and stacks full-width panes below it', () => {
    const narrow = css.slice(css.indexOf('@media (max-width: 899px)'))
    expect(narrow).toContain('grid-template-columns: minmax(0, 1fr)')
    expect(narrow).toContain('border-top: 3px solid')
    expect(css).not.toContain('@media (max-width: 900px)')
  })
})
