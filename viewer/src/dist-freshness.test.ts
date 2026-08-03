// `viewer/dist` is COMMITTED and SHIPPED (DESIGN §4.6 — the root package's `files` list
// carries it, and `npm i -g flowition` gets no toolchain, so what is committed here is
// literally what installed users run). §4.6 names the cost of that decision and the
// defense against it: "stale dist can silently ship an old UI → neutralized by a CI job
// that rebuilds and fails on hash mismatch with the committed dist".
//
// This is that hash comparison, as a test rather than only as a CI job (W14 still owns the
// CI wiring). It exists because the failure it catches ALREADY HAPPENED: round 2 fixed two
// defects in `src/` and shipped a `dist/` built before the fix, so installed users received
// the bugs the commit claimed to have fixed while every other test stayed green. No test
// could see it, because every other test reads `src/`.
//
// It performs a real clean `vite build` into a throwaway directory and byte-compares the
// whole output tree against the committed one. Two properties make that sound rather than
// flaky, both verified before this test was written:
//   • the build is deterministic — two consecutive builds of the same tree are
//     byte-identical (stable asset names, no content hashes, no timestamps injected);
//   • it is deterministic ACROSS RUNTIMES — Node 18.17.1 (the `engines` floor) and Node 24
//     produce identical bytes, so the suite's dual-runtime run cannot disagree with itself.
// If either ever stops holding, this test is the thing that says so, loudly, instead of a
// stale bundle shipping quietly.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const viewerRoot = fileURLToPath(new URL('..', import.meta.url))
const committed = path.join(viewerRoot, 'dist')
const viteBin = path.join(viewerRoot, 'node_modules', 'vite', 'bin', 'vite.js')

/** Every file under `dir`, as repo-style relative POSIX paths, sorted. */
function tree(dir: string, prefix = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...tree(path.join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}

const sha = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

let scratch: string | null = null
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

describe('the committed viewer/dist (§4.6)', () => {
  it('is exactly what the current source builds — a stale bundle is what ships', () => {
    scratch = mkdtempSync(path.join(tmpdir(), 'flowition-dist-'))
    const build = spawnSync(
      process.execPath,
      [viteBin, 'build', '--outDir', scratch, '--logLevel', 'error'],
      {
        cwd: viewerRoot,
        encoding: 'utf8',
        // `NODE_ENV` is PINNED, not inherited. Vitest sets `NODE_ENV=test` in its workers,
        // and that value reaches the React plugin's `process.env.NODE_ENV` substitution —
        // a build under it emits development React (515 KB, warnings and all) and would
        // report an up-to-date dist as stale on every run. A production build is the thing
        // being compared, so it is stated rather than inherited.
        env: { ...process.env, NODE_ENV: 'production' },
      },
    )
    // A build that failed must fail the test, not vacuously pass it by comparing nothing.
    expect(build.error ?? null).toBe(null)
    expect(build.status, `vite build failed:\n${build.stderr}`).toBe(0)

    const fresh = tree(scratch)
    expect(fresh).toContain('app.js')
    expect(fresh).toContain('app.css')
    expect(fresh).toContain('index.html')

    // The file SET first: a font or a boot script that stopped being copied is as broken as
    // a stale bundle, and comparing hashes alone would miss the ones that vanished.
    expect(tree(committed)).toEqual(fresh)

    // No empty artifact — a truncated write is the one corruption a hash comparison would
    // report as "matching" if both sides were truncated the same way.
    for (const rel of fresh) expect(statSync(path.join(committed, rel)).size).toBeGreaterThan(0)

    const stale = fresh.filter((rel) => sha(path.join(committed, rel)) !== sha(path.join(scratch!, rel)))
    expect(
      stale,
      `viewer/dist is stale — these files differ from a clean build of the current source:\n`
      + `  ${stale.join('\n  ')}\n`
      + `Rebuild and commit it:  npm --prefix viewer run build\n`
      + `(§4.6: dist is committed and shipped, so a stale file here is what installed users run.)`,
    ).toEqual([])
  }, 180_000)
})
