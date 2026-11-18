import { defineConfig } from '@playwright/test'
const evidence = process.env.MJSTATS_BROWSER_EVIDENCE ?? '../.local/browser-results'

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  outputDir: evidence,
  reporter: [
    ['list'],
    ['json', { outputFile: `${evidence}.json` }],
  ],
  use: {
    actionTimeout: 15_000,
    baseURL: 'http://localhost:3000',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
})
