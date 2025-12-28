import { describe, expect, it, beforeEach } from 'vitest';
import { Session } from '../../session';
import {
  SessionPersistence,
  InMemoryAdapter,
  createInMemoryPersistence,
} from '../../persistence';
import { Source } from '../../source';
import { Assistant } from '../../templates/primitives/assistant';

describe('Session Persistence', () => {
  let persistence: SessionPersistence;
  let adapter: InMemoryAdapter;

  beforeEach(() => {
    adapter = new InMemoryAdapter();
    persistence = new SessionPersistence(adapter);
  });

  describe('Basic persistence', () => {
    it('should save and load a session', async () => {
      const session = Session.create({
        vars: { userId: '123' },
        messages: [{ type: 'user', content: 'Hello' }],
      });

      const sessionId = await persistence.save(session);
      expect(sessionId).toBeDefined();

      const loaded = await persistence.load(sessionId);
      expect(loaded).toBeDefined();
      expect(loaded?.messages).toHaveLength(1);
      expect(loaded?.vars).toEqual({ userId: '123' });
    });

    it('should return null for non-existent session', async () => {
      const loaded = await persistence.load('non-existent');
      expect(loaded).toBeNull();
    });

    it('should delete a session', async () => {
      const session = Session.create();
      const sessionId = await persistence.save(session);

      await persistence.delete(sessionId);

      const loaded = await persistence.load(sessionId);
      expect(loaded).toBeNull();
    });

    it('should list all sessions', async () => {
      const session1 = Session.create();
      const session2 = Session.create();

      await persistence.save(session1);
      await persistence.save(session2);

      const list = await persistence.list();
      expect(list).toHaveLength(2);
    });
  });

  describe('Usage persistence', () => {
    it('should preserve usage information when saving and loading', async () => {
      let session = Session.create();

      session = session.withUsage({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cost: 0.001,
      });

      const sessionId = await persistence.save(session);
      const loaded = await persistence.load(sessionId);

      expect(loaded?.usage.totalPromptTokens).toBe(100);
      expect(loaded?.usage.totalCompletionTokens).toBe(50);
      expect(loaded?.usage.totalTokens).toBe(150);
      expect(loaded?.usage.totalPrice).toBe(0.001);
      expect(loaded?.usage.callCount).toBe(1);
    });

    it('should preserve usage history', async () => {
      let session = Session.create();

      session = session.withUsage({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cost: 0.001,
      });

      session = session.withUsage({
        promptTokens: 200,
        completionTokens: 100,
        totalTokens: 300,
        cost: 0.002,
      });

      const sessionId = await persistence.save(session);
      const loaded = await persistence.load(sessionId);

      expect(loaded?.usage.callCount).toBe(2);
      expect(loaded?.usage.history).toHaveLength(2);
      expect(loaded?.usage.totalPrice).toBe(0.003);
    });

    it('should handle sessions without usage', async () => {
      const session = Session.create();
      const sessionId = await persistence.save(session);
      const loaded = await persistence.load(sessionId);

      expect(loaded?.usage.totalPrice).toBe(0);
      expect(loaded?.usage.callCount).toBe(0);
    });
  });

  describe('Metadata', () => {
    it('should save and retrieve metadata', async () => {
      const session = Session.create();
      const metadata = {
        userId: 'user_123',
        conversationTopic: 'Support',
        tags: ['urgent', 'billing'],
      };

      const sessionId = await persistence.save(session, undefined, metadata);
      const retrieved = await persistence.getMetadata(sessionId);

      expect(retrieved?.metadata).toEqual(metadata);
    });

    it('should include timestamps', async () => {
      const session = Session.create();
      const sessionId = await persistence.save(session);
      const metadata = await persistence.getMetadata(sessionId);

      expect(metadata?.createdAt).toBeDefined();
      expect(metadata?.updatedAt).toBeDefined();
    });
  });

  describe('Session updates', () => {
    it('should update an existing session', async () => {
      let session = Session.create();
      const sessionId = await persistence.save(session);

      session = session.addMessage({ type: 'user', content: 'New message' });
      await persistence.save(session, sessionId);

      const loaded = await persistence.load(sessionId);
      expect(loaded?.messages).toHaveLength(1);
    });

    it('should preserve usage when updating', async () => {
      let session = Session.create();
      session = session.withUsage({
        totalTokens: 100,
        cost: 0.001,
      });

      const sessionId = await persistence.save(session);

      session = session.withUsage({
        totalTokens: 200,
        cost: 0.002,
      });

      await persistence.save(session, sessionId);

      const loaded = await persistence.load(sessionId);
      expect(loaded?.usage.totalPrice).toBe(0.003);
      expect(loaded?.usage.callCount).toBe(2);
    });
  });

  describe('Integration with LLM', () => {
    it('should persist session with LLM usage', async () => {
      let session = Session.create();

      const llmSource = Source.llm()
        .mock()
        .mockResponse({
          content: 'Hello, world!',
          usage: {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
            cost: 0.001,
          },
        });

      const assistant = new Assistant(llmSource);

      session = session.addMessage({ type: 'user', content: 'Hello' });
      session = await assistant.execute(session);

      const sessionId = await persistence.save(session);
      const loaded = await persistence.load(sessionId);

      expect(loaded?.messages).toHaveLength(2); // user + assistant
      expect(loaded?.usage.totalPrice).toBe(0.001);
      expect(loaded?.usage.callCount).toBe(1);
    });

    it('should handle resuming a conversation', async () => {
      let session = Session.create();

      const llmSource = Source.llm()
        .mock()
        .mockResponses(
          {
            content: 'First response',
            usage: { totalTokens: 100, cost: 0.001 },
          },
          {
            content: 'Second response',
            usage: { totalTokens: 150, cost: 0.0015 },
          },
        );

      const assistant = new Assistant(llmSource);

      // First turn
      session = session.addMessage({ type: 'user', content: 'First question' });
      session = await assistant.execute(session);

      const sessionId = await persistence.save(session);

      // Resume
      let resumedSession = await persistence.load(sessionId);
      expect(resumedSession).toBeDefined();

      if (resumedSession) {
        resumedSession = resumedSession.addMessage({
          type: 'user',
          content: 'Second question',
        });
        resumedSession = await assistant.execute(resumedSession);

        await persistence.save(resumedSession, sessionId);

        const finalSession = await persistence.load(sessionId);
        expect(finalSession?.messages).toHaveLength(4); // 2 user + 2 assistant
        expect(finalSession?.usage.callCount).toBe(2);
        expect(finalSession?.usage.totalPrice).toBe(0.0025);
      }
    });
  });

  describe('Helper functions', () => {
    it('should create in-memory persistence', () => {
      const persistence = createInMemoryPersistence();
      expect(persistence).toBeInstanceOf(SessionPersistence);
    });
  });
});

