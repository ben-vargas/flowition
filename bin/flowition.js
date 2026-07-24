#!/usr/bin/env node
import { main } from '../src/cli.js'
main(process.argv.slice(2)).then(
  (code) => process.exit(code ?? 0),
  (err) => {
    // usage/precondition errors print clean; unexpected errors keep their stack
    console.error(err?.constructor?.name === 'WorkflowError' ? `flowition: ${err.message}` : err?.stack || String(err))
    process.exit(1)
  },
)
