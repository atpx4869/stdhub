import { defineConfig } from 'playwright/test';
import { existsSync } from 'node:fs';

const installedChrome = process.platform === 'win32' && existsSync('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
  ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
  : process.platform === 'win32' && existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : undefined;
const executablePath = process.env.STDHUB_PLAYWRIGHT_EXECUTABLE_PATH || installedChrome;
const reuseExistingServer = process.env.STDHUB_REUSE_MOCK_SERVER === '1';

export default defineConfig({
  testDir: './e2e',
  testMatch: 'library-history-layout.spec.ts',
  timeout: 30_000,
  fullyParallel: false,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: `"${process.execPath}" e2e/ui-mock-server.cjs`,
    url: 'http://127.0.0.1:4174/api/health',
    reuseExistingServer,
    timeout: 30_000,
    env: {
      ...process.env,
      STDHUB_PROJECT_ROOT: process.cwd(),
    },
  },
  projects: [{ name: 'mock-chromium' }],
});
