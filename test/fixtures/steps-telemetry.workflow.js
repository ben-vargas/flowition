// Single counted side-effect step — the telemetry-crash regression fixture.
// The test makes the engine's success telemetry throw AFTER the completed
// step-result is journaled; the counter file proves the callback never re-ran.
import fs from 'node:fs'

export const meta = { name: 'steps-telemetry', description: 'step(): post-completion telemetry crash must not invalidate the completed record' }

export default async function ({ step, args }) {
  return step('effect', { k: 1 }, () => {
    const c = JSON.parse(fs.readFileSync(args.counterFile, 'utf8'))
    c.effect = (c.effect ?? 0) + 1
    fs.writeFileSync(args.counterFile, JSON.stringify(c))
    return { ran: c.effect }
  })
}
