import { defineConfig } from '@playwright/test';

const PORT = 8787;

export default defineConfig({
  testDir: 'tests',
  workers: 1, // one local Worker + shared DO/KV state
  timeout: 60_000,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  webServer: {
    command: `npx wrangler dev --port ${PORT} --persist-to .wrangler/test-state`,
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
