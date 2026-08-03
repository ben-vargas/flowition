import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    reducedMotion: 'reduce',
  },
  // One browser, but NOT one platform: `viewer.spec.ts` scopes a mobile viewport, touch
  // flags and an `iPhone` `navigator.platform` to the §7.1.4 iOS describe with `test.use`,
  // because react-aria's second style injection (`usePreventScroll`) is reachable on no
  // other platform. Anything platform-conditional belongs in a describe like that one, not
  // in a suite that silently only ever ran at 1280×720 on a Mac platform string.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  outputDir: 'test-results',
})
