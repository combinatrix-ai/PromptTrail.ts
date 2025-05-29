import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession } from '../../../session';
import { Source } from '../../../source';
import {
  Scenario,
  Scenarios,
  StepTemplates,
  isInteractiveStep,
} from '../../../templates/scenario';

// Mock the generate module instead of Source to avoid instanceof issues
vi.mock('../../../generate', async () => {
  const actual = (await vi.importActual('../../../generate')) as any;
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

describe('Scenario', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Basic API', () => {
    it('should create a scenario with system prompt', () => {
      const scenario = Scenario.system('You are a helpful assistant');
      expect(scenario).toBeDefined();
      expect(scenario).toHaveProperty('step');
      expect(scenario).toHaveProperty('execute');
    });

    it('should chain step calls fluently', () => {
      const scenario = Scenario.system('Test system')
        .step('Goal 1')
        .step('Goal 2', { max_attempts: 5 })
        .step('Goal 3', { allow_interaction: true });

      expect(scenario).toBeDefined();
    });

    it('should support convenience methods', () => {
      const scenario = Scenario.system('Test')
        .interact('Get input')
        .process('Process data')
        .collect(['name', 'email'])
        .decide('Choose path');

      expect(scenario).toBeDefined();
    });
  });

  describe('Step Options Typing', () => {
    it('should accept interactive step options', () => {
      const scenario = Scenario.system('Test').step('Interactive goal', {
        allow_interaction: true,
        interaction_prompt: 'Custom prompt',
        validate_input: (input) => input.length > 0,
        max_attempts: 5,
      });

      expect(scenario).toBeDefined();
    });

    it('should accept non-interactive step options', () => {
      const scenario = Scenario.system('Test').step('Process goal', {
        allow_interaction: false,
        show_progress: true,
        max_attempts: 3,
      });

      expect(scenario).toBeDefined();
    });

    it('should handle step options with defaults', () => {
      const scenario = Scenario.system('Test').step('Goal'); // Should use default options

      expect(scenario).toBeDefined();
    });
  });

  describe('Type Guards', () => {
    it('should correctly identify interactive steps', () => {
      const interactiveOptions = { allow_interaction: true as const };
      const nonInteractiveOptions = { allow_interaction: false as const };
      const defaultOptions = {};

      expect(isInteractiveStep(interactiveOptions)).toBe(true);
      expect(isInteractiveStep(nonInteractiveOptions)).toBe(false);
      expect(isInteractiveStep(defaultOptions)).toBe(false);
    });
  });

  describe('Step Templates', () => {
    it('should create askUser template', () => {
      const template = StepTemplates.askUser({
        prompt: 'Enter name:',
        validate: (input) => input.length > 2,
        maxAttempts: 3,
      });

      expect(template.allow_interaction).toBe(true);
      expect(template.interaction_prompt).toBe('Enter name:');
      expect(template.validate_input).toBeDefined();
      expect(template.max_attempts).toBe(3);
    });

    it('should create process template', () => {
      const template = StepTemplates.process({
        maxAttempts: 5,
        showProgress: true,
      });

      expect(template.allow_interaction).toBe(false);
      expect(template.show_progress).toBe(true);
      expect(template.max_attempts).toBe(5);
    });

    it('should create untilCondition template', () => {
      const condition = (session: any) => session.messages.length > 5;
      const template = StepTemplates.untilCondition(condition, {
        maxAttempts: 20,
      });

      expect(template.allow_interaction).toBe(false);
      expect(template.max_attempts).toBe(20);
      expect(template.is_satisfied).toBeDefined();
    });

    it('should create collectInfo template', () => {
      const template = StepTemplates.collectInfo(['name', 'email', 'phone']);

      expect(template.allow_interaction).toBe(true);
      expect(template.is_satisfied).toBeDefined();
    });

    it('should create quick template', () => {
      const template = StepTemplates.quick({ maxAttempts: 2 });

      expect(template.allow_interaction).toBe(false);
      expect(template.max_attempts).toBe(2);
    });
  });

  describe('Scenario Configuration', () => {
    it('should accept custom user input source', () => {
      const customSource = Source.cli('Custom prompt: ');
      const scenario = Scenario.system('Test', {
        userInputSource: customSource,
      });

      expect(scenario).toBeDefined();
    });

    it('should accept custom tools', () => {
      const mockTool = {
        description: 'Mock tool',
        parameters: {},
        execute: async () => ({ result: 'mock' }),
      };

      const scenario = Scenario.system('Test', {
        tools: { mockTool },
      });

      expect(scenario).toBeDefined();
    });
  });

  describe('Pre-built Scenarios', () => {
    it('should create research assistant scenario', () => {
      const scenario = Scenarios.researchAssistant();
      expect(scenario).toBeDefined();
      expect(scenario).toHaveProperty('execute');
    });

    it('should create code reviewer scenario', () => {
      const scenario = Scenarios.codeReviewer();
      expect(scenario).toBeDefined();
      expect(scenario).toHaveProperty('execute');
    });

    it('should create data collector scenario', () => {
      const scenario = Scenarios.dataCollector(['name', 'email', 'phone']);
      expect(scenario).toBeDefined();
      expect(scenario).toHaveProperty('execute');
    });
  });

  describe('Execution', () => {
    it('should execute a simple scenario', async () => {
      const scenario = Scenario.system('Test assistant').step('Process data');

      const session = createSession();

      // Mock the execution to avoid actual LLM calls
      vi.spyOn(scenario as any, 'compile').mockReturnValue({
        execute: vi.fn(async (s) =>
          s.addMessage({
            type: 'assistant',
            content: 'Task completed',
          }),
        ),
      });

      const result = await scenario.execute(session);

      expect(result).toBeDefined();
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toBe('Task completed');
    });

    it('should compile steps into Agent-based implementation', () => {
      const scenario = Scenario.system('Test')
        .step('Goal 1', { allow_interaction: true })
        .step('Goal 2', { max_attempts: 5 });

      // Access private compile method through type assertion
      const compiled = (scenario as any).compile();

      expect(compiled).toBeDefined();
      expect(compiled.execute).toBeDefined();
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle mixed step types', () => {
      const scenario = Scenario.system('Complex assistant')
        .interact('Get user name')
        .process('Validate name')
        .interact('Confirm name', {
          validate_input: (input) =>
            ['yes', 'no'].includes(input.toLowerCase()),
        })
        .process('Save to database')
        .step('Custom goal', {
          allow_interaction: false,
          is_satisfied: (session) => {
            const messages = session.getMessagesByType('assistant');
            return messages.length >= 3;
          },
        });

      expect(scenario).toBeDefined();
    });

    it('should support decision branches', () => {
      const scenario = Scenario.system('Decision maker')
        .interact('What would you like to do?')
        .decide('Choose the best approach', {
          branches: {
            search: 'Search for information',
            calculate: 'Perform calculations',
            generate: 'Generate content',
          },
        })
        .process('Execute chosen approach');

      expect(scenario).toBeDefined();
    });
  });

  describe('Validation', () => {
    it('should validate interactive step inputs', () => {
      const options: any = StepTemplates.askUser({
        validate: (input) => ({
          valid: input.includes('@'),
          message: 'Must be an email',
        }),
      });

      expect(options.validate_input).toBeDefined();

      const result = options.validate_input('test');
      expect(result).toEqual({ valid: false, message: 'Must be an email' });

      const validResult = options.validate_input('test@example.com');
      expect(validResult).toEqual({ valid: true, message: 'Must be an email' });
    });

    it('should handle boolean validation returns', () => {
      const options: any = StepTemplates.askUser({
        validate: (input) => input.length > 5,
      });

      expect(options.validate_input('short')).toBe(false);
      expect(options.validate_input('long enough')).toBe(true);
    });
  });

  describe('Type Safety', () => {
    it('should enforce correct types for step options', () => {
      // This is a compile-time test, but we can verify runtime behavior

      // Interactive step
      const interactiveStep = () =>
        Scenario.system('Test').step('Goal', {
          allow_interaction: true,
          interaction_prompt: 'Prompt',
          // TypeScript would error if we tried to add show_progress here
        });

      // Non-interactive step
      const nonInteractiveStep = () =>
        Scenario.system('Test').step('Goal', {
          allow_interaction: false,
          show_progress: true,
          // TypeScript would error if we tried to add interaction_prompt here
        });

      expect(interactiveStep).not.toThrow();
      expect(nonInteractiveStep).not.toThrow();
    });
  });
});
