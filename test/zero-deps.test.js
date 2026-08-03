// The §11.2 "zero-deps" row — the structural half of the two invariants that no amount of
// code review can keep true by hand (DESIGN §4.6, §7.4 "Viewer bug → executing a
// workflow", §11.2):
//
//   1. the root package declares NO runtime dependencies — the published runtime path is
//      `node:` builtins and relative imports, and the SPA ships as prebuilt assets;
//   2. `src/viewer/**` imports only `node:` builtins and relative paths, and never
//      `../engine.js`, `../agent-proc.js` or `../adapters/*` (critique N7).
//
// (2) is what makes "no code path in the viewer can execute a workflow" a fact about the
// import graph rather than a promise: `runWorkflow` lives in engine.js, agent processes
// are spawned by agent-proc.js, and provider CLIs are invoked by the adapters. A viewer
// that cannot name those modules cannot reach them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

// §11.2 / critique N7: the engine-side modules the viewer MAY import. Everything else
// under src/ is off limits, so widening this set is a deliberate, reviewable act.
const ALLOWED_ENGINE_IMPORTS = new Set([
  'run-state.js',
  'control.js',
  'util.js',
  'journal.js',
  'events.js',
  'transcript.js',
  'retention.js',
  // §7.3's resume handoff. `installResumeMarker` is the ONE marker protocol the engine,
  // both CLI launchers and retention linearize on, and run-lock.js exists as its own
  // module precisely so the viewer can reach it without naming engine.js (see that
  // file's header). The alternative — a second lookalike copy inside src/viewer/** —
  // is the drift this allowlist is meant to prevent, not an example of it. It imports
  // node: builtins only, so it drags nothing else into the viewer's module graph, and
  // retention.js (already allowed) pulls it in transitively regardless.
  'run-lock.js',
])

const DENIED_ENGINE_IMPORTS = ['engine.js', 'agent-proc.js']

test('the root package declares no runtime dependencies (§4.6)', () => {
  // The exact assertion §4.6 names, plus the three other fields that would also drag a
  // node_modules tree into `npm i -g flowition`.
  assert.equal(pkg.dependencies, undefined, 'root package.json must have no `dependencies`')
  assert.equal(pkg.optionalDependencies, undefined)
  assert.equal(pkg.peerDependencies, undefined)
  assert.equal(pkg.bundleDependencies, undefined)
  assert.equal(pkg.bundledDependencies, undefined)
})

test('the published files list ships the server and the prebuilt SPA (§4.6)', () => {
  assert.ok(Array.isArray(pkg.files), 'package.json#files must be an explicit allowlist')
  for (const entry of ['src', 'bin', 'viewer/dist']) {
    assert.ok(pkg.files.includes(entry), `package.json#files must include "${entry}"`)
  }
  // `src` covers src/viewer/**; viewer/dist must exist to be shipped at all.
  assert.ok(fs.existsSync(path.join(ROOT, 'viewer', 'dist', 'index.html')), 'viewer/dist/index.html must be committed — an installed package would otherwise serve a server with no SPA')
})

test('the viewer suite runs with no viewer/node_modules present (§11.1)', () => {
  // The root suite must pass without the frontend toolchain installed; if it is present
  // locally that is fine, but nothing under src/ may depend on it.
  const modules = path.join(ROOT, 'viewer', 'node_modules')
  const viewerPkgPath = path.join(ROOT, 'viewer', 'package.json')
  if (fs.existsSync(viewerPkgPath)) {
    const viewerPkg = JSON.parse(fs.readFileSync(viewerPkgPath, 'utf8'))
    // §16.1 retires §9.1's numeric dependency count. The root invariant is unchanged and
    // asserted above; viewer/ is private and may use only this reviewed parsing/
    // compatibility allowlist. Exact direct ranges make any change an explicit review
    // rather than an incidental lockfile refresh (§16.7).
    //
    // W12 adds the @react-aria hook packages §16.3 adopts for the interactive primitives,
    // and the @react-stately state hooks they are specified against: §16.3 names "dialog,
    // focus trap/restore, menu, tabs where used, keyboard list navigation, palette", and
    // `useListBox`/`useComboBox`/`useTabList` are hooks OVER a react-stately collection —
    // the state half is not optional, it is the documented input to the aria half.
    //
    // They are BEHAVIOR-only in the sense §16.3 draws the line ("no @adobe/react-spectrum,
    // no component kit, no kit CSS"): they render no elements and ship no stylesheet. The
    // DOM and the classes stay this repo's, drawn by `control.css` and `cockpit.css`.
    //
    // They are NOT free of CSS, and saying so here was wrong twice. The resolved
    // `react-aria` monopackage injects a `<style>` at runtime from exactly two sites —
    // `usePress` (once per document, every platform) and `usePreventScroll` (per modal,
    // iOS only). §16.3 inventories both: site 1 is prevented by `viewer/src/ui/
    // pressableStyle.ts` claiming its element id, site 2 is admitted by the single
    // `'sha256-'` source in §7.1.4's policy and cross-checked below in
    // `test/viewer-http.test.js`. A bump that adds a third site fails the runtime
    // `securitypolicyviolation` gate in `viewer/e2e/viewer.spec.ts`, on both platforms.
    // `viewer/src/features/transcript/packageGraph.test.ts` additionally asserts the kit
    // never enters the resolved tree, and both files pin the versions exactly (§16.7).
    const viewerRuntimeAllowlist = [
      '@react-aria/combobox', '@react-aria/dialog', '@react-aria/focus',
      '@react-aria/listbox', '@react-aria/overlays', '@react-aria/tabs',
      '@react-stately/collections', '@react-stately/combobox', '@react-stately/list',
      '@react-stately/tabs',
      '@tanstack/react-virtual', 'react', 'react-dom', 'react-markdown',
    ]
    assert.deepEqual(
      Object.keys(viewerPkg.dependencies ?? {}).sort(),
      viewerRuntimeAllowlist,
      'viewer/ runtime dependencies must stay inside the reviewed §16.1 allowlist',
    )
    for (const [name, version] of Object.entries(viewerPkg.dependencies ?? {})) {
      assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
        `viewer/ direct dependency "${name}" must use an exact version (§16.7), got "${version}"`)
    }
    const allowedDevDeps = new Set([
      'vite', '@vitejs/plugin-react', 'typescript', 'vitest', 'jsdom',
      '@testing-library/react', '@testing-library/dom',
      // §16.5: browser/a11y hardening only; viewer/ is private and these never ship.
      '@playwright/test', '@axe-core/playwright',
      // Type packages for the three runtime deps; §9.1 lists the toolchain, not its @types.
      '@types/react', '@types/react-dom', '@types/node',
    ])
    for (const [name, version] of Object.entries(viewerPkg.devDependencies ?? {})) {
      assert.ok(allowedDevDeps.has(name), `viewer/ devDependency "${name}" is outside the §9.1 list`)
      if (name === '@playwright/test' || name === '@axe-core/playwright') {
        assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
          `viewer/ browser devDependency "${name}" must use an exact version (§16.7), got "${version}"`)
      }
    }
    assert.equal(viewerPkg.private, true, 'viewer/ must be private — it is never published')
  }
  // Nothing under src/ may reach into it either way.
  assert.ok(!sourceFiles(path.join(ROOT, 'src')).some((file) => fs.readFileSync(file, 'utf8').includes('viewer/node_modules')), `no file under src/ may reference ${modules}`)
})

