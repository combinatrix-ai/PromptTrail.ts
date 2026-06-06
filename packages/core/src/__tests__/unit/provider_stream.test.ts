import { describe, expect, it } from 'vitest';
import {
  createAnthropicStreamNormalizer,
  createOpenAIStreamNormalizer,
  geminiStreamEventToPromptTrailEvents,
} from '../../provider_stream';
import { reducePromptTrailStreamEvents } from '../../stream';

describe('provider stream normalizers', () => {
  it('normalizes OpenAI Responses text, reasoning, function args, and completion events', () => {
    const normalizer = createOpenAIStreamNormalizer();
    const events = [
      ...normalizer.consume({
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          type: 'function_call',
          id: 'item-1',
          call_id: 'call-1',
          name: 'lookup',
        },
      }),
      ...normalizer.consume({
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        item_id: 'item-1',
        delta: '{"query"',
      }),
      ...normalizer.consume({
        type: 'response.function_call_arguments.delta',
        output_index: 1,
        item_id: 'item-1',
        delta: ':"docs"}',
      }),
      ...normalizer.consume({
        type: 'response.function_call_arguments.done',
        output_index: 1,
        item_id: 'item-1',
        arguments: '{"query":"docs"}',
      }),
      ...normalizer.consume({
        type: 'response.reasoning_summary_text.delta',
        output_index: 0,
        delta: 'thinking',
      }),
      ...normalizer.consume({
        type: 'response.output_text.delta',
        output_index: 2,
        delta: 'done',
      }),
      ...normalizer.consume({
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 3 } },
      }),
    ];

    expect(events).toEqual([
      { type: 'tool.start', index: 1, callId: 'call-1', name: 'lookup' },
      {
        type: 'tool.args.delta',
        index: 1,
        callId: 'call-1',
        delta: '{"query"',
      },
      {
        type: 'tool.args.delta',
        index: 1,
        callId: 'call-1',
        delta: ':"docs"}',
      },
      {
        type: 'tool.args.done',
        index: 1,
        callId: 'call-1',
        args: { query: 'docs' },
      },
      { type: 'reasoning.delta', index: 0, delta: 'thinking' },
      { type: 'text.delta', index: 2, delta: 'done' },
      {
        type: 'message.done',
        finishReason: 'completed',
        usage: { input_tokens: 3 },
      },
    ]);
  });

  it('normalizes OpenAI output_item.done function calls without duplicating completed args', () => {
    const normalizer = createOpenAIStreamNormalizer();

    expect(
      normalizer.consume({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'item-1',
          call_id: 'call-1',
          name: 'lookup',
          arguments: '{"query":"docs"}',
        },
      }),
    ).toEqual([
      {
        type: 'tool.args.done',
        index: 0,
        callId: 'call-1',
        args: { query: 'docs' },
      },
    ]);

    const withDeltaDone = createOpenAIStreamNormalizer();
    expect(
      withDeltaDone.consume({
        type: 'response.function_call_arguments.done',
        output_index: 0,
        call_id: 'call-2',
        arguments: '{"query":"docs"}',
      }),
    ).toEqual([
      {
        type: 'tool.args.done',
        index: 0,
        callId: 'call-2',
        args: { query: 'docs' },
      },
    ]);
    expect(
      withDeltaDone.consume({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call-2',
          name: 'lookup',
          arguments: '{"query":"docs"}',
        },
      }),
    ).toEqual([]);
  });

  it('normalizes Anthropic content block deltas without parsing partial JSON', () => {
    const normalizer = createAnthropicStreamNormalizer();
    const events = [
      ...normalizer.consume({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu-1', name: 'lookup' },
      }),
      ...normalizer.consume({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"query"' },
      }),
      ...normalizer.consume({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: ':"docs"}' },
      }),
      ...normalizer.consume({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'think' },
      }),
      ...normalizer.consume({
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'text_delta', text: 'done' },
      }),
      ...normalizer.consume({ type: 'content_block_stop', index: 1 }),
      ...normalizer.consume({
        type: 'message_stop',
        stop_reason: 'tool_use',
        usage: { input_tokens: 4 },
      }),
    ];
    const state = reducePromptTrailStreamEvents(events);

    expect(state.reasoning).toBe('think');
    expect(state.text).toBe('done');
    expect(state.tools['toolu-1']).toMatchObject({
      name: 'lookup',
      argsText: '{"query":"docs"}',
      args: undefined,
    });
    expect(state.finishReason).toBe('tool_use');
  });

  it('normalizes Gemini text, thought parts, and atomic function calls', () => {
    expect(
      geminiStreamEventToPromptTrailEvents({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                { text: 'think', thought: true },
                { text: 'done' },
                {
                  functionCall: {
                    id: 'call-1',
                    name: 'lookup',
                    args: { query: 'docs' },
                  },
                },
              ],
            },
          },
        ],
        usageMetadata: { promptTokenCount: 2 },
      }),
    ).toEqual([
      { type: 'reasoning.delta', index: 0, delta: 'think' },
      { type: 'text.delta', index: 1, delta: 'done' },
      { type: 'tool.start', index: 2, callId: 'call-1', name: 'lookup' },
      {
        type: 'tool.args.done',
        index: 2,
        callId: 'call-1',
        args: { query: 'docs' },
      },
      {
        type: 'message.done',
        finishReason: 'STOP',
        usage: { promptTokenCount: 2 },
      },
    ]);
  });
});
