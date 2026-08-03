// Append-only mutation audit log (DESIGN §7.3 "Audit log", critique Sol-4).
//
// `$FLOWITION_HOME/viewer-audit.jsonl`, 0600, one JSON object per line:
//   {t, op: 'resume'|'delete'|'cancel'|'args-read', runId, outcome, [reason]}
// No message bodies, no transcript content — this file records that a lifecycle
// mutation happened, never what the run contained.
//
// It lives OUTSIDE the run directory on purpose: "the audit trail is the run itself" is
// false for delete, which destroys the run. It is written by the viewer's lifecycle
// routes (W4/W7) and by `src/retention.js` — and therefore by `flowition rm` and
// `flowition prune`, which are the same destructive operation reached from the CLI.
//
// This module imports node: builtins and `../util.js` only (§11.2 denylist).
import fs from 'node:fs'
import path from 'node:path'
import { home, ensureDir } from '../util.js'

export const auditPath = () => path.join(home(), 'viewer-audit.jsonl')

/**
 * Append one audit record. Throws on any failure — callers whose operation is
 * irreversible (delete) must FAIL CLOSED rather than destroy an unrecorded run.
 *
 * @param {{op: string, runId?: string, outcome: string, reason?: string}} line
 * @returns {string} the exact line written
 */
export function appendAudit(line) {
  ensureDir(home(), 0o700)
  const file = auditPath()
  const record = JSON.stringify({ t: Date.now(), ...line }) + '\n'
  // mode 0o600 applies on creation; the chmod below repairs a file created by an
  // older build (or a wide umask) so the log never becomes world-readable.
  const fd = fs.openSync(file, 'a', 0o600)
  try {
    fs.writeSync(fd, record)
    // The record must be on disk BEFORE the rename it describes: the crash window
    // between "audited" and "deleted" is exactly what this log exists to close.
    try { fs.fsyncSync(fd) } catch { /* fsync unsupported on this fs — the write stands */ }
  } finally {
    fs.closeSync(fd)
  }
  try { fs.chmodSync(file, 0o600) } catch { /* non-posix fs */ }
  return record
}
