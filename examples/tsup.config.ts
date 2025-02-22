import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['coding_agent.ts'],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  external: ['@prompttrail/core'],
});
