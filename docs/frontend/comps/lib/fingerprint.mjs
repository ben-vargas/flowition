// The fingerprints §3.7's built-screen evidence is pinned to, in one place so that the
// producer (`../capture-built.mjs`) and the gate (`test/comps-captures.test.js`) cannot
// disagree about what "fresh" means.
//
// Node builtins only — this is imported by the root test suite, which has no dependencies.

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

export const sha256File = (file) => sha256(fs.readFileSync(file))

/** Every file under `dir`, as sorted POSIX-relative paths. */
export function treeFiles(dir, prefix = '') {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...treeFiles(path.join(dir, entry.name), rel))
    else out.push(rel)
  }
  return out
}

/**
 * One hash over a whole directory: every relative path AND its content, in sorted order.
 * Path-sensitive on purpose — a font that stopped being copied changes the fingerprint
 * even though no surviving file's bytes moved.
 */
export function treeSha256(dir) {
  const h = createHash('sha256')
  for (const rel of treeFiles(dir)) {
    h.update(rel)
    h.update('\0')
    h.update(fs.readFileSync(path.join(dir, rel)))
    h.update('\0')
  }
  return h.digest('hex')
}
