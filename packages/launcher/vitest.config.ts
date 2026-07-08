import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@prompttrail/core/runtime_server',
        replacement: new URL('../core/src/runtime_server.ts', import.meta.url)
          .pathname,
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
    // Child processes are spawned, awaited-ready, cut over, and reaped; give the
    // blue/green orchestration tests room without being flaky.
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
    },
  },
});
