import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AgentJob } from '../src/agent-proc.js'
import { Journal } from '../src/journal.js'
import { Transcript } from '../src/transcript.js'
import { readJsonl } from '../src/util.js'

test('queued mail is declared dropped when the provider cannot follow up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowition-mail-drop-'))
  const journal = new Journal(dir)
  const transcript = new Transcript(dir, 0)
  let startTurn
  let finishTurn
  const turnStarted = new Promise((resolve) => { startTurn = resolve })
  const turnFinished = new Promise((resolve) => { finishTurn = resolve })
  const adapter = {
    name: 'no-resume',
    protocol: 'direct',
    caps: { steer: 'turn', resume: false, schema: 'prompt', selfSession: false },
    async direct() {
      startTurn()
      await turnFinished
      return { text: 'genuine result' }
    },
  }
  const job = new AgentJob({
    adapter,
    spec: {},
    prompt: 'work',
    index: 0,
    key: 'mail-drop-key',
    label: 'mail-drop',
    runId: 'mail-drop-run',
    scratch: dir,
    transcript,
    journal,
  })

  const executing = job.execute()
  await turnStarted
  assert.equal(job.send('late guidance'), 'queued')
  assert.equal(job.send('later guidance'), 'queued')
  finishTurn()

  assert.deepEqual(await executing, { text: 'genuine result', structured: undefined })
  const entries = readJsonl(journal.file)
  const mail = entries.filter((e) => e.type === 'mail')
  assert.deepEqual(mail.map((e) => e.text), ['late guidance', 'later guidance'])
  for (const item of mail) {
    assert.ok(entries.some((e) => e.type === 'mail-done' && e.key === item.key && e.id === item.id), 'drop journaled as done')
  }
  assert.equal(Journal.load(dir).pendingMail.get('mail-drop-key')?.length ?? 0, 0)

  const statuses = readJsonl(transcript.file).filter((e) => e.kind === 'status')
  for (const text of ['late guidance', 'later guidance']) {
    assert.ok(statuses.some((e) =>
      e.text.includes('DROPPED undelivered') &&
      e.text.includes('provider session cannot take a follow-up turn') &&
      e.text.includes(text),
    ))
  }
})
