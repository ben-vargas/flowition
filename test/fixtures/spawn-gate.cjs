// Preloaded into a spawned flowition process (NODE_OPTIONS=--require) to hold it at
// process start — before any flowition code runs — until the file named by
// FLOWITION_TEST_GATE exists. A test that launches a REAL detached engine through the
// shipped launcher can then decide exactly when that engine begins, instead of racing
// its boot time against whatever the test is doing meanwhile.
//
// CommonJS because --require is the only preload flag Node 18.17 accepts.
'use strict'
const fs = require('node:fs')

const gate = process.env.FLOWITION_TEST_GATE
if (gate) {
  // anything this process spawns runs unheld
  delete process.env.FLOWITION_TEST_GATE
  const nap = new Int32Array(new SharedArrayBuffer(4))
  // A gate the test never opens (it failed before reaching that point) must not leave
  // the child parked forever. Giving up exits before any flowition code has run, so a
  // held child that times out has touched nothing.
  const deadline = Date.now() + 60_000
  while (!fs.existsSync(gate)) {
    if (Date.now() > deadline) {
      process.stderr.write(`spawn-gate: ${gate} was never opened\n`)
      process.exit(70)
    }
    Atomics.wait(nap, 0, 0, 5)
  }
}
