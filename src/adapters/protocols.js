// Stateful parsers that normalize each CLI's JSONL stream into flowition events:
//   {k:'session', id, model?}       provider session/thread id
//   {k:'text'|'reasoning', text}
//   {k:'tool', name, input?} {k:'tool-result', name?, output?, isError?}
//   {k:'usage', input, output, cost?, cumulative?}
//   {k:'result', text, structured?, isError?}            (one per completed turn)
//   {k:'error', message}
// push(obj) is called per parsed JSON line; finish() when the process closes.

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const tokens = (v) => typeof v === 'number' && Number.isFinite(v) ? v : 0

// Every parser exposes:
//   sawTerminal      — the protocol's own completion event was observed
//   terminalRequired — a finish()-synthesized result without sawTerminal is
//                      partial output and must be refused even on exit code 0.
//                      Only opencode legitimately completes at clean EOF.

class ClaudeStreamParser {
  // Claude Code stream-json — also spoken by amp (-x --stream-json) and droid (exec -o stream-json).
  // opts.turnEnd: emit a synthetic turn-end on assistant stop_reason=end_turn — needed for CLIs
  // (amp) that run turns with stdin open but only flush the result event at stdin EOF.
  constructor(opts = {}) { this.lastText = null; this.turnEnd = !!opts.turnEnd; this.sawTerminal = false; this.terminalRequired = true }
  push(m) {
    const out = []
    if (!isRecord(m)) return out
    if (m.type === 'system' && (m.subtype === 'init' || m.session_id)) {
      if (typeof m.session_id === 'string') out.push({ k: 'session', id: m.session_id, model: m.model })
      return out
    }
    if (m.type === 'assistant' && isRecord(m.message) && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (!isRecord(b)) continue
        if (b.type === 'text' && typeof b.text === 'string') { this.lastText = b.text; out.push({ k: 'text', text: b.text }) }
        else if (b.type === 'thinking' && typeof b.thinking === 'string') out.push({ k: 'reasoning', text: b.thinking })
        else if (b.type === 'tool_use' && typeof b.name === 'string') out.push({ k: 'tool', name: b.name, input: JSON.stringify(b.input ?? {}) })
      }
      if (typeof m.session_id === 'string') out.unshift({ k: 'session', id: m.session_id })
      if (this.turnEnd && m.message.stop_reason === 'end_turn' && !m.parent_tool_use_id) {
        this.sawTerminal = true
        out.push({ k: 'turn-end' })
      }
      return out
    }
    if (m.type === 'user' && isRecord(m.message) && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (!isRecord(b)) continue
        if (b.type === 'tool_result') {
          const text = Array.isArray(b.content)
            ? b.content.filter(isRecord).map((c) => typeof c.text === 'string' ? c.text : '').join('')
            : typeof b.content === 'string' ? b.content : ''
          out.push({ k: 'tool-result', output: text, isError: !!b.is_error })
        }
      }
      return out
    }
    if (m.type === 'result') {
      this.sawTerminal = true
      const usage = isRecord(m.usage) ? m.usage : {}
      out.push({
        k: 'usage',
        input: tokens(usage.input_tokens) + tokens(usage.cache_read_input_tokens) + tokens(usage.cache_creation_input_tokens),
        output: tokens(usage.output_tokens),
        cost: m.total_cost_usd,
      })
      out.push({
        k: 'result',
        text: typeof m.result === 'string' ? m.result : this.lastText ?? '',
        structured: m.structured_output ?? m.structured_result,
        isError: !!m.is_error || (typeof m.subtype === 'string' && m.subtype !== 'success'),
      })
      return out
    }
    return out
  }
  finish() { return [] }
}

