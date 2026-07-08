import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@prompttrail/core/runtime_server',
        replacement: new URL(
          '../packages/core/src/runtime_server.ts',
          import.meta.url,
        ).pathname,
      },
      {
        find: '@prompttrail/core/runtime_dispatch',
        replacement: new URL(
          '../packages/core/src/runtime_dispatch.ts',
          import.meta.url,
        ).pathname,
      },
      {
        find: '@prompttrail/core',
        replacement: new URL('../packages/core/src/index.ts', import.meta.url)
          .pathname,
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 10000,
  },
});