test('src/viewer/** imports only node: builtins and relative paths', () => {
  const files = sourceFiles(path.join(ROOT, 'src', 'viewer'))
  assert.ok(files.length >= 5, `expected the viewer server modules, found ${files.length}`)

  for (const file of files) {
    const where = path.relative(ROOT, file)
    for (const specifier of importSpecifiers(fs.readFileSync(file, 'utf8'))) {
      const kind = specifier.startsWith('node:') ? 'builtin'
        : specifier.startsWith('./') || specifier.startsWith('../') ? 'relative'
          : 'bare'
      assert.equal(kind !== 'bare', true, `${where} imports the bare specifier "${specifier}" — the server is node: builtins and relative imports only (§4.6)`)
    }
  }
})

test('src/viewer/** never imports the engine, agent-proc, or an adapter (§11.2 denylist)', () => {
  const viewerDir = path.join(ROOT, 'src', 'viewer')
  const srcDir = path.join(ROOT, 'src')
  const files = sourceFiles(viewerDir)

  for (const file of files) {
    const where = path.relative(ROOT, file)
    const source = stripComments(fs.readFileSync(file, 'utf8'))

    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith('node:')) continue
      const resolved = path.resolve(path.dirname(file), specifier)
      if (resolved.startsWith(viewerDir + path.sep)) continue   // viewer-internal

      const relativeToSrc = path.relative(srcDir, resolved)
      assert.ok(!relativeToSrc.startsWith('..'), `${where} imports "${specifier}", which escapes src/`)

      for (const denied of DENIED_ENGINE_IMPORTS) {
        assert.notEqual(relativeToSrc, denied, `${where} imports ${denied} — the viewer must never be able to execute a workflow (§7.4, critique N7)`)
      }
      assert.ok(!relativeToSrc.startsWith(`adapters${path.sep}`), `${where} imports an adapter (${specifier}) — the viewer never invokes a provider CLI (critique N7)`)

      assert.ok(ALLOWED_ENGINE_IMPORTS.has(relativeToSrc), `${where} imports src/${relativeToSrc}, which is not in the §11.2 allowlist [${[...ALLOWED_ENGINE_IMPORTS].join(', ')}]`)
    }

    // Belt and braces on the one symbol the structural claim is about: even a dynamic
    // specifier assembled at runtime would have to name it in code somewhere. (Comments
    // are stripped first — the modules document the rule they obey.)
    assert.ok(!/\brunWorkflow\b/.test(source), `${where} references runWorkflow — no viewer code path may execute a workflow (§7.4)`)
  }
})

// ---- helpers -----------------------------------------------------------------------

function sourceFiles(dir) {
  const out = []
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) out.push(full)
    }
  }
  walk(dir)
  return out.sort()
}

/**
 * Every module specifier a file can load: static `import`/`export … from`, side-effect
 * `import 'x'`, dynamic `import('x')`, and `require('x')` (which would be a bug in an ESM
 * package but must not be a silent one).
 */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')              // block comments
  .replace(/^[ \t]*\/\/.*$/gm, '')               // line comments

function importSpecifiers(source) {
  const stripped = stripComments(source)
  const found = new Set()
  const patterns = [
    /(?:^|[;\n])\s*import\s+(?:[^'";]*?\s+from\s*)?['"]([^'"\n]+)['"]/g,
    /(?:^|[;\n])\s*export\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*['"]([^'"\n]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of stripped.matchAll(pattern)) found.add(match[1])
  }
  return [...found]
}
