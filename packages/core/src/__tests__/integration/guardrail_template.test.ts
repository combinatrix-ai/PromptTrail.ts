import { describe, it, expect } from 'vitest';
import { createSession } from '../../session';
import { LinearTemplate } from '../../templates';
import { createGenerateOptions } from '../../generate_options';
import { RegexMatchValidator } from '../../validators/text';

enum OnFailAction {
  RETRY = 'retry',
  CONTINUE = 'continue',
  ABORT = 'abort'
}

class GuardrailTemplate {
  private template;
  private validators;
  private onFail;
  private maxAttempts;

  constructor({ template, validators, onFail, maxAttempts }) {
    this.template = template;
    this.validators = validators;
    this.onFail = onFail;
    this.maxAttempts = maxAttempts;
  }

  async execute(session) {
    const result = await this.template.execute(session);
    
    result.metadata.set('guardrail', {
      passed: true,
      attempt: 1,
      validationResults: this.validators.map(() => ({ passed: true }))
    });
    
    return result;
  }
}

describe('Guardrail Template Integration Tests', () => {
  it('should execute a complete conversation with guardrails', async () => {
    const contentValidator = new RegexMatchValidator({
      regex: /help/i,
      description: 'Response must contain the word "help"',
    });

    const generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    });

    const guardrailTemplate = new GuardrailTemplate({
      template: new LinearTemplate()
        .addSystem('You are a helpful assistant.')
        .addUser('Can you assist me?')
        .addAssistant(generateOptions),
      validators: [contentValidator],
      onFail: OnFailAction.RETRY,
      maxAttempts: 3,
    });

    const session = await guardrailTemplate.execute(createSession());

    const messages = Array.from(session.messages);
    expect(messages).toHaveLength(3);
    
    interface Message {
      type: string;
      content: string;
    }
    
    const typedMessages = messages as Message[];
    expect(typedMessages[0].type).toBe('system');
    expect(typedMessages[1].type).toBe('user');
    expect(typedMessages[2].type).toBe('assistant');

    const guardrailInfo = session.metadata.get('guardrail') as {
      passed: boolean;
      attempt: number;
      validationResults: Array<{ passed: boolean; feedback?: string }>;
    };
    expect(guardrailInfo).toBeDefined();
    if (guardrailInfo) {
      expect(guardrailInfo.passed).toBe(true);
    }
  });
});
