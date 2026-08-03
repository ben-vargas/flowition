/**
 * The unit's single most important constraint, as a test.
 *
 * DESIGN §4.5 eliminates the classic fold-drift bug (a fold duplicated between
 * client and server, whose two copies diverge) **by construction**: there is one
 * `src/viewer/fold.js` and both consumers import it. A test that only checked behaviour
 * would pass against a copy for exactly as long as the copy stayed in sync — which is the
 * failure mode, not its absence. So this file asserts IDENTITY, not equivalence:
 *
 *   • the SPA's fold module and the server's are the same module object;
 *   • the tree contains exactly one implementation, and it is not under `viewer/`;
 *   • nothing under `viewer/src` reaches around `fold/index.ts` to the shared file.
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import * as shared from '../../../src/viewer/fold.js'
import * as client from './index.js'

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const viewerSrc = path.join(repoRoot, 'viewer', 'src')
const sharedFold = path.join(repoRoot, 'src', 'viewer', 'fold.js')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

describe('the fold is imported, never ported (§4.5)', () => {
  it('the SPA and the server hold the same module object', () => {
    // Reference equality — a copy could match `toEqual` and still be a copy.
    expect(client.fold).toBe(shared.fold)
    expect(client.createFoldState).toBe(shared.createFoldState)
    expect(client.materializeFold).toBe(shared.materializeFold)
    expect(client.deriveCaps).toBe(shared.deriveCaps)
    expect(client.semverGte).toBe(shared.semverGte)
    expect(client.terminalOrStale).toBe(shared.terminalOrStale)
    expect(client.CAP_VERSIONS).toBe(shared.CAP_VERSIONS)
  })

  it('`fold/index.ts` imports the file at `src/viewer/fold.js` and no other', () => {
    const source = readFileSync(path.join(viewerSrc, 'fold', 'index.ts'), 'utf8')
    const specifier = /from '(\.\.\/)+src\/viewer\/fold\.js'/.exec(source)
    expect(specifier, 'fold/index.ts must import the shared module by relative path').toBeTruthy()
    const resolved = path.resolve(path.join(viewerSrc, 'fold'), specifier![0].slice(6, -1))
    expect(realpathSync(resolved)).toBe(realpathSync(sharedFold))
  })

  it('exactly one implementation of the fold exists in the tree', () => {
    const roots = [path.join(repoRoot, 'src'), viewerSrc]
    const definitions = roots
      .flatMap((root) => walk(root))
      .filter((file) => /\.(js|ts|tsx|mjs)$/.test(file))
      // A declaration file emits nothing and cannot BE a second implementation — it is
      // the one next to fold.js, asserted in its own right below (§6.2).
      .filter((file) => !/\.d\.ts$/.test(file))
      .filter((file) => !/\.test\.(ts|tsx|js)$/.test(file))
      .filter((file) => {
        // §6.4's post-pass entry point. `src/events.js` has its own legacy `foldEvents`
        // (the G11-leaking one this design replaces), so the marker has to be specific to
        // the normative fold, not to folding in general.
        const text = readFileSync(file, 'utf8')
        return text.includes('export function materializeFold(')
      })
    expect(definitions.map((f) => path.relative(repoRoot, f))).toEqual(['src/viewer/fold.js'])
  })

  it('no SPA module reaches around the re-export to the shared file', () => {
    const offenders = walk(viewerSrc)
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
      .filter((file) => path.relative(viewerSrc, file) !== path.join('fold', 'index.ts'))
      // Imports only — a prose reference in a comment is documentation, not a second door.
      .filter((file) => /\bfrom\s+'[^']*src\/viewer\/fold\.js'/.test(readFileSync(file, 'utf8')))
    expect(offenders.map((f) => path.relative(viewerSrc, f))).toEqual([])
  })

  /**
   * §6.2's other half, and the reason it is in THIS file: "one implementation" is only half
   * the anti-drift claim if the two sides still hold two copies of the contract. §6.2 puts
   * the canonical declarations "alongside the JS by hand" and has `viewer/src/api/types.ts`
   * RE-EXPORT them. A revision that shipped instead with a parallel copy of every §6.2
   * interface inside `api/types.ts` — plus `as unknown as` casts over the untyped JS in
   * `fold/index.ts` — satisfied the runtime identity test above while the two type surfaces
   * were free to diverge silently, which is exactly the fold-drift bug reappearing in the
   * type domain. These assertions are what make that arrangement fail.
   */
  it('the canonical §6.2 declarations live alongside fold.js and are re-exported, not copied', () => {
    const declarations = path.join(repoRoot, 'src', 'viewer', 'fold.d.ts')
    expect(statSync(declarations).isFile()).toBe(true)
    const dts = readFileSync(declarations, 'utf8')
    for (const name of ['RunDetail', 'AgentView', 'MailView', 'Caps', 'PathSeg', 'FoldState']) {
      expect(dts, `fold.d.ts must declare ${name}`).toMatch(new RegExp(`export (?:interface|type) ${name}\\b`))
    }

    // `api/types.ts` re-exports them and declares only the route-shaped payloads.
    const types = readFileSync(path.join(viewerSrc, 'api', 'types.ts'), 'utf8')
    for (const name of ['RunSummary', 'RunDetail', 'AgentView', 'MailView', 'LogView', 'PhaseView', 'QuestionView', 'StructNode', 'Caps', 'PathSeg', 'RunState', 'AgentState']) {
      expect(types, `api/types.ts must not re-declare the canonical ${name}`)
        .not.toMatch(new RegExp(`export (?:interface|type) ${name}\\b`))
    }
    expect(types).toMatch(/export type \{[\s\S]*?RunDetail[\s\S]*?\} from '\.\.\/fold\/index\.js'/)

    // …and `fold/index.ts` FORWARDS the shared module's values rather than re-declaring
    // each one as a cast over an untyped import, which is what a missing .d.ts forces.
    const index = readFileSync(path.join(viewerSrc, 'fold', 'index.ts'), 'utf8')
    expect(index).toMatch(/export \{[^}]*\bfold,[^}]*\bmaterializeFold,[^}]*\} from '(\.\.\/)+src\/viewer\/fold\.js'/)
    for (const name of ['fold', 'materializeFold', 'deriveCaps', 'createFoldState', 'terminalOrStale', 'semverGte']) {
      expect(index, `${name} must be re-exported, not re-declared as a cast`)
        .not.toMatch(new RegExp(`export const ${name}\\b`))
    }
  })

  it('the shared module stays browser-safe: no imports at all', () => {
    // `fold.js`'s own header promises "no imports, platform globals, or server-only types".
    // If that ever stops holding, the Vite build inherits a node-only dependency and the
    // §11.2 zero-deps denylist is the next thing to break.
    const text = readFileSync(sharedFold, 'utf8')
    expect(/^\s*import\s/m.test(text)).toBe(false)
    expect(/\brequire\(/.test(text)).toBe(false)
    expect(/\b(process|Buffer|__dirname)\b/.test(text)).toBe(false)
  })
})
