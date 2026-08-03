// W14's published-package manifest gate. `npm pack --dry-run --json` applies npm's real
// files/include rules without creating a tarball, so this catches a package.json entry
// that looks plausible but does not actually ship the viewer.
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const viewerRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const root = path.dirname(viewerRoot)
const npmCli = process.env.npm_execpath
const command = npmCli ? process.execPath : (process.platform === 'win32' ? 'npm.cmd' : 'npm')
const args = npmCli
  ? [npmCli, 'pack', '--dry-run', '--json', '--ignore-scripts']
  : ['pack', '--dry-run', '--json', '--ignore-scripts']
const packed = spawnSync(command, args, { cwd: root, encoding: 'utf8' })

if (packed.error) fail(`could not run npm pack: ${packed.error.message}`)
if (packed.status !== 0) fail(`npm pack failed:\n${packed.stderr || packed.stdout}`)

let report
try {
  report = JSON.parse(packed.stdout)
} catch {
  fail(`npm pack did not return JSON:\n${packed.stdout}`)
}

const files = new Set(report?.[0]?.files?.map((entry) => entry.path))
if (!files.size) fail('npm pack returned an empty file manifest')

const requiredFiles = [
  ...fileTree(path.join(root, 'viewer', 'dist')).map((relative) => `viewer/dist/${relative}`),
  ...fileTree(path.join(root, 'src', 'viewer')).map((relative) => `src/viewer/${relative}`),
]
for (const required of requiredFiles) {
  if (!files.has(required)) fail(`published package is missing ${required}`)
}

for (const unwanted of files) {
  if (unwanted === 'viewer/package.json' || unwanted.startsWith('viewer/src/')
      || unwanted.startsWith('viewer/node_modules/')) {
    fail(`published package unexpectedly includes the private viewer workspace: ${unwanted}`)
  }
}

process.stdout.write(`npm pack verified: ${files.size} files include viewer/dist and src/viewer\n`)

function fileTree(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...fileTree(path.join(dir, entry.name), relative))
    else if (entry.isFile()) out.push(relative)
  }
  return out.sort()
}

function fail(message) {
  process.stderr.write(`check-package: ${message}\n`)
  process.exit(1)
}
