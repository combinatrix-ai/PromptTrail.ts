import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'autonomous_researcher.ts',
    'chat.ts',
    'coding_agent.ts',
    'gradual_typing_demo.ts',
  ],
  format: ['esm'],
  dts: false,
  sourcemap: true,
  clean: true,
  external: ['@prompttrail/core'],
});
