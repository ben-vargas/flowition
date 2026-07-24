import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { controlRequest, serveControl } from '../src/control.js'

const makeSocket = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-control-'))
  return { dir, sockPath: path.join(dir, 'control.sock') }
}

const removeDir = (dir) => fs.rmSync(dir, { recursive: true, force: true })

test('ready resolves once the control socket is listening', async () => {
  const { dir, sockPath } = makeSocket()
  const control = serveControl(sockPath, async () => ({ ok: true }))
  try {
    await control.ready
    assert.equal((await controlRequest(sockPath, { cmd: 'status' })).ok, true)
  } finally {
    await control.close()
    removeDir(dir)
  }
})

test('a second control server rejects while the first is live', async () => {
  const { dir, sockPath } = makeSocket()
  const first = serveControl(sockPath, async () => ({ ok: true }))
  let second
  try {
    await first.ready
    second = serveControl(sockPath, async () => ({ ok: true }))
    await assert.rejects(second.ready, /run already active/)
  } finally {
    await second?.close()
    await first.close()
    removeDir(dir)
  }
})

test('a stale socket file is removed and rebound', async () => {
  const { dir, sockPath } = makeSocket()
  const child = spawn(process.execPath, [
    '-e',
    "require('node:net').createServer().listen(process.argv[1], () => process.send('ready'))",
    sockPath,
  ], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  await once(child, 'message')
  child.kill('SIGKILL')
  await once(child, 'exit')
  assert.equal(fs.statSync(sockPath).isSocket(), true)
  const control = serveControl(sockPath, async () => ({ ok: true }))
  try {
    await control.ready
    assert.equal(fs.statSync(sockPath).isSocket(), true)
    assert.equal((await controlRequest(sockPath, { cmd: 'status' })).ok, true)
  } finally {
    await control.close()
    removeDir(dir)
  }
})

test('close promptly terminates an idle connected client', async () => {
  const { dir, sockPath } = makeSocket()
  const control = serveControl(sockPath, async () => ({ ok: true }))
  let client
  try {
    await control.ready
    client = net.createConnection(sockPath)
    client.on('error', () => {})
    await once(client, 'connect')
    const closed = new Promise((resolve) => client.once('close', resolve))
    let timer
    await Promise.race([
      Promise.all([control.close(), closed]),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('idle client remained connected')), 1000)
      }),
    ]).finally(() => clearTimeout(timer))
  } finally {
    client?.destroy()
    await control.close()
    removeDir(dir)
  }
})
