import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@prompttrail/core': new URL(
        '../../packages/core/src/index.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10000,
  },
});
