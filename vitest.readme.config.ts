import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    typecheck: {
      enabled: false, // Disable TypeScript type checking for tests
    },
  },
  resolve: {
    alias: {
      '@prompttrail/core': './packages/core/src',
    },
  },
});
