import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 0,
  outputDir: '../.local/browser-results',
  reporter: [
    ['list'],
    ['json', { outputFile: '../.local/browser-results.json' }],
  ],
  use: {
    actionTimeout: 15_000,
    baseURL: 'http://localhost:3000',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
})
