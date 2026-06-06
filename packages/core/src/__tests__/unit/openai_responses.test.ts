import { describe, expect, it } from 'vitest';
import {
  convertSessionToResponsesInput,
  getResponsesInstructions,
  retainOpenAIResponseMetadata,
} from '../../openai_responses';
import { Session } from '../../session';

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
});
