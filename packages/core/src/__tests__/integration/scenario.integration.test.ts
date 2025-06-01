import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as generateModule from '../../generate';
import { Session } from '../../session';
import { Scenario, StepTemplates } from '../../templates/scenario';

// Mock the generate module
vi.mock('../../generate', async () => {
  const actual = (await vi.importActual('../../generate')) as any;
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

describe('Scenario Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Compilation to Agent', () => {
    it('should compile a simple scenario to Agent with subroutines', async () => {
      // Mock generateText to simulate LLM responses
      let callCount = 0;
      const mockGenerateText = vi.mocked(generateModule.generateText);
      mockGenerateText.mockImplementation(
        async (session: any, options: any) => {
          callCount++;

          // First call: perform task
          if (callCount === 1) {
            return {
              type: 'assistant',
              content: 'Processing the task...',
              toolCalls: [],
            };
          }

          // Second call: check goal
          if (callCount === 2) {
            return {
              type: 'assistant',
              content: 'Checking if goal is satisfied',
              toolCalls: [
                {
                  id: 'call-1',
                  name: 'check_goal',
                  arguments: {
                    reasoning: 'Task has been completed',
                    is_satisfied: true,
                  },
                },
              ],
              toolResults: [
                {
                  toolCallId: 'call-1',
                  result: {
                    is_satisfied: true,
                    reasoning: 'Task has been completed',
                  },
                },
              ],
            };
          }

          return {
            type: 'assistant',
            content: 'Done',
            toolCalls: [],
          };
        },
      );

      const scenario = Scenario.system('Test assistant').step(
        'Complete a simple task',
      );

      const session = Session.create();
      const result = await scenario.execute(session);

      // Should have system message and assistant messages
      expect(result.messages.length).toBeGreaterThan(0);
      expect(result.getMessagesByType('system').length).toBeGreaterThan(0);
      expect(result.getMessagesByType('assistant').length).toBeGreaterThan(0);
    });

    it('should handle interactive steps with user input', async () => {
      let llmCallCount = 0;
      const mockUserResponses = ['John Doe', 'john@example.com'];
      let userCallCount = 0;

      // Mock CLI source for user input
      const mockCliSource = {
        getContent: async () => {
          const response = mockUserResponses[userCallCount] || 'default';
          userCallCount++;
          return response;
        },
      };

      // Mock generateText
      const mockGenerateText = vi.mocked(generateModule.generateText);
      mockGenerateText.mockImplementation(
        async (session: any, options: any) => {
          llmCallCount++;

          if (llmCallCount === 1) {
            // First step: ask for name
            return {
              type: 'assistant',
              content: 'I need to get the user name',
              toolCalls: [
                {
                  id: 'call-1',
                  name: 'ask_user',
                  arguments: { prompt: 'What is your name?' },
                },
              ],
              toolResults: [
                {
                  toolCallId: 'call-1',
                  result: { user_response: 'John Doe', is_valid: true },
                },
              ],
            };
          } else if (llmCallCount === 2) {
            // Check goal for first step
            return {
              type: 'assistant',
              content: 'Got the name',
              toolCalls: [
                {
                  id: 'call-2',
                  name: 'check_goal',
                  arguments: {
                    reasoning: 'User provided their name',
                    is_satisfied: true,
                  },
                },
              ],
              toolResults: [
                {
                  toolCallId: 'call-2',
                  result: {
                    is_satisfied: true,
                    reasoning: 'User provided their name',
                  },
                },
              ],
            };
          } else if (llmCallCount === 3) {
            // Second step: ask for email
            return {
              type: 'assistant',
              content: 'Now I need the email',
              toolCalls: [
                {
                  id: 'call-3',
                  name: 'ask_user',
                  arguments: { prompt: 'What is your email?' },
                },
              ],
              toolResults: [
                {
                  toolCallId: 'call-3',
                  result: { user_response: 'john@example.com', is_valid: true },
                },
              ],
            };
          } else {
            // Final check
            return {
              type: 'assistant',
              content: 'Got all information',
              toolCalls: [
                {
                  id: 'call-4',
                  name: 'check_goal',
                  arguments: {
                    reasoning: 'All information collected',
                    is_satisfied: true,
                  },
                },
              ],
              toolResults: [
                {
                  toolCallId: 'call-4',
                  result: {
                    is_satisfied: true,
                    reasoning: 'All information collected',
                  },
                },
              ],
            };
          }
        },
      );

      const scenario = Scenario.system('Information collector', {
        userInputSource: mockCliSource as any,
      })
        .step('Get user name', { allow_interaction: true })
        .step('Get user email', { allow_interaction: true });

      const result = await scenario.execute();

      expect(result.messages.length).toBeGreaterThan(0);
      expect(llmCallCount).toBeGreaterThan(0);
    });

    it('should respect max_attempts limit', async () => {
      let attemptCount = 0;

      const mockGenerateText = vi.mocked(generateModule.generateText);
      mockGenerateText.mockImplementation(
        async (session: any, options: any) => {
          attemptCount++;

          // Never satisfy the goal
          return {
            type: 'assistant',
            content: `Attempt ${attemptCount}`,
            toolCalls: [
              {
                id: `call-${attemptCount}`,
                name: 'check_goal',
                arguments: {
                  reasoning: 'Still working on it',
                  is_satisfied: false,
                },
              },
            ],
            toolResults: [
              {
                toolCallId: `call-${attemptCount}`,
                result: {
                  is_satisfied: false,
                  reasoning: 'Still working on it',
                },
              },
            ],
          };
        },
      );

      const scenario = Scenario.system('Test').step('Impossible task', {
        max_attempts: 3,
      });

      const result = await scenario.execute();

      // Should stop after 3 attempts
      expect(attemptCount).toBe(3);
      expect(result.messages.length).toBeGreaterThan(0);
    });

    it.skip('should use custom validation function', async () => {
      // FIXME: This test is skipped because mocking generateText bypasses actual tool execution.
      // The custom validator is part of the check_goal tool, which doesn't get executed when
      // generateText is mocked. This would require a different testing approach that allows
      // the ai-sdk to actually execute tools while controlling the LLM responses.
      let validationCalled = false;
      const customValidation = (session: any, goal: string) => {
        validationCalled = true;
        // Check if session has specific content
        const messages = session.getMessagesByType('assistant');
        return messages.some((m: any) => m.content.includes('magic word'));
      };

      let callCount = 0;
      const mockGenerateText = vi.mocked(generateModule.generateText);
      mockGenerateText.mockImplementation(
        async (session: any, options: any) => {
          callCount++;

          if (callCount === 1) {
            return {
              type: 'assistant',
              content: 'Trying without magic word',
              toolCalls: [
                {
                  id: 'call-1',
                  name: 'check_goal',
                  arguments: {
                    reasoning: 'Checking goal',
                    is_satisfied: true, // LLM thinks it's done
                  },
                },
              ],
              toolResults: [
                {
                  toolCallId: 'call-1',
                  result: { is_satisfied: false, reasoning: 'Checking goal' }, // But custom validator says no
                },
              ],
            };
          } else {
            return {
              type: 'assistant',
              content: 'Now with the magic word',
              toolCalls: [
                {
                  id: 'call-2',
                  name: 'check_goal',
                  arguments: {
                    reasoning: 'Checking again',
                    is_satisfied: true,
                  },
                },
              ],
              toolResults: [
                {
                  toolCallId: 'call-2',
                  result: { is_satisfied: true, reasoning: 'Checking again' }, // Now validator agrees
                },
              ],
            };
          }
        },
      );

      const scenario = Scenario.system('Test').step('Say the magic word', {
        is_satisfied: customValidation,
      });

      await scenario.execute();

      expect(validationCalled).toBe(true);
      expect(callCount).toBe(2);
    });
  });

  describe('Step Templates Integration', () => {
    it('should work with collectInfo template', async () => {
      const fields = ['name', 'age', 'location'];
      let satisfied = false;

      const mockGenerateText = vi.mocked(generateModule.generateText);
      mockGenerateText.mockImplementation(
        async (session: any, options: any) => {
          // Check if we have all fields mentioned in conversation
          const allContent = session.messages
            .map((m: any) => m.content)
            .join(' ')
            .toLowerCase();

          satisfied = fields.every((field) => allContent.includes(field));

          if (!satisfied) {
            return {
              type: 'assistant',
              content: `I'll collect ${fields.join(', ')}. Name: John, Age: 30, Location: NYC`,
              toolCalls: [],
            };
          } else {
            return {
              type: 'assistant',
              content: 'All information collected',
              toolCalls: [
                {
                  id: 'call-1',
                  name: 'check_goal',
                  arguments: {
                    reasoning: 'All fields present',
                    is_satisfied: true,
                  },
                },
              ],
              toolResults: [
                {
                  toolCallId: 'call-1',
                  result: {
                    is_satisfied: true,
                    reasoning: 'All fields present',
                  },
                },
              ],
            };
          }
        },
      );

      const scenario = Scenario.system('Collector').step(
        `Collect the following information: ${fields.join(', ')}`,
        StepTemplates.collectInfo(fields),
      );

      const result = await scenario.execute();

      expect(satisfied).toBe(true);
      expect(result.messages.length).toBeGreaterThan(0);
    });

    it('should work with untilCondition template', async () => {
      let messageCount = 0;
      const targetCount = 3;

      const mockGenerateText = vi.mocked(generateModule.generateText);
      mockGenerateText.mockImplementation(
        async (session: any, options: any) => {
          messageCount = session.messages.length;

          if (messageCount < targetCount) {
            return {
              type: 'assistant',
              content: `Message ${messageCount + 1}`,
              toolCalls: [],
            };
          } else {
            return {
              type: 'assistant',
              content: 'Condition met',
              toolCalls: [
                {
                  id: 'call-1',
                  name: 'check_goal',
                  arguments: {
                    reasoning: 'Have enough messages',
                    is_satisfied: true,
                  },
                },
              ],
              toolResults: [
                {
                  toolCallId: 'call-1',
                  result: {
                    is_satisfied: true,
                    reasoning: 'Have enough messages',
                  },
                },
              ],
            };
          }
        },
      );

      const scenario = Scenario.system('Test').step(
        'Generate messages until we have 3',
        StepTemplates.untilCondition(
          (session) => session.messages.length >= targetCount,
        ),
      );

      const result = await scenario.execute();

      expect(result.messages.length).toBeGreaterThanOrEqual(targetCount);
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle multiple steps with different configurations', async () => {
      const steps: string[] = [];

      const mockGenerateText = vi.mocked(generateModule.generateText);
      mockGenerateText.mockImplementation(
        async (session: any, options: any) => {
          // Determine which step we're in based on system and user messages
          const allMessages = session.messages;
          const lastMessage = allMessages[allMessages.length - 1];

          // Check both system and user messages for step indicators
          if (lastMessage?.content.includes('Step 1')) {
            steps.push('step1');
            return {
              type: 'assistant',
              content: 'Completed step 1',
              toolCalls: [
                {
                  id: 'call-1',
                  name: 'check_goal',
                  arguments: { reasoning: 'Done', is_satisfied: true },
                },
              ],
              toolResults: [
                {
                  toolCallId: 'call-1',
                  result: { is_satisfied: true, reasoning: 'Done' },
                },
              ],
            };
          } else if (lastMessage?.content.includes('Step 2')) {
            steps.push('step2');
            return {
              type: 'assistant',
              content: 'Processing step 2 with user interaction',
              toolCalls: [
                {
                  id: 'call-2',
                  name: 'ask_user',
                  arguments: { prompt: 'Continue?' },
                },
              ],
              toolResults: [
                {
                  toolCallId: 'call-2',
                  result: { user_response: 'yes', is_valid: true },
                },
              ],
            };
          } else if (lastMessage?.content.includes('Step 3')) {
            steps.push('step3');
            return {
              type: 'assistant',
              content: 'Quick step 3',
              toolCalls: [
                {
                  id: 'call-3',
                  name: 'check_goal',
                  arguments: { reasoning: 'Quick done', is_satisfied: true },
                },
              ],
              toolResults: [
                {
                  toolCallId: 'call-3',
                  result: { is_satisfied: true, reasoning: 'Quick done' },
                },
              ],
            };
          }

          // Default: mark as complete
          return {
            type: 'assistant',
            content: 'Step completed',
            toolCalls: [
              {
                id: 'call-default',
                name: 'check_goal',
                arguments: { reasoning: 'Done', is_satisfied: true },
              },
            ],
            toolResults: [
              {
                toolCallId: 'call-default',
                result: { is_satisfied: true, reasoning: 'Done' },
              },
            ],
          };
        },
      );

      const scenario = Scenario.system('Multi-step process')
        .process('Step 1: Initialize')
        .interact('Step 2: Get confirmation')
        .step('Step 3: Finalize', StepTemplates.quick());

      await scenario.execute();

      expect(steps).toContain('step1');
      expect(steps).toContain('step2');
      expect(steps).toContain('step3');
    });
  });
});
