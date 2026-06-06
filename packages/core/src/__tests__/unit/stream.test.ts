import { describe, expect, it } from 'vitest';
import {
  reducePromptTrailStreamEvents,
  streamStateToAssistantMessage,
  type PromptTrailStreamEvent,
} from '../../stream';

describe('PromptTrail stream reducer', () => {
  it('reduces text, reasoning, done metadata, and errors', () => {
    const state = reducePromptTrailStreamEvents([
      { type: 'reasoning.delta', index: 0, delta: 'think ' },
      { type: 'text.delta', index: 0, delta: 'hello' },
      { type: 'text.delta', index: 0, delta: ' world' },
      { type: 'message.done', finishReason: 'stop', usage: { tokens: 3 } },
      { type: 'error', error: new Error('late warning') },
    ]);

    expect(state.text).toBe('hello world');
    expect(state.reasoning).toBe('think ');
    expect(state.finishReason).toBe('stop');
    expect(state.usage).toEqual({ tokens: 3 });
    expect(state.errors).toHaveLength(1);
    expect(state.events).toHaveLength(5);
  });

  it('accumulates tool args deltas without requiring valid JSON mid-stream', () => {
    const events: PromptTrailStreamEvent[] = [
      { type: 'tool.start', index: 1, callId: 'call-1', name: 'lookup' },
      { type: 'tool.args.delta', index: 1, callId: 'call-1', delta: '{"q' },
      { type: 'tool.args.delta', index: 1, callId: 'call-1', delta: 'uery":' },
      { type: 'tool.args.delta', index: 1, callId: 'call-1', delta: '"docs"}' },
      {
        type: 'tool.args.done',
        index: 1,
        callId: 'call-1',
        args: { query: 'docs' },
      },
    ];

    const state = reducePromptTrailStreamEvents(events);
    expect(state.tools['call-1']).toMatchObject({
      name: 'lookup',
      argsText: '{"query":"docs"}',
      args: { query: 'docs' },
    });
    expect(streamStateToAssistantMessage(state)).toMatchObject({
      type: 'assistant',
      content: ' ',
      toolCalls: [
        {
          id: 'call-1',
          name: 'lookup',
          arguments: { query: 'docs' },
        },
      ],
    });
  });

  it('supports atomic function calls with args.done only', () => {
    const state = reducePromptTrailStreamEvents([
      { type: 'tool.start', index: 0, callId: 'call-1', name: 'lookup' },
      {
        type: 'tool.args.done',
        index: 0,
        callId: 'call-1',
        args: { query: 'gemini' },
      },
    ]);

    expect(streamStateToAssistantMessage(state).toolCalls).toEqual([
      { id: 'call-1', name: 'lookup', arguments: { query: 'gemini' } },
    ]);
  });
});
