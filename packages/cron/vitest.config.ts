import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@prompttrail/core': new URL('../core/src/index.ts', import.meta.url)
        .pathname,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
    },
  },
});
