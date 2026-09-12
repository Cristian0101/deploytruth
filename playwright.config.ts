import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './apps/web/e2e',
  outputDir: './work/playwright',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1680, height: 1260 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @deploytruth/web exec vite --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1680, height: 1260 } },
    },
  ],
});