class CodexJsonlParser {
  // codex exec --json
  constructor() { this.lastMsg = null; this.err = null; this.sawTerminal = false; this.terminalRequired = true }
  push(m) {
    const out = []
    if (!isRecord(m)) return out
    if (m.type === 'thread.started' && typeof m.thread_id === 'string') return [{ k: 'session', id: m.thread_id }]
    if (m.type === 'item.completed' && isRecord(m.item)) {
      const it = m.item
      if (it.type === 'agent_message' && typeof it.text === 'string') { this.lastMsg = it.text; out.push({ k: 'text', text: this.lastMsg }) }
      else if (it.type === 'reasoning' && typeof it.text === 'string') out.push({ k: 'reasoning', text: it.text })
      else if (it.type === 'command_execution' && typeof it.command === 'string') {
        out.push({ k: 'tool', name: 'shell', input: it.command })
        out.push({ k: 'tool-result', name: 'shell', output: it.aggregated_output ?? '', isError: it.status === 'failed' })
      } else if (typeof it.type === 'string') out.push({ k: 'tool', name: it.type, input: JSON.stringify(it).slice(0, 2000) })
      return out
    }
    if (m.type === 'turn.completed') {
      this.sawTerminal = true
      const u = isRecord(m.usage) ? m.usage : {}
      return [{
        k: 'usage',
        input: tokens(u.input_tokens),
        cachedInput: tokens(u.cached_input_tokens),
        output: tokens(u.output_tokens),
        cumulative: true,
      }]
    }
    if (m.type === 'turn.failed' || m.type === 'error') {
      if (m.type === 'turn.failed') this.sawTerminal = true
      this.err = isRecord(m.error) && typeof m.error.message === 'string'
        ? m.error.message
        : typeof m.message === 'string' ? m.message : 'codex turn failed'
      return [{ k: 'error', message: this.err }]
    }
    return out
  }
  finish() {
    if (this.err) return []
    if (this.lastMsg != null) return [{ k: 'result', text: this.lastMsg }]
    return []
  }
}

class OpencodeJsonlParser {
  // opencode run --format json
  constructor() { this.parts = new Map(); this.auto = 0; this.session = null; this.err = null; this.sawTerminal = false; this.terminalRequired = false }
  push(m) {
    const out = []
    if (!isRecord(m)) return out
    const part = isRecord(m.part) ? m.part : {}
    const info = isRecord(m.info) ? m.info : {}
    const sid = m.sessionID ?? part.sessionID ?? info.sessionID
    if (typeof sid === 'string' && !this.session) { this.session = sid; out.push({ k: 'session', id: sid }) }
    const type = m.type ?? part.type
    if (type === 'text') {
      const id = part.id ?? m.id ?? `auto${this.auto++}`
      const text = part.text ?? m.text
      if (typeof text !== 'string') return out
      const prev = this.parts.get(id)
      this.parts.set(id, text)
      if (prev !== text) {
        const delta = typeof prev === 'string' && text.startsWith(prev) ? text.slice(prev.length) : text
        if (delta) out.push({ k: 'text', text: delta })
      }
    } else if (type === 'reasoning') {
      const text = part.text ?? m.text
      if (typeof text === 'string') out.push({ k: 'reasoning', text })
    } else if (type === 'tool' || type === 'tool_use') {
      const st = isRecord(part.state) ? part.state : isRecord(m.state) ? m.state : null
      if (st?.status === 'completed' || st?.status === 'error') {
        out.push({ k: 'tool', name: typeof (part.tool ?? m.tool) === 'string' ? part.tool ?? m.tool : 'tool', input: JSON.stringify(st.input ?? {}).slice(0, 2000) })
        out.push({ k: 'tool-result', output: typeof st.output === 'string' ? st.output : JSON.stringify(st.output ?? ''), isError: st.status === 'error' })
      }
    } else if (type === 'step_finish' || type === 'step-finish') {
      const tok = isRecord(part.tokens) ? part.tokens : isRecord(m.tokens) ? m.tokens : {}
      const cache = isRecord(tok.cache) ? tok.cache : {}
      out.push({
        k: 'usage',
        input: tokens(tok.input) + tokens(cache.read) + tokens(cache.write),
        output: tokens(tok.output) + tokens(tok.reasoning),
        cost: part.cost ?? m.cost,
      })
    } else if (type === 'error') {
      this.err = typeof m.error === 'string' ? m.error.slice(0, 500) : JSON.stringify(m.error ?? m).slice(0, 500)
      out.push({ k: 'error', message: this.err })
    }
    return out
  }
  finish() {
    if (this.err) return []
    const text = [...this.parts.values()].join('\n\n').trim()
    return text ? [{ k: 'result', text }] : []
  }
}

