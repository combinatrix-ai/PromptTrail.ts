import { describe, expect, it } from 'vitest';
import { Session, UsageInfo } from '../../session';
import { Message } from '../../message';

describe('Session Usage Tracking', () => {
  it('should initialize with zero usage', () => {
    const session = Session.create();

    expect(session.usage.totalPromptTokens).toBe(0);
    expect(session.usage.totalCompletionTokens).toBe(0);
    expect(session.usage.totalTokens).toBe(0);
    expect(session.usage.totalPrice).toBe(0);
    expect(session.usage.callCount).toBe(0);
    expect(session.usage.history).toEqual([]);
  });

  it('should accumulate usage information', () => {
    const session = Session.create();

    const usage1: UsageInfo = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cost: 0.001,
    };

    const session2 = session.withUsage(usage1);

    expect(session2.usage.totalPromptTokens).toBe(100);
    expect(session2.usage.totalCompletionTokens).toBe(50);
    expect(session2.usage.totalTokens).toBe(150);
    expect(session2.usage.totalPrice).toBe(0.001);
    expect(session2.usage.callCount).toBe(1);
    expect(session2.usage.history).toHaveLength(1);
  });

  it('should accumulate multiple usage calls', () => {
    const session = Session.create();

    const usage1: UsageInfo = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cost: 0.001,
    };

    const usage2: UsageInfo = {
      promptTokens: 200,
      completionTokens: 100,
      totalTokens: 300,
      cost: 0.002,
    };

    const session2 = session.withUsage(usage1);
    const session3 = session2.withUsage(usage2);

    expect(session3.usage.totalPromptTokens).toBe(300);
    expect(session3.usage.totalCompletionTokens).toBe(150);
    expect(session3.usage.totalTokens).toBe(450);
    expect(session3.usage.totalPrice).toBe(0.003);
    expect(session3.usage.callCount).toBe(2);
    expect(session3.usage.history).toHaveLength(2);
  });

  it('should handle partial usage information', () => {
    const session = Session.create();

    const usage1: UsageInfo = {
      totalTokens: 150,
    };

    const session2 = session.withUsage(usage1);

    expect(session2.usage.totalPromptTokens).toBe(0);
    expect(session2.usage.totalCompletionTokens).toBe(0);
    expect(session2.usage.totalTokens).toBe(150);
    expect(session2.usage.totalPrice).toBe(0);
    expect(session2.usage.callCount).toBe(1);
  });

  it('should preserve usage when adding messages', () => {
    const session = Session.create();

    const usage1: UsageInfo = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cost: 0.001,
    };

    const session2 = session.withUsage(usage1);
    const message: Message = {
      type: 'user',
      content: 'Hello',
    };
    const session3 = session2.addMessage(message);

    expect(session3.usage.totalPrice).toBe(0.001);
    expect(session3.usage.callCount).toBe(1);
  });

  it('should preserve usage when updating vars', () => {
    const session = Session.create();

    const usage1: UsageInfo = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cost: 0.001,
    };

    const session2 = session.withUsage(usage1);
    const session3 = session2.withVar('key', 'value');

    expect(session3.usage.totalPrice).toBe(0.001);
    expect(session3.usage.callCount).toBe(1);
  });

  it('should include usage in toJSON', () => {
    const session = Session.create();

    const usage1: UsageInfo = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      cost: 0.001,
    };

    const session2 = session.withUsage(usage1);
    const json = session2.toJSON();

    expect(json.usage).toBeDefined();
    expect((json.usage as any).totalPrice).toBe(0.001);
  });
});
