import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['coding_agent.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
});
