#!/usr/bin/env node
// Record a §3.7 comp ruling in `approvals.json` — the human reviewer's one command.
//
// §3.7 makes human approval of the reference comps the entry gate for W8, and the
// implementation lane cannot issue that ruling on the reviewer's behalf: a lane that
// approved its own comps would be the gate approving itself, and `test/comps-captures.
// test.js` deliberately refuses to synthesize it. What the lane CAN do is make recording a
// real ruling cost one command instead of a hand-edit of a 200-line JSON file that has
// four separate consistency rules a test enforces.
//
//   node docs/frontend/comps/approve.mjs --list
//   node docs/frontend/comps/approve.mjs home-800 --by "Ben Vargas" --in "review round 6"
//   node docs/frontend/comps/approve.mjs all --by "Ben Vargas" --in "review round 6"
//
// It sets `status`, `decidedBy` and `decidedIn` on each named composition, drops the
// pending-only routing fields, and rewrites `entryGate` so the committed tally is the real
// one. It refuses to approve an id that does not exist, and it never invents an approver:
// `--by` and `--in` are required, and `--in` is meant to be evidence a reader can follow
// (a review round, a PR comment, a dated sign-off), not the word "approved".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(HERE, 'approvals.json');

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const ids = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

const ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
const all = ledger.compositions;

const die = (msg) => { process.stderr.write(`approve: ${msg}\n`); process.exit(1); };

if (argv.includes('--list') || argv.length === 0) {
  for (const c of all) {
    const mark = c.status === 'approved' ? '✔' : '·';
    const who = c.status === 'approved' ? `${c.decidedBy} — ${c.decidedIn}` : 'awaiting a ruling';
    process.stdout.write(`  ${mark} ${c.id.padEnd(26)} ${String(c.viewport).padStart(4)}  ${who}\n`);
  }
  const left = all.filter((c) => c.status !== 'approved').length;
  process.stdout.write(`\n  ${left} of ${all.length} outstanding. ${ledger.entryGate.split('.')[0]}.\n`);
  process.exit(0);
}

const by = flag('by');
const where = flag('in');
if (!by || !where) die('both --by "<name>" and --in "<where it was decided>" are required');

const targets = ids.includes('all')
  ? all.filter((c) => c.status !== 'approved')
  : ids.map((id) => all.find((c) => c.id === id) ?? die(`no composition "${id}" in the ledger`));
if (targets.length === 0) die('nothing to approve — every composition is already approved');

for (const entry of targets) {
  entry.status = 'approved';
  entry.decidedBy = by;
  entry.decidedIn = where;
  // Pending-only routing. `why` and `decide` stay: they are the record of WHAT was ruled on.
  delete entry.blocks;
  delete entry.howToApprove;
}

const outstanding = all.filter((c) => c.status !== 'approved');
ledger.entryGate = outstanding.length === 0
  ? `PASSED — all ${all.length} of §3.7's compositions (four canonical states × two viewports) `
    + 'are approved. The most recent ruling was recorded by '
    + `${by} in ${where}. Each entry carries its own decidedBy/decidedIn.`
  : `UNPASSED — ${outstanding.length} of ${all.length} compositions are comped and awaiting the `
    + `reviewer's ruling (${outstanding.map((c) => c.id).join(', ')}). §3.7 makes approval the `
    + 'entry gate for W8. Run `node docs/frontend/comps/approve.mjs <id…> --by "<name>" '
    + '--in "<where it was decided>"` for each, or `all` for the rest.';

fs.writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
process.stdout.write(
  `approve: recorded ${targets.length} ruling(s) by ${by} (${where}).\n`
  + `         ${outstanding.length} of ${all.length} still outstanding.\n`
  + '         Verify with:  node scripts/test.mjs\n',
);
