// Portable test runner: Node 18/20 do not glob-expand --test patterns and
// cmd.exe does not treat single quotes as quoting, so the file list is
// enumerated here instead of in a shell glob. Zero-dependency by design.
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = readdirSync(path.join(root, 'test'))
  .filter((f) => /\.test\.js$/.test(f))
  .sort()
  .map((f) => path.join('test', f))
const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' })
process.exit(r.status ?? 1)
