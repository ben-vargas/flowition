// W14's release gate for the prebuilt viewer.
//
// Only viewer/dist ships in the root package. Build into a temporary directory so this
// check never "fixes" a stale committed tree, then compare the complete file set and
// every byte. The same fresh output is checked against the CSP contract: no inline
// script/style elements, and no style= attributes in HTML or SVG assets.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const viewerRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const committedRoot = path.join(viewerRoot, 'dist')
const viteBin = path.join(viewerRoot, 'node_modules', 'vite', 'bin', 'vite.js')
const scratchRoot = mkdtempSync(path.join(tmpdir(), 'flowition-dist-check-'))
let failure = null

try {
  const build = spawnSync(
    process.execPath,
    [viteBin, 'build', '--outDir', scratchRoot, '--emptyOutDir', '--logLevel', 'error'],
    {
      cwd: viewerRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production' },
    },
  )
  if (build.error) fail(`could not run the viewer build: ${build.error.message}`)
  if (build.status !== 0) fail(`viewer build failed:\n${build.stderr || build.stdout}`)

  const committed = fileTree(committedRoot)
  const fresh = fileTree(scratchRoot)
  for (const required of ['index.html', 'app.js', 'app.css', 'boot-theme.js']) {
    if (!fresh.includes(required)) fail(`clean viewer build is missing ${required}`)
  }
  for (const relative of fresh) {
    if (statSync(path.join(scratchRoot, relative)).size === 0) {
      fail(`clean viewer build produced an empty artifact: ${relative}`)
    }
  }
  if (JSON.stringify(committed) !== JSON.stringify(fresh)) {
    fail(
      'viewer/dist file set is stale\n'
      + `committed: ${committed.join(', ')}\n`
      + `fresh:     ${fresh.join(', ')}`,
    )
  }

  const changed = fresh.filter((relative) => {
    const oldBytes = readFileSync(path.join(committedRoot, relative))
    const newBytes = readFileSync(path.join(scratchRoot, relative))
    return !oldBytes.equals(newBytes)
  })
  if (changed.length) {
    fail(
      `viewer/dist is stale; clean build differs in:\n  ${changed.join('\n  ')}\n`
      + 'run `npm --prefix viewer run build` and commit viewer/dist',
    )
  }

  assertNoInlineAssets(scratchRoot, fresh)
  assertNoInlineAssets(committedRoot, committed)
  process.stdout.write(`viewer/dist verified: ${fresh.length} files are fresh and CSP-compatible\n`)
} catch (err) {
  failure = err
} finally {
  rmSync(scratchRoot, { recursive: true, force: true })
}
if (failure) {
  process.stderr.write(`check-dist: ${failure.message}\n`)
  process.exitCode = 1
}

function fileTree(root, prefix = '') {
  const out = []
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch (err) {
    fail(`cannot read ${root}: ${err.message}`)
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...fileTree(path.join(root, entry.name), relative))
    else if (entry.isFile()) out.push(relative)
    else fail(`viewer dist contains a non-file artifact: ${relative}`)
  }
  return out
}

function assertNoInlineAssets(root, files) {
  for (const relative of files) {
    if (!/\.(?:html|svg)$/i.test(relative)) continue
    const source = readFileSync(path.join(root, relative), 'utf8')
    if (/<script\b(?![^>]*\bsrc\s*=)[^>]*>/i.test(source)) {
      fail(`${relative} contains an inline <script>; the shipped CSP allows script-src 'self' only`)
    }
    if (/<style(?:\s|>)/i.test(source)) {
      fail(`${relative} contains an inline <style>; the shipped CSP allows style-src 'self' only`)
    }
    if (/\sstyle\s*=/i.test(source)) {
      fail(`${relative} contains a style= attribute; the shipped CSP allows style-src 'self' only`)
    }
  }
}

function fail(message) {
  throw new Error(message)
}
