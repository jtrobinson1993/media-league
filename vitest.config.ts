import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts', 'shared/test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@media-league/shared': new URL('./shared/src/index.ts', import.meta.url).pathname,
    },
  },
});
