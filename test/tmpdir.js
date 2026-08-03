// Temp roots for on-disk WORKFLOW fixtures.
//
// A workflow file is an ES module, and Node decides that from the nearest package.json:
// a `.js` file with no `"type": "module"` in scope is parsed as CommonJS, where `export`
// and `import` are syntax errors. Node >= 22.7 hides this behind automatic syntax
// detection; the declared floor is Node 18.17 (root package.json `engines`), where it
// does not, and a fixture written straight into `os.tmpdir()` — outside every package
// scope — fails to load with exactly the diagnosis src/engine.js prints:
//
//   workflow files are ES modules, but Node parsed this .js file as CommonJS;
//   add "type": "module" to a package.json next to the workflow or rename it to .mjs
//
// That message IS the supported contract (core-fixes.test.js's `cjsscope` case pins it
// verbatim), so the fixtures honour it instead of relying on a newer Node's leniency:
// every temp fixture root declares its own module scope, on every supported Node.
//
// NOT for a `FLOWITION_HOME` — a run store is not a package, and nothing under it is
// ever imported.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * `fs.mkdtempSync` under `os.tmpdir()`, plus the `{"type":"module"}` package.json that
 * makes `.js` fixtures inside it (at any depth) load as ESM on Node 18.17 and up.
 */
export function tmpEsmDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "type": "module" }\n')
  return dir
}
