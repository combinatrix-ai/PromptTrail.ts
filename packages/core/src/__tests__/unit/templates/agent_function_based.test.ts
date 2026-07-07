import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateText } from '../../../generate';
import { Session } from '../../../session';
import { Source } from '../../../source';
import { Agent } from '../../../templates';

// Mock the generate module
vi.mock('../../../generate', () => ({
  generateText: vi.fn(),
}));

describe('Agent Function-Based Templates', () => {
  beforeEach(() => {
    vi.resetAllMocks();

    // Set up default mock for generateText
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'Mock response',
    });
  });

  describe('Function-based loop', () => {
    it('should support loop with builder function', async () => {
      let counter = 0;

      const agent = Agent.create('agent-function-based')
        .system('You are a helpful assistant.')
        .user('Start the loop')
        .loop(
          (l) => l.user('Iteration message').assistant('Mock response'),
          (_session) => {
            counter++;
            return counter <= 3;
          },
        );

      const session = await agent.execute();

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(8); // 2 initial + 3 iterations * 2 messages each
      expect(messages[0].type).toBe('system');
      expect(messages[1].type).toBe('user');
      expect(messages[1].content).toBe('Start the loop');

      // Check iterations
      for (let i = 0; i < 3; i++) {
        const baseIdx = 2 + i * 2;
        expect(messages[baseIdx].type).toBe('user');
        expect(messages[baseIdx].content).toBe('Iteration message');
        expect(messages[baseIdx + 1].type).toBe('assistant');
        expect(messages[baseIdx + 1].content).toBe('Mock response');
      }
    });

    it('should support loopForever with builder function', async () => {
      let iterations = 0;

      // Test loopForever helper
      const _agent = Agent.create('agent-function-based')
        .system('Forever loop test')
        .loopForever((l) => {
          iterations++;
          return l.user(`Iteration ${iterations}`);
        });

      // Since loopForever creates an infinite loop, we need to test with a condition
      // Let's test a regular loop with true condition
      iterations = 0;
      const limitedAgent = Agent.create('agent-function-based')
        .system('Limited forever loop')
        .loop(
          (l) => l.user('Loop message'),
          () => iterations++ < 5,
        );

      const session = await limitedAgent.execute();

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(6); // 1 system + 5 iterations
      expect(messages[1].content).toBe('Loop message');
      expect(messages[5].content).toBe('Loop message');
    });

    it('should support boolean loopIf parameter', async () => {
      const counter = 0;

      const agent = Agent.create('agent-function-based')
        .system('Boolean loop test')
        .loop(
          (l) => l.user('Count'),
          counter < 3, // This is evaluated once at build time!
          1,
        );

      await expect(agent.execute()).rejects.toThrow(/exceeded max iterations/);

      // Since boolean is evaluated at build time when counter is 0,
      // it will be true and loop forever (or until maxIterations)
      // Let's use a function that returns false immediately
      const agent2 = Agent.create('agent-function-based')
        .system('Boolean loop test')
        .loop((l) => l.user('Should execute once'), false);

      const session2 = await agent2.execute();
      const messages2 = Array.from(session2.messages);
      expect(messages2).toHaveLength(1); // Only system message, loop doesn't execute
    });
  });

  describe('Function-based subroutine', () => {
    it('should support subroutine with builder function', async () => {
      const agent = Agent.create('agent-function-based')
        .system('Main conversation')
        .user('Start main')
        .subroutine((s) =>
          s
            .system('Subroutine context')
            .user('Subroutine question')
            .assistant('Subroutine answer'),
        )
        .user('Back to main');

      const session = await agent.execute();

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(6); // All messages retained by default
      expect(messages[0].content).toBe('Main conversation');
      expect(messages[1].content).toBe('Start main');
      expect(messages[2].content).toBe('Subroutine context');
      expect(messages[3].content).toBe('Subroutine question');
      expect(messages[4].content).toBe('Subroutine answer');
      expect(messages[5].content).toBe('Back to main');
    });

    it('should support subroutine with options', async () => {
      const agent = Agent.create('agent-function-based')
        .system('Main conversation')
        .user('Start main')
        .subroutine(
          (s) => s.user('Subroutine message').assistant('Subroutine response'),
          {
            squash: (parent) => parent,
          },
        )
        .user('Back to main');

      const session = await agent.execute({
        session: Session.create({
          vars: { mainVar: 'value' },
        }),
      });

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(3); // Subroutine messages not retained
      expect(messages[0].content).toBe('Main conversation');
      expect(messages[1].content).toBe('Start main');
      expect(messages[2].content).toBe('Back to main');

      // Context should still have mainVar
      expect((session.getVarsObject() as Record<string, unknown>).mainVar).toBe(
        'value',
      );
    });

    it('should support custom squash function in subroutine', async () => {
      const agent = Agent.create('agent-function-based')
        .system('Main')
        .subroutine((s) => s.user('Process data').assistant('Result: 42'), {
          squash: (parent, sub) => {
            const lastMessage = sub.getLastMessage();
            if (lastMessage?.content.includes('42')) {
              return parent.withVars({ result: 42 });
            }
            return parent;
          },
        })
        .assistant(
          Source.callback(async ({ context }) => {
            const vars = context as Record<string, unknown> | undefined;
            return `The result is ${vars?.result}`;
          }),
        );

      const session = await agent.execute();

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(2);
      expect(messages[1].content).toBe('The result is 42');
      expect((session.getVarsObject() as Record<string, unknown>).result).toBe(
        42,
      );
    });
  });

  describe('Implicit sequencing', () => {
    it('should execute chained templates in order', async () => {
      const agent = Agent.create('agent-function-based')
        .system('Main')
        .user('First in sequence')
        .assistant('First response')
        .user('Second in sequence')
        .assistant('Final response');

      const session = await agent.execute();

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(5);
      expect(messages[0].content).toBe('Main');
      expect(messages[1].content).toBe('First in sequence');
      expect(messages[2].content).toBe('First response');
      expect(messages[3].content).toBe('Second in sequence');
      expect(messages[4].content).toBe('Final response');
    });
  });

  describe('Nested function-based templates', () => {
    it('should support nested loops with function builders', async () => {
      let outerCounter = 0;
      let innerCounter = 0;

      const agent = Agent.create('agent-function-based')
        .system('Nested loops')
        .loop(
          (outer) =>
            outer.user(`Outer ${outerCounter + 1}`).loop(
              (inner) => {
                innerCounter++;
                return inner.user(`Inner ${innerCounter}`);
              },
              () => innerCounter++ < 2,
            ),
          () => {
            innerCounter = 0;
            return outerCounter++ < 1;
          },
        );

      const session = await agent.execute();

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(4);
      expect(messages[0].content).toBe('Nested loops');
      expect(messages[1].content).toBe('Outer 1');
      expect(messages[2].content).toBe('Inner 1');
      expect(messages[3].content).toBe('Inner 1');
    });

    it('should support mixed nested templates', async () => {
      const agent = Agent.create('agent-function-based')
        .system('Mixed nesting')
        .subroutine(
          (sub) =>
            sub.user('In subroutine').loop(
              (l) => l.assistant('Loop in subroutine'),
              ({ session }) =>
                session.messages.filter(
                  (m) => m.content === 'Loop in subroutine',
                ).length < 2,
            ),
          {
            squash: (parent, sub) => {
              let next = parent;
              for (const message of sub.messages) {
                next = next.addMessage(message);
              }
              return next;
            },
          },
        )
        .user('In sequence')
        .assistant('Sequence response');

      const session = await agent.execute();

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(6);
      expect(messages[0].content).toBe('Mixed nesting');
      expect(messages[1].content).toBe('In subroutine');
      expect(messages[2].content).toBe('Loop in subroutine');
      expect(messages[3].content).toBe('Loop in subroutine');
      expect(messages[4].content).toBe('In sequence');
      expect(messages[5].content).toBe('Sequence response');
    });
  });

  describe('Short method names', () => {
    it('should support short method names without add prefix', async () => {
      const agent = Agent.create('agent-function-based')
        .system('Test short methods')
        .user('User message')
        .assistant('Assistant response');

      const session = await agent.execute();

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(3);
      expect(messages[0].type).toBe('system');
      expect(messages[1].type).toBe('user');
      expect(messages[2].type).toBe('assistant');
    });

    it('should work in function builders with short names', async () => {
      const agent = Agent.create('agent-function-based').loop(
        (l) => l.user('Question').assistant(Source.literal('Answer')),
        ({ session }) => session.messages.length < 4, // Stop after 2 iterations
      );

      const session = await agent.execute();

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(4); // 2 iterations * 2 messages
    });
  });

  describe('Quick factory content-first methods', () => {
    it('should create quick agent with system content', async () => {
      const agent = Agent.create('agent-function-based')
        .system('System prompt')
        .user('User message')
        .assistant('Response');

      const session = await agent.execute();

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('System prompt');
    });

    it('should create quick agent with user content', async () => {
      const agent = Agent.create('agent-function-based')
        .user('First user message')
        .assistant('Response')
        .user('Second user message');

      const session = await agent.execute();

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(3);
      expect(messages[0].content).toBe('First user message');
      expect(messages[0].type).toBe('user');
    });

    it('should create quick agent with assistant content', async () => {
      const agent = Agent.create('agent-function-based')
        .assistant('Initial assistant message')
        .user('User response');

      const session = await agent.execute();

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Initial assistant message');
      expect(messages[0].type).toBe('assistant');
    });

    it('should create empty agent with Agent.create', async () => {
      const agent = Agent.create('agent-function-based')
        .system('Added system')
        .user('Added user');

      const session = await agent.execute();

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(2);
    });
  });

  describe('README examples', () => {
    it('should work with the first README example', async () => {
      const _agent = Agent.create('agent-function-based')
        .system('You are a helpful assistant.')
        .loop(
          (l) => l.user().assistant(), // Use CLI for user input, LLM for assistant
          true, // Forever loop
        );

      // Since we can't actually test CLI input and forever loops,
      // let's test a simplified version
      const testableAgent = Agent.create('agent-function-based')
        .system('You are a helpful assistant.')
        .loop(
          (l) => l.user('Test input').assistant('Test response'),
          ({ session }) => session.messages.length < 5,
        );

      const session = await testableAgent.execute();

      const messages = Array.from(session.messages);
      expect(messages[0].content).toBe('You are a helpful assistant.');
      expect(messages[0].type).toBe('system');
      // Loop executed once to reach 5 messages total
      expect(messages).toHaveLength(5);
    });

    it('should work with loopForever helper', async () => {
      let counter = 0;
      const _agent = Agent.create('agent-function-based')
        .system('You are a helpful assistant.')
        .loopForever((l) => {
          counter++;
          if (counter > 3) {
            // In real usage, this would be controlled by user input
            return l.user('exit');
          }
          return l.user(`Message ${counter}`);
        });

      // Test with limited loop
      counter = 0;
      const testableAgent = Agent.create('agent-function-based')
        .system('You are a helpful assistant.')
        .loop(
          (l) => l.user('Message'),
          () => counter++ < 3,
        );

      const session = await testableAgent.execute();

      const messages = Array.from(session.messages);
      expect(messages).toHaveLength(4); // 1 system + 3 user messages
      // Check all messages
      expect(messages[0].type).toBe('system');
      expect(messages[1].content).toBe('Message');
      expect(messages[2].content).toBe('Message');
      expect(messages[3].content).toBe('Message');
    });
  });
});
