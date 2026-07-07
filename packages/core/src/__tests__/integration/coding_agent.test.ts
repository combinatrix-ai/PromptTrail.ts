import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, it } from 'vitest';
import { CodingAgent } from '../../../../../examples/coding_agent';

const provider = (process.env.AI_PROVIDER || 'openai') as
  | 'openai'
  | 'anthropic';
const apiKey =
  provider === 'openai'
    ? process.env.OPENAI_API_KEY
    : process.env.ANTHROPIC_API_KEY;

describe('CodingAgent Integration', () => {
  it.skipIf(!apiKey)(
    'should create hello.js and example.txt files',
    async () => {
      // The agent's tools execute shell commands and write files. Left in the
      // repo's working directory, a creative model edit has overwritten
      // packages/core/package.json before — sandbox the run in a temp dir.
      const sandbox = await mkdtemp(join(tmpdir(), 'coding-agent-test-'));
      try {
        const agent = new CodingAgent({
          provider,
          apiKey: apiKey!,
          cwd: sandbox,
        });
        await agent.runExample();
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    },
    60000,
  );
});
