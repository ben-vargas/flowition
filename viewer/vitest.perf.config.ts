import { mergeConfig } from 'vitest/config'
import base from './vite.config.js'

// P6's retained-heap measurement must run in a child Node process that was STARTED with
// --expose-gc. Vitest deliberately filters that flag out of its default worker execArgv,
// so the measured suite uses an explicit fork pool while the ordinary suite keeps its
// faster default worker model.
export default mergeConfig(base, {
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        execArgv: ['--expose-gc'],
      },
    },
  },
})
