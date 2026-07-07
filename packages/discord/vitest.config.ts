import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@prompttrail/core/runtime_dispatch',
        replacement: new URL('../core/src/runtime_dispatch.ts', import.meta.url)
          .pathname,
      },
      {
        find: '@prompttrail/core/runtime_server',
        replacement: new URL('../core/src/runtime_server.ts', import.meta.url)
          .pathname,
      },
      {
        find: '@prompttrail/cron/testing',
        replacement: new URL('../cron/src/testing.ts', import.meta.url)
          .pathname,
      },
      {
        find: '@prompttrail/cron',
        replacement: new URL('../cron/src/index.ts', import.meta.url).pathname,
      },
      {
        find: '@prompttrail/core',
        replacement: new URL('../core/src/index.ts', import.meta.url).pathname,
      },
    ],
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
