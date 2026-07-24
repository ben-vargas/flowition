// Per-agent conversation stream: <runDir>/agents/<index>.jsonl
// kinds: meta, text, reasoning, tool, tool-result, mail-in, mail-out, status, raw
import path from 'node:path'
import fs from 'node:fs'
import { ensureDir, truncate } from './util.js'

export class Transcript {
  constructor(runDirPath, index, { fresh = true } = {}) {
    const dir = path.join(runDirPath, 'agents')
    ensureDir(dir)
    this.file = path.join(dir, `${index}.jsonl`)
    if (fresh) fs.writeFileSync(this.file, '')
  }
  write(kind, obj = {}) {
    const rec = { t: Date.now(), kind, ...obj }
    if (typeof rec.text === 'string') rec.text = truncate(rec.text, 32768)
    if (typeof rec.output === 'string') rec.output = truncate(rec.output, 32768)
    if (typeof rec.input === 'string') rec.input = truncate(rec.input, 8192)
    fs.appendFileSync(this.file, JSON.stringify(rec) + '\n')
  }
}
