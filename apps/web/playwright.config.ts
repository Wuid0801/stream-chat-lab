import { defineConfig, devices } from '@playwright/test'

const CI = Boolean(process.env.CI)

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  forbidOnly: CI,
  reporter: CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // 목 서버와 web을 함께 띄운다. 로컬에서는 이미 떠 있으면 재사용한다.
  // 명령 안에서 yarn을 다시 부르지 않는다. Windows에서 corepack shim이 비ASCII 사용자 경로를 깨뜨린다.
  webServer: [
    {
      command: 'tsx ../mock-server/src/index.ts',
      url: 'http://localhost:8787/health',
      reuseExistingServer: !CI,
    },
    {
      command: 'vite --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: !CI,
    },
  ],
})
