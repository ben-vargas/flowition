// Non-JSON step args/results must fail loudly — a malformed value must never
// become a resume key input or a replayable completion record.
export const meta = { name: 'steps-bad', description: 'non-JSON step args/results fail loudly' }

export default async function ({ step, args }) {
  if (args.mode === 'bad-args') return step('bad-args', { fn: () => {} }, () => 'never')
  if (args.mode === 'undefined-args') return step('undefined-args', undefined, () => 'never')
  if (args.mode === 'sparse-args') return step('sparse-args', { list: Array(2) }, () => 'never')
  if (args.mode === 'bad-result') return step('bad-result', {}, () => ({ oops: Number.NaN }))
  if (args.mode === 'bad-result-fn') return step('bad-result-fn', {}, () => () => {})
  throw new Error(`unknown mode ${args.mode}`)
}
