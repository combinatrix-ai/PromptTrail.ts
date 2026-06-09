import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/templates/index.ts',
    'src/graph_executor.ts',
    'src/codex_app_server.ts',
    'src/claude_agent.ts',
  ],
  format: ['esm'],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: false,
  treeshake: true,
  outDir: 'dist',
});
