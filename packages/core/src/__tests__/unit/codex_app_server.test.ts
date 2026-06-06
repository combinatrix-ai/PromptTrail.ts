import { describe, expect, it, vi } from 'vitest';
import {
  collectCodexTurnResult,
  normalizeCodexRuntimeEvent,
  type CodexTurnEvent,
} from '../../codex_app_server';

describe('Codex App Server helpers', () => {
  it('normalizes known runtime events', () => {
    expect(
      normalizeCodexRuntimeEvent({
        method: 'item/started',
        params: {
          item: {
            id: 'item-1',
            type: 'agentMessage',
            status: 'inProgress',
            content: 'hello',
          },
        },
      }),
    ).toMatchObject({
      type: 'item.started',
      id: 'item-1',
      itemType: 'agentMessage',
      status: 'inProgress',
      preview: 'hello',
    });

    expect(
      normalizeCodexRuntimeEvent({
        method: 'item/agentMessage/delta',
        params: { turnId: 'turn-1', delta: 'hi' },
      }),
    ).toMatchObject({
      type: 'text.delta',
      id: 'turn-1',
      delta: 'hi',
    });

    expect(
      normalizeCodexRuntimeEvent({
        method: 'turn/completed',
        params: { turn: { id: 'turn-1', status: 'completed' } },
      }),
    ).toMatchObject({
      type: 'turn.completed',
      id: 'turn-1',
      status: 'completed',
    });
  });

  it('retains unknown runtime events as raw events', () => {
    expect(
      normalizeCodexRuntimeEvent({
        method: 'future/event',
        params: { value: 1 },
      }),
    ).toMatchObject({
      type: 'raw',
      id: 'future/event',
      method: 'future/event',
    });
  });

  it('collects async iterable events and calls onEvent', async () => {
    const onEvent = vi.fn();
    const result = await collectCodexTurnResult(
      eventStream([
        {
          method: 'item/completed',
          params: {
            turnId: 'turn-1',
            item: {
              id: 'item-1',
              type: 'agentMessage',
              content: 'Codex result',
            },
          },
        },
        {
          method: 'turn/completed',
          params: { turn: { id: 'turn-1', status: 'completed' } },
        },
      ]),
      { threadId: 'thread-1' },
      onEvent,
    );

    expect(result).toMatchObject({
      threadId: 'thread-1',
      turnId: 'turn-1',
      finalAnswer: 'Codex result',
      items: [{ id: 'item-1' }],
    });
    expect(result.events).toHaveLength(2);
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onEvent.mock.calls[0][0]).toMatchObject({
      type: 'item.completed',
      id: 'item-1',
    });
  });
});

async function* eventStream(events: CodexTurnEvent[]) {
  for (const event of events) {
    yield event;
  }
}
