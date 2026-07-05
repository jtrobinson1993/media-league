import { defineConfig } from '@playwright/test';

const PORT = 3311;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 420, height: 860 }, // mobile-first (SPEC §16)
  },
  webServer: {
    command: `npm run build -w web && PORT=${PORT} DATABASE_PATH=$(mktemp -d)/e2e.db npx tsx server/src/index.ts`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
