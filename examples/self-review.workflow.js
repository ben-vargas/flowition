// Dogfood: flowition reviews itself. Three codex (gpt-5.6-sol, xhigh) reviewers sweep
// disjoint areas of the codebase in parallel; a fourth merges, dedupes, and ranks.
export const meta = {
  name: 'self-review',
  description: 'codex xhigh code review of the flowition codebase',
  phases: [{ title: 'Review' }, { title: 'Synthesize' }],
}

const FINDINGS = {
  type: 'object',
  required: ['summary', 'findings'],
  additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        // codex native schema mode uses OpenAI strict structured outputs: every
        // property must be required; optionality is expressed as nullable types.
        required: ['severity', 'file', 'line', 'title', 'detail', 'fix'],
        additionalProperties: false,
        properties: {
          severity: { enum: ['critical', 'high', 'medium', 'low'] },
          file: { type: 'string' },
          line: { type: ['number', 'null'] },
          title: { type: 'string' },
          detail: { type: 'string' },
          fix: { type: ['string', 'null'] },
        },
      },
    },
  },
}

const AREAS = [
  {
    key: 'core',
    scope: 'src/engine.js, src/agent-proc.js, src/keys.js, src/journal.js, src/semaphore.js',
    focus: 'run lifecycle, resume-key determinism and replay correctness, the AgentJob multi-turn loop (schema-corrective and queued-mail turns), steering/stdin lifecycle, cancellation, budget accounting, concurrency, race conditions',
  },
  {
    key: 'adapters',
    scope: 'src/adapters/index.js, src/adapters/protocols.js, src/adapters/mock.js',
    focus: 'argv construction per CLI, stream-parser correctness and resilience to malformed/partial events, session-id capture, amp agent-mode discovery/resolution, effort mappings, temp-file hygiene',
  },
  {
    key: 'surface',
    scope: 'src/cli.js, src/control.js, src/mcp.js, src/events.js, src/transcript.js, src/schema.js, src/util.js, bin/flowition.js',
    focus: 'CLI argument handling, control-socket protocol robustness (partial writes, concurrent clients, stale sockets), MCP correctness, the mini JSON Schema validator vs its documented subset, journal/event file integrity, error reporting',
  },
]

export default async function ({ agent, parallel, phase, log }) {
  const cwd = process.cwd()

  phase('Review')
  const reviews = await parallel(
    AREAS.map((a) => () =>
      agent(
        `You are reviewing "flowition", a zero-dependency Node ESM multi-CLI agent workflow engine, at ${cwd}. ` +
          `Read ARCHITECTURE.md first for intent, then deeply review these files: ${a.scope}\n` +
          `Focus: ${a.focus}\n` +
          `Rules: read the actual code before claiming anything; report only defects you can point to (bugs, races, resource leaks, protocol misuse, silent data loss, misleading docs) — not style. ` +
          `Severity: critical = corrupts state or wrong results; high = breaks a advertised feature in a realistic path; medium = edge-case breakage or operational hazard; low = minor. ` +
          `Do NOT modify any files. Cite file and line for every finding.`,
        { adapter: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', schema: FINDINGS, label: `review:${a.key}`, cwd },
      ),
    ),
  )
  const ok = reviews.map((r, i) => ({ area: AREAS[i].key, report: r })).filter((x) => x.report)
  log(`${ok.length}/${AREAS.length} reviewers reported, ${ok.flatMap((x) => x.report.findings).length} raw findings`)

  phase('Synthesize')
  const merged = await agent(
    `Three independent reviewers examined the flowition codebase at ${cwd}. Merge their reports: dedupe overlapping findings, ` +
      `verify any finding you doubt by reading the cited code, drop anything that does not hold up, and re-rank by severity. ` +
      `Do NOT modify any files.\n\n` +
      ok.map((x) => `=== Reviewer ${x.area} ===\n${JSON.stringify(x.report, null, 2)}`).join('\n\n'),
    { adapter: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh', schema: FINDINGS, label: 'synthesize', cwd },
  )
  return merged
}
