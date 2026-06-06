import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  collectOpenAIResponseFunctionCalls,
  convertSessionToResponsesInput,
  createOpenAIToolOutputItem,
  getOpenAIPromptTrailTools,
  getResponsesInstructions,
  promptTrailToolToOpenAIResponsesTool,
  retainOpenAIResponseMetadata,
} from '../../openai_responses';
import { Session } from '../../session';
import { Tool } from '../../tool';

describe('OpenAI Responses native adapter helpers', () => {
  it('converts PromptTrail messages into Responses input and instructions', () => {
    const session = Session.create()
      .addMessage({ type: 'system', content: 'Be concise.' })
      .addMessage({ type: 'user', content: 'Hello' })
      .addMessage({ type: 'assistant', content: 'Hi' })
      .addMessage({ type: 'user', content: 'Continue' });

    expect(getResponsesInstructions(session)).toBe('Be concise.');
    expect(convertSessionToResponsesInput(session)).toEqual([
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'Continue' },
    ]);
  });

  it('retains only binding-safe metadata at retain none', () => {
    expect(
      retainOpenAIResponseMetadata(
        {
          id: 'resp-1',
          status: 'completed',
          output: [{ type: 'message', id: 'item-1' }],
          usage: { input_tokens: 1 },
        },
        'none',
      ),
    ).toEqual({
      provider: 'openai',
      api: 'responses',
      responseId: 'resp-1',
      status: 'completed',
      error: undefined,
      incompleteDetails: undefined,
    });
  });

  it('summarizes output items by default and keeps raw only at full retention', () => {
    const response = {
      id: 'resp-1',
      status: 'completed',
      output: [
        {
          type: 'message',
          id: 'item-1',
          status: 'completed',
          content: [{ text: 'x'.repeat(600) }],
        },
      ],
      usage: { input_tokens: 1 },
    };

    expect(retainOpenAIResponseMetadata(response, 'summary')).toEqual({
      provider: 'openai',
      api: 'responses',
      responseId: 'resp-1',
      status: 'completed',
      error: undefined,
      incompleteDetails: undefined,
      usage: { input_tokens: 1 },
      outputItems: [
        {
          type: 'message',
          id: 'item-1',
          status: 'completed',
          preview: 'x'.repeat(500),
          truncated: true,
          fullLength: 600,
        },
      ],
    });

    expect(retainOpenAIResponseMetadata(response, 'full')).toMatchObject({
      responseId: 'resp-1',
      outputItems: response.output,
      raw: response,
    });
  });

  it('maps PromptTrail tools to strict Responses function tools', () => {
    const tool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().optional(),
      }),
      execute: ({ query }) => ({ query }),
    });

    expect(getOpenAIPromptTrailTools({ capabilities: [tool] })).toEqual([tool]);
    expect(promptTrailToolToOpenAIResponsesTool(tool)).toEqual({
      type: 'function',
      name: 'lookup',
      description: 'Lookup docs',
      strict: true,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: ['number', 'null'] },
        },
        required: ['query', 'limit'],
        additionalProperties: false,
      },
    });
  });

  it('collects function calls and creates tool output items', async () => {
    const tool = Tool.create({
      name: 'lookup',
      description: 'Lookup docs',
      inputSchema: z.object({ query: z.string() }),
      execute: ({ query }, context) => ({
        query,
        provider: context.provider,
      }),
    });
    const calls = collectOpenAIResponseFunctionCalls([
      {
        type: 'function_call',
        call_id: 'call-1',
        name: 'lookup',
        arguments: JSON.stringify({ query: 'capabilities' }),
      },
    ]);

    expect(calls).toEqual([
      {
        callId: 'call-1',
        name: 'lookup',
        arguments: { query: 'capabilities' },
        raw: {
          type: 'function_call',
          call_id: 'call-1',
          name: 'lookup',
          arguments: JSON.stringify({ query: 'capabilities' }),
        },
      },
    ]);

    await expect(
      createOpenAIToolOutputItem(calls[0], [tool], Session.create()),
    ).resolves.toEqual({
      type: 'function_call_output',
      call_id: 'call-1',
      output: JSON.stringify({
        content: [
          {
            type: 'json',
            json: { query: 'capabilities', provider: 'openai' },
          },
        ],
        structuredContent: { query: 'capabilities', provider: 'openai' },
      }),
    });
  });
});
