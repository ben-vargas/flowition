// Flagship demo: a cross-provider panel. Four agents from four different CLI
// families answer the same question in parallel with a shared schema; a judge from
// a fifth lane scores them blind and picks a winner.
export const meta = {
  name: 'panel',
  description: 'cross-provider answer panel + blind judge',
  phases: [{ title: 'Answer' }, { title: 'Judge' }],
}

const ANSWER = {
  type: 'object',
  required: ['answer', 'confidence'],
  additionalProperties: false,
  properties: {
    answer: { type: 'string' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
}

const VERDICT = {
  type: 'object',
  required: ['winner', 'ranking', 'reason'],
  additionalProperties: false,
  properties: {
    winner: { type: 'string' },
    ranking: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
  },
}

export default async function ({ agent, parallel, phase, log, args }) {
  const question = args?.question ?? 'In two sentences: what is the single most important property of a good distributed-systems retry policy?'
  const panel = [
    { adapter: 'claude', model: 'claude-sonnet-5', effort: 'low' },
    { adapter: 'codex', model: 'gpt-5.6-sol', effort: 'low' },
    { adapter: 'droid', effort: 'low' },
    { adapter: 'pi' },
  ]

  phase('Answer')
  const answers = await parallel(
    panel.map((p) => () =>
      agent(question, { ...p, schema: ANSWER, label: `answer:${p.adapter}` }),
    ),
  )
  const entries = panel.map((p, i) => ({ adapter: p.adapter, ...answers[i] })).filter((e) => e.answer)
  log(`${entries.length}/${panel.length} panelists answered`)

  phase('Judge')
  const verdict = await agent(
    'You are judging anonymized answers to the question: "' + question + '"\n\n' +
      entries.map((e) => `[${e.adapter}] (confidence ${e.confidence})\n${e.answer}`).join('\n\n') +
      '\n\nRank them best to worst by insight and precision. "winner" and "ranking" entries must be the bracketed ids.',
    { adapter: 'codex', model: 'gpt-5.6-sol', effort: 'medium', schema: VERDICT, label: 'judge' },
  )
  return { question, entries, verdict }
}
