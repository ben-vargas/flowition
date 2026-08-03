// The close→rebind race that Linux CI found on first contact (macOS structurally cannot
// see it): `serveControl`'s cleanup used to unlink its socket in the server's async
// close callback. A successor bind at the same path — exactly what a resume does right
// after a completed run — could land before that callback, and on filesystems that
// recycle inode numbers (ext4) the freed inode lands on the successor's file, so the
// dev/ino "is it still mine" guard blessed deleting the successor's LIVE socket:
// "control socket disappeared after listen". APFS allocates inode numbers
// monotonically, which is why every macOS run of this suite stayed green.
//
// The fix unlinks synchronously at close() initiation, while the call still owns the
// path. This test drives the exact interleave: close (NOT awaited) then an immediate
// rebind, repeatedly — on a pre-fix ext4 this fails within a handful of cycles.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { serveControl, controlRequest } from '../src/control.js'

test('close-then-immediate-rebind never loses the successor socket, on any filesystem', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-rebind-'))
  const sock = path.join(dir, 'control.sock')
  let previous = null
  const settles = []
  for (let cycle = 0; cycle < 25; cycle++) {
    if (previous) settles.push(previous.close())   // deliberately not awaited: the race window
    const server = serveControl(sock, async () => ({ ok: true, cycle }))
    await server.ready
    // The successor's socket file must exist and answer — the pre-fix failure mode was
    // either the ready throw ("disappeared after listen") or a bound server whose path
    // a stale predecessor cleanup had already deleted.
    assert.equal(fs.lstatSync(sock).isSocket(), true, `cycle ${cycle}: socket file present`)
    const res = await controlRequest(sock, { op: 'ping' })
    assert.equal(res.cycle, cycle, `cycle ${cycle}: the LIVE server answers, not a ghost`)
    previous = server
  }
  await previous.close()
  await Promise.all(settles)
  fs.rmSync(dir, { recursive: true, force: true })
})
