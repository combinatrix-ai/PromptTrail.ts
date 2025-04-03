import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    deps: {
      inline: [/@prompttrail\/core/]
    },
    alias: {
      '@prompttrail/core': './src/test-mocks/core-mock.ts'
    }
  },
});
