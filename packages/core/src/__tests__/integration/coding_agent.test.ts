import { describe, beforeEach, afterEach, it } from 'vitest';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { CodingAgent } from '../../../../../examples/coding_agent';

describe('CodingAgent Integration', () => {
  it('should create hello.js and example.txt files', async () => {
    const provider = (process.env.AI_PROVIDER || 'openai') as
      | 'openai'
      | 'anthropic';
    const apiKey =
      provider === 'openai'
        ? process.env.OPENAI_API_KEY
        : process.env.ANTHROPIC_API_KEY;

    if (!apiKey) {
      throw new Error(
        `${provider.toUpperCase()}_API_KEY environment variable is required`,
      );
    }

    const agent = new CodingAgent({ provider, apiKey });

    // runExampleを実行
    await agent.runExample();
  });
});
