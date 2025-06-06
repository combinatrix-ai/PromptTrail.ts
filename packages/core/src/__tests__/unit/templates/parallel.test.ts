import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../../../session';
import { Source } from '../../../source';
import { Parallel } from '../../../templates/primitives/parallel';

// Mock the source module
vi.mock('../../../source', () => ({
  Source: {
    llm: vi.fn(),
  },
}));

describe('Parallel Template', () => {
  let mockLlmSource1: any;
  let mockLlmSource2: any;
  let mockLlmSource3: any;

  beforeEach(() => {
    vi.resetAllMocks();

    // Create mock LLM sources
    mockLlmSource1 = {
      getContent: vi.fn().mockResolvedValue({
        content: 'Response from source 1',
        metadata: { sourceId: 'source1' },
      }),
    };

    mockLlmSource2 = {
      getContent: vi.fn().mockResolvedValue({
        content: 'Response from source 2',
        metadata: { sourceId: 'source2' },
      }),
    };

    mockLlmSource3 = {
      getContent: vi.fn().mockResolvedValue({
        content: 'Response from source 3',
        metadata: { sourceId: 'source3' },
      }),
    };

    // Mock Source.llm() to return our mock sources
    vi.mocked(Source.llm).mockReturnValue(mockLlmSource1);
  });

  describe('Basic Functionality', () => {
    it('should create an empty parallel template', () => {
      const parallel = new Parallel();
      expect(parallel).toBeInstanceOf(Parallel);
      expect(parallel.getSources()).toHaveLength(0);
    });

    it('should create with sources via constructor', () => {
      const parallel = new Parallel({
        sources: [
          { source: mockLlmSource1, repetitions: 1 },
          { source: mockLlmSource2, repetitions: 1 },
        ],
      });

      const sources = parallel.getSources();
      expect(sources).toHaveLength(2);
      expect(sources[0]).toEqual({ source: mockLlmSource1, repetitions: 1 });
      expect(sources[1]).toEqual({ source: mockLlmSource2, repetitions: 1 });
    });

    it('should create with custom repetitions via constructor', () => {
      const parallel = new Parallel({
        sources: [
          { source: mockLlmSource1, repetitions: 3 },
          { source: mockLlmSource2, repetitions: 2 },
        ],
      });

      const sources = parallel.getSources();
      expect(sources).toHaveLength(2);
      expect(sources[0]).toEqual({ source: mockLlmSource1, repetitions: 3 });
      expect(sources[1]).toEqual({ source: mockLlmSource2, repetitions: 2 });
    });

    it('should set sources with default repetitions via constructor', () => {
      const parallel = new Parallel({
        sources: [
          { source: mockLlmSource1, repetitions: 2 },
          { source: mockLlmSource2 }, // default repetitions
          { source: mockLlmSource3, repetitions: 3 },
        ],
      });

      const sources = parallel.getSources();
      expect(sources).toHaveLength(3);
      expect(sources[0]).toEqual({ source: mockLlmSource1, repetitions: 2 });
      expect(sources[1]).toEqual({ source: mockLlmSource2, repetitions: 1 });
      expect(sources[2]).toEqual({ source: mockLlmSource3, repetitions: 3 });
    });
  });

  describe('Execution', () => {
    it('should return original session when no sources are configured', async () => {
      const parallel = new Parallel();
      const session = Session.create();
      const result = await parallel.execute(session);

      expect(result).toBe(session);
    });

    it('should execute single source and add assistant message', async () => {
      const parallel = new Parallel({
        sources: [{ source: mockLlmSource1 }],
      });
      const session = Session.create();
      const result = await parallel.execute(session);

      expect(mockLlmSource1.getContent).toHaveBeenCalledTimes(1);
      expect(mockLlmSource1.getContent).toHaveBeenCalledWith(session);

      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual({
        type: 'assistant',
        content: 'Response from source 1',
        attrs: { sourceId: 'source1' },
      });
    });

    it('should execute multiple sources in parallel with keep_all strategy', async () => {
      const parallel = new Parallel({
        sources: [{ source: mockLlmSource1 }, { source: mockLlmSource2 }],
        strategy: 'keep_all',
      });

      const session = Session.create();
      const result = await parallel.execute(session);

      expect(mockLlmSource1.getContent).toHaveBeenCalledTimes(1);
      expect(mockLlmSource2.getContent).toHaveBeenCalledTimes(1);

      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(2);

      // Note: Order might vary due to parallel execution, so check content exists
      const messageContents = messages.map((m) => m.content);
      expect(messageContents).toContain('Response from source 1');
      expect(messageContents).toContain('Response from source 2');
    });

    it('should handle source repetitions correctly', async () => {
      const parallel = new Parallel({
        sources: [
          { source: mockLlmSource1, repetitions: 2 },
          { source: mockLlmSource2, repetitions: 1 },
        ],
      });

      const session = Session.create();
      const result = await parallel.execute(session);

      expect(mockLlmSource1.getContent).toHaveBeenCalledTimes(2);
      expect(mockLlmSource2.getContent).toHaveBeenCalledTimes(1);

      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(3); // 2 + 1
    });

    it('should handle source failures gracefully', async () => {
      const failingSource = {
        getContent: vi.fn().mockRejectedValue(new Error('Source failed')),
      };

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const parallel = new Parallel({
        sources: [
          { source: mockLlmSource1 },
          { source: failingSource },
          { source: mockLlmSource2 },
        ],
      });

      const session = Session.create();
      const result = await parallel.execute(session);

      expect(warnSpy).toHaveBeenCalledWith(
        'Parallel source execution failed:',
        expect.any(Error),
      );

      // Should have 2 messages (from successful sources)
      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(2);

      warnSpy.mockRestore();
    });
  });

  describe('Scoring and Aggregation', () => {
    it('should set and get scoring function', () => {
      const scoringFunction = (session: Session) => session.messages.length;
      const parallel = new Parallel({
        scoringFunction,
      });

      expect(parallel.getScoringFunction()).toBe(scoringFunction);
    });

    it('should use best strategy with scoring function', async () => {
      // Mock sources with different message lengths
      const shortResponseSource = {
        getContent: vi.fn().mockResolvedValue({
          content: 'Short',
          metadata: {},
        }),
      };

      const longResponseSource = {
        getContent: vi.fn().mockResolvedValue({
          content: 'This is a much longer response with more content',
          metadata: {},
        }),
      };

      const parallel = new Parallel({
        sources: [
          { source: shortResponseSource },
          { source: longResponseSource },
        ],
        scoringFunction: (session) =>
          session.messages[session.messages.length - 1].content.length,
        strategy: 'best',
      });

      const session = Session.create();
      const result = await parallel.execute(session);

      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe(
        'This is a much longer response with more content',
      );
    });

    it('should use default scoring function when using best strategy without explicit scoring function', async () => {
      // Mock sources with different response qualities
      const shortResponseSource = {
        getContent: vi.fn().mockResolvedValue({
          content: 'Yes',
          metadata: {},
        }),
      };

      const detailedResponseSource = {
        getContent: vi.fn().mockResolvedValue({
          content:
            'Yes, that is correct. Here is a detailed explanation with multiple points to consider.',
          metadata: {},
        }),
      };

      const parallel = new Parallel({
        sources: [
          { source: shortResponseSource },
          { source: detailedResponseSource },
        ],
        strategy: 'best', // No explicit scoring function
      });

      const session = Session.create().addMessage({
        type: 'user',
        content: 'Is TypeScript better than JavaScript?',
      });

      const result = await parallel.execute(session);

      // Should select the more detailed response using default scoring
      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(2); // Original user message + selected response
      expect(messages[1].content).toBe(
        'Yes, that is correct. Here is a detailed explanation with multiple points to consider.',
      );
    });

    it('should use custom aggregation strategy', async () => {
      const customStrategy = (sessions: Session[]) => {
        // Combine all messages from all sessions
        let result = sessions[0];
        for (let i = 1; i < sessions.length; i++) {
          const originalMessageCount = result.messages.length - 1; // Account for the first session's message
          const newMessages = sessions[i].messages.slice(originalMessageCount);
          for (const message of newMessages) {
            result = result.addMessage({
              ...message,
              content: `[Combined] ${message.content}`,
            });
          }
        }
        return result;
      };

      const parallel = new Parallel({
        sources: [{ source: mockLlmSource1 }, { source: mockLlmSource2 }],
        strategy: customStrategy,
      });

      const session = Session.create();
      const result = await parallel.execute(session);

      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Response from source 1');
      expect(messages[1].content).toBe('[Combined] Response from source 2');
    });
  });

  describe('Configuration', () => {
    it('should accept configuration in constructor', () => {
      const scoringFunction = (session: Session) => session.messages.length;
      const parallel = new Parallel({
        sources: [
          { source: mockLlmSource1, repetitions: 2 },
          { source: mockLlmSource2 },
        ],
        scoringFunction,
        strategy: 'best',
      });

      expect(parallel.getSources()).toHaveLength(2);
      expect(parallel.getScoringFunction()).toBe(scoringFunction);
      expect(parallel.getStrategy()).toBe('best');
    });

    it('should get and set strategy correctly via constructor', () => {
      const parallel1 = new Parallel();
      expect(parallel1.getStrategy()).toBe('keep_all'); // default

      const parallel2 = new Parallel({ strategy: 'best' });
      expect(parallel2.getStrategy()).toBe('best');

      const customStrategy = (sessions: Session[]) => sessions[0];
      const parallel3 = new Parallel({ strategy: customStrategy });
      expect(parallel3.getStrategy()).toBe(customStrategy);
    });

    it('should throw error for unknown built-in strategy', async () => {
      const parallel = new Parallel({
        sources: [{ source: mockLlmSource1 }],
        strategy: 'unknown_strategy' as any,
      });

      const session = Session.create();

      await expect(parallel.execute(session)).rejects.toThrow(
        'Unknown aggregation strategy: unknown_strategy',
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty results array in aggregation', async () => {
      // Create a source that consistently fails
      const alwaysFailingSource = {
        getContent: vi.fn().mockRejectedValue(new Error('Always fails')),
      };

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const parallel = new Parallel({
        sources: [{ source: alwaysFailingSource }],
      });
      const session = Session.create();
      const result = await parallel.execute(session);

      // Should return original session when all sources fail
      expect(result).toBe(session);

      warnSpy.mockRestore();
    });

    it('should handle session with existing messages', async () => {
      const sessionWithMessages = Session.create().addMessage({
        type: 'user',
        content: 'Existing message',
      });

      const parallel = new Parallel({
        sources: [{ source: mockLlmSource1 }],
      });
      const result = await parallel.execute(sessionWithMessages);

      const messages = Array.from(result.messages);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Existing message');
      expect(messages[1].content).toBe('Response from source 1');
    });
  });

  describe('Direct instantiation', () => {
    it('should support direct instantiation', () => {
      const parallel = new Parallel();
      expect(parallel).toBeInstanceOf(Parallel);
      expect(parallel.getSources()).toHaveLength(0);
    });

    it('should support constructor-based instantiation', () => {
      const parallel = new Parallel({
        sources: [
          { source: mockLlmSource1, repetitions: 2 },
          { source: mockLlmSource2 },
        ],
        strategy: 'best',
        scoringFunction: (session) => session.messages.length,
      });

      expect(parallel.getSources()).toHaveLength(2);
      expect(parallel.getStrategy()).toBe('best');
      expect(parallel.getScoringFunction()).toBeDefined();
    });

    it('should work with Agent parallel method using builder function', async () => {
      // Import Agent for testing
      const { Agent } = await import('../../../templates/agent');

      const agent = Agent.create()
        .system('You are a helpful assistant')
        .user('What is the weather?')
        .parallel((p) =>
          p
            .withSource(mockLlmSource1)
            .withSource(mockLlmSource2)
            .withStrategy('keep_all'),
        );

      const session = Session.create();
      const result = await agent.execute(session);

      expect(mockLlmSource1.getContent).toHaveBeenCalled();
      expect(mockLlmSource2.getContent).toHaveBeenCalled();

      const messages = Array.from(result.messages);
      expect(messages.length).toBeGreaterThanOrEqual(4); // system + user + 2 responses
    });

    it('should work with Agent parallel method using direct template', async () => {
      const { Agent } = await import('../../../templates/agent');

      const parallelTemplate = new Parallel({
        sources: [{ source: mockLlmSource1 }, { source: mockLlmSource2 }],
      });

      const agent = Agent.create()
        .system('You are a helpful assistant')
        .user('What is the weather?')
        .parallel(parallelTemplate);

      const session = Session.create();
      const result = await agent.execute(session);

      expect(mockLlmSource1.getContent).toHaveBeenCalled();
      expect(mockLlmSource2.getContent).toHaveBeenCalled();
    });

    it('should work with constructor configuration', () => {
      const parallel = new Parallel({
        sources: [
          { source: mockLlmSource1 },
          { source: mockLlmSource2, repetitions: 3 },
        ],
        strategy: 'best',
      });

      const sources = parallel.getSources();
      expect(sources).toHaveLength(2);
      expect(sources[0].repetitions).toBe(1);
      expect(sources[1].repetitions).toBe(3);
      expect(parallel.getStrategy()).toBe('best');
    });

    it('should accept LLMConfig objects in parallel builder', async () => {
      const { Agent } = await import('../../../templates/agent');

      // Mock Source.llm() to return a mock LlmSource
      const mockCreatedSource = {
        getContent: vi.fn().mockResolvedValue({
          content: 'Generated from LLMConfig',
          metadata: {},
        }),
      };

      // Mock the Source.llm chain
      const mockSourceLlm = {
        openai: vi.fn().mockReturnValue({
          temperature: vi.fn().mockReturnValue(mockCreatedSource),
        }),
        anthropic: vi.fn().mockReturnValue({
          temperature: vi.fn().mockReturnValue(mockCreatedSource),
        }),
      };

      // Mock Source.llm()
      vi.mocked(Source.llm).mockReturnValue(mockSourceLlm as any);

      const agent = Agent.create()
        .system('You are a helpful assistant')
        .user('What is the weather?')
        .parallel((p) =>
          p
            .withSource({ provider: 'openai', temperature: 0.2 }, 2)
            .withSource({ provider: 'anthropic', temperature: 0.8 })
            .withStrategy('keep_all'),
        );

      const session = Session.create();
      const result = await agent.execute(session);

      // Should have called Source.llm() to create sources
      expect(Source.llm).toHaveBeenCalled();
      expect(mockSourceLlm.openai).toHaveBeenCalled();
      expect(mockSourceLlm.anthropic).toHaveBeenCalled();

      const messages = Array.from(result.messages);
      expect(messages.length).toBeGreaterThanOrEqual(4); // system + user + 2+ responses
    });
  });
});
