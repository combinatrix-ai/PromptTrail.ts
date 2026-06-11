import { describe, expect, it, beforeEach } from 'vitest';
import { Source, type ModelOutput } from '@prompttrail/core';
import {
  createSupportRuntime,
  getRefundRecords,
  getReturnTransformInspections,
  resetSupportDemoRecords,
} from '../lib/support-agent';

const returnChoicesPayload = {
  reply: 'Which order should I return?',
  choices: [
    { id: 'ORD-1001', label: 'ORD-1001 - Trail Runner Backpack' },
    { id: 'ORD-1002', label: 'ORD-1002 - Insulated Camp Mug' },
    { id: 'ORD-1003', label: 'ORD-1003 - Warranty Replacement Strap' },
  ],
};

function returnChoicesSource() {
  return new (class extends Source<ModelOutput> {
    async getContent(): Promise<ModelOutput> {
      return {
        content: returnChoicesPayload.reply,
        structuredOutput: returnChoicesPayload,
      };
    }
  })();
}

describe('customer support chat runtime', () => {
  beforeEach(() => {
    resetSupportDemoRecords();
  });

  it('accumulates two turns across separate handleMessage calls', async () => {
    const source = Source.llm()
      .mock()
      .mockCallback((session) => {
        const userTurns = session.messages.filter(
          (message) => message.type === 'user',
        ).length;
        return { content: `Support reply ${userTurns}` };
      });
    const runtime = createSupportRuntime(source);

    const first = await runtime.handleMessage('conversation-a', 'Hello');
    const second = await runtime.handleMessage(
      'conversation-a',
      'Where is ORD-1001?',
    );

    expect(first.messages.map((message) => message.content)).toEqual([
      'Hello',
      'Support reply 1',
    ]);
    expect(second.messages.map((message) => message.content)).toEqual([
      'Hello',
      'Support reply 1',
      'Where is ORD-1001?',
      'Support reply 2',
    ]);
  });

  it('executes lookupOrder from model toolCalls before the final reply', async () => {
    const source = Source.llm()
      .mock()
      .mockCallback((session) => {
        const toolResult = session.messages.find(
          (message) => message.type === 'tool_result',
        );

        if (toolResult) {
          return { content: `I found the order: ${toolResult.content}` };
        }

        return {
          content: 'I will check that order.',
          toolCalls: [
            {
              id: 'lookup-1',
              name: 'lookupOrder',
              arguments: { orderId: 'ORD-1001' },
            },
          ],
        };
      });
    const runtime = createSupportRuntime(source);

    const result = await runtime.handleMessage(
      'conversation-lookup',
      'Where is ORD-1001?',
    );

    expect(result.messages.map((message) => message.type)).toEqual([
      'user',
      'assistant',
      'tool_result',
      'assistant',
    ]);
    expect(result.messages[2]?.content).toContain('Trail Runner Backpack');
    expect(result.messages.at(-1)?.content).toContain('I found the order');
  });

  it('passes the resolved refund idempotency key to issueRefund', async () => {
    const source = Source.llm()
      .mock()
      .mockCallback((session) => {
        const toolResult = session.messages.find(
          (message) => message.type === 'tool_result',
        );

        if (toolResult) {
          return { content: 'Refund issued.' };
        }

        return {
          content: 'I will issue the refund.',
          toolCalls: [
            {
              id: 'refund-1',
              name: 'issueRefund',
              arguments: {
                orderId: 'ORD-1002',
                reason: 'Customer requested cancellation.',
              },
            },
          ],
        };
      });
    const runtime = createSupportRuntime(source);

    await runtime.handleMessage('conversation-refund', 'Refund ORD-1002');

    expect(getRefundRecords()).toEqual([
      {
        orderId: 'ORD-1002',
        reason: 'Customer requested cancellation.',
        idempotencyKey: 'refund:ORD-1002',
      },
    ]);
  });

  it('suspends the return wizard with projected order choices', async () => {
    const runtime = createSupportRuntime(
      Source.llm().mock(),
      returnChoicesSource(),
    );

    const result = await runtime.handleMessage(
      'returns-turn-1',
      'I need to return an order.',
      'returns',
    );

    expect(result.status).toBe('suspended');
    expect(result.awaiting).toBe('returns/order-choice');
    expect(result.messages.at(-1)).toMatchObject({
      type: 'assistant',
      content: returnChoicesPayload.reply,
      structuredContent: returnChoicesPayload,
    });
  });

  it('issues a keyed refund once for an eligible return choice', async () => {
    const runtime = createSupportRuntime(
      Source.llm().mock(),
      returnChoicesSource(),
    );

    await runtime.handleMessage(
      'returns-eligible',
      'The mug is not needed.',
      'returns',
    );
    const result = await runtime.handleMessage(
      'returns-eligible',
      'ORD-1002',
      'returns',
    );

    expect(result.status).toBe('done');
    expect(getRefundRecords()).toEqual([
      {
        orderId: 'ORD-1002',
        reason: 'The mug is not needed.',
        idempotencyKey: 'refund:ORD-1002',
      },
    ]);
    expect(getReturnTransformInspections()).toEqual([
      { type: 'user', content: 'ORD-1002' },
    ]);
    expect(result.messages.at(-1)?.content).toContain('RF-ORD-1002');
  });

  it('denies an ineligible return choice without recording a refund', async () => {
    const runtime = createSupportRuntime(
      Source.llm().mock(),
      returnChoicesSource(),
    );

    await runtime.handleMessage(
      'returns-ineligible',
      'The replacement is wrong.',
      'returns',
    );
    const result = await runtime.handleMessage(
      'returns-ineligible',
      'ORD-1003',
      'returns',
    );

    expect(result.status).toBe('done');
    expect(getRefundRecords()).toEqual([]);
    expect(result.messages.at(-1)?.content).toBe(
      'ORD-1003 is not eligible for a refund.',
    );
  });
});
