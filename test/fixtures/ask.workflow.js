export const meta = { name: 'ask-test', description: 'workflow blocks on operator answer' }

export default async function ({ ask }) {
  const ans = await ask('Which color should the widget be?', { id: 'color' })
  return 'answer:' + ans
}