class PiJsonlParser {
  // pi --mode json
  constructor() { this.final = null; this.cur = ''; this.err = null; this.aborted = false; this.sawTerminal = false; this.terminalRequired = true }
  push(m) {
    const out = []
    if (!isRecord(m)) return out
    if (m.type === 'message_update') {
      const ev = isRecord(m.assistantMessageEvent) ? m.assistantMessageEvent : isRecord(m.event) ? m.event : {}
      if (ev.type === 'text_delta') {
        const text = ev.delta ?? ev.text
        if (typeof text === 'string') this.cur += text
      } else if (ev.type === 'thinking_delta' && typeof ev.delta === 'string') out.push({ k: 'reasoning', text: ev.delta })
      else if (ev.type === 'error') { this.err = JSON.stringify(ev).slice(0, 500); out.push({ k: 'error', message: this.err }) }
      return out
    }
    if (m.type === 'agent_end' || m.type === 'session_end') {
      this.sawTerminal = true
      return out
    }
    if (m.type === 'message_end') {
      const msg = isRecord(m.message) ? m.message : {}
      // an assistant message ending in toolUse is an INTERMEDIATE step — only a
      // message that actually stops the agent counts as the terminal event
      if (msg.stopReason && msg.stopReason !== 'toolUse' && msg.stopReason !== 'tool_use') this.sawTerminal = true
      if (msg.role === 'assistant') {
        const text = Array.isArray(msg.content)
          ? msg.content.filter((c) => isRecord(c) && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('')
          : typeof msg.content === 'string' ? msg.content : this.cur
        if (text) { this.final = text; out.push({ k: 'text', text }) }
        this.cur = ''
        const u = isRecord(msg.usage) ? msg.usage : {}
        const cost = isRecord(u.cost) ? u.cost.total : undefined
        out.push({ k: 'usage', input: tokens(u.input) + tokens(u.cacheRead) + tokens(u.cacheWrite), output: tokens(u.output), cost })
      }
      if (msg.stopReason === 'error') { this.err = msg.errorMessage ?? 'pi turn error'; out.push({ k: 'error', message: this.err }) }
      if (msg.stopReason === 'aborted') this.aborted = true
      return out
    }
    if (m.type === 'tool_execution_start') return [{ k: 'tool', name: m.toolName ?? 'tool', input: JSON.stringify(m.args ?? {}).slice(0, 2000) }]
    if (m.type === 'tool_execution_end') return [{ k: 'tool-result', name: m.toolName, output: typeof m.result === 'string' ? m.result : JSON.stringify(m.result ?? '').slice(0, 4000), isError: !!m.isError }]
    return out
  }
  finish() {
    if (this.err || this.aborted) return []
    const text = this.final ?? this.cur
    return text ? [{ k: 'result', text }] : []
  }
}

class DroidJsonlParser {
  // droid exec -o stream-json: system.init / message / tool events / completion
  constructor() { this.lastText = null; this.err = null; this.final = null; this.sawTerminal = false; this.terminalRequired = true }
  push(m) {
    const out = []
    if (!isRecord(m)) return out
    if (m.type === 'system' && typeof m.session_id === 'string') return [{ k: 'session', id: m.session_id, model: m.model }]
    if (m.type === 'message' && m.role === 'assistant' && typeof m.text === 'string' && m.text) {
      this.lastText = m.text
      return [{ k: 'text', text: m.text }]
    }
    if (m.type === 'reasoning' && typeof m.text === 'string' && m.text) return [{ k: 'reasoning', text: m.text }]
    if (m.type === 'tool_use' || m.type === 'tool_call') {
      return [{ k: 'tool', name: m.name ?? m.toolName ?? 'tool', input: JSON.stringify(m.input ?? m.parameters ?? {}).slice(0, 2000) }]
    }
    if (m.type === 'tool_result') {
      return [{ k: 'tool-result', output: typeof m.output === 'string' ? m.output : JSON.stringify(m.output ?? m.result ?? '').slice(0, 4000), isError: !!m.is_error }]
    }
    if (m.type === 'completion') {
      this.sawTerminal = true
      const u = isRecord(m.usage) ? m.usage : {}
      out.push({
        k: 'usage',
        input: tokens(u.input_tokens) + tokens(u.cache_read_input_tokens) + tokens(u.cache_creation_input_tokens),
        output: tokens(u.output_tokens),
      })
      this.final = { k: 'result', text: m.finalText ?? this.lastText ?? '' }
      out.push(this.final)
      return out
    }
    if (m.type === 'error') { this.err = m.message ?? JSON.stringify(m).slice(0, 400); return [{ k: 'error', message: this.err }] }
    return out
  }
  finish() {
    if (this.err || this.final) return []
    return this.lastText != null ? [{ k: 'result', text: this.lastText }] : []
  }
}

export function makeParser(protocol) {
  switch (protocol) {
    case 'claude-stream': return new ClaudeStreamParser()
    case 'claude-stream-eof': return new ClaudeStreamParser({ turnEnd: true })
    case 'codex-jsonl': return new CodexJsonlParser()
    case 'droid-jsonl': return new DroidJsonlParser()
    case 'opencode-jsonl': return new OpencodeJsonlParser()
    case 'pi-jsonl': return new PiJsonlParser()
    default: throw new Error(`unknown protocol: ${protocol}`)
  }
}