describe('Session.fromJSON with usage', () => {
  it('should restore usage from JSON', () => {
    const json = {
      messages: [{ type: 'user', content: 'Hello' }],
      context: { key: 'value' },
      usage: {
        totalPromptTokens: 100,
        totalCompletionTokens: 50,
        totalTokens: 150,
        totalPrice: 0.001,
        callCount: 1,
        history: [
          {
            promptTokens: 100,
            completionTokens: 50,
            totalTokens: 150,
            cost: 0.001,
          },
        ],
      },
    };

    const session = Session.fromJSON(json);

    expect(session.usage.totalPromptTokens).toBe(100);
    expect(session.usage.totalCompletionTokens).toBe(50);
    expect(session.usage.totalTokens).toBe(150);
    expect(session.usage.totalPrice).toBe(0.001);
    expect(session.usage.callCount).toBe(1);
    expect(session.usage.history).toHaveLength(1);
  });

  it('should handle missing usage in JSON', () => {
    const json = {
      messages: [{ type: 'user', content: 'Hello' }],
      context: {},
    };

    const session = Session.fromJSON(json);

    expect(session.usage.totalPrice).toBe(0);
    expect(session.usage.callCount).toBe(0);
  });

  it('should handle partial usage data', () => {
    const json = {
      messages: [{ type: 'user', content: 'Hello' }],
      context: {},
      usage: {
        totalPrice: 0.005,
        // Missing other fields
      },
    };

    const session = Session.fromJSON(json);

    expect(session.usage.totalPrice).toBe(0.005);
    expect(session.usage.totalPromptTokens).toBe(0);
    expect(session.usage.callCount).toBe(0);
  });
});
