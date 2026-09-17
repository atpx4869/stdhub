import { defineConfig, devices } from 'playwright/test';
import { existsSync } from 'node:fs';

const installedChrome = process.platform === 'win32' && existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : undefined;

export default defineConfig({
  testDir: './e2e',
  testIgnore: 'library-history-layout.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: {
    command: 'npx tsx e2e/server.ts',
    url: 'http://127.0.0.1:4173/api/health',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: installedChrome ? { executablePath: installedChrome } : {} } }],
});
