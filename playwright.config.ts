import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test/ui',
  timeout: 120000,
  workers: 1,
  use: {
    actionTimeout: 10000,
    baseURL: 'http://127.0.0.1:1420',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run ui:dev',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: false,
    timeout: 20000,
  },
});
