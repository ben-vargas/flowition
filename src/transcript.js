// Per-agent conversation stream: <runDir>/agents/<index>.jsonl
// kinds: meta, text, reasoning, tool, tool-result, mail-in, mail-out, status, raw, attempt
//   meta        {index, label, adapter, model, prompt, attempt}  — once per attempt; the
//               prompt is capped at 32 KiB with an explicit "… [+N chars]" marker (E10)
//   tool        {name, input, id?}          — id present when the adapter has tool ids (E11)
//   tool-result {name?, output, isError, toolUseId?}  — joins its call by toolUseId → id,
//               so parallel tool calls pair correctly instead of positionally
//   mail-in     {text, id?}                 — id is the journal mail uuid (E8): the join
//               key across events.jsonl, journal.jsonl and this file
//   mail-out    {text}                      — agent→orchestrator `flowition post` (E8/G14)
//   attempt     {n}                         — 1-based attempt boundary on a resumed index
//               (E9); the English sentinel `status` line stays for old-CLI tail readability
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
