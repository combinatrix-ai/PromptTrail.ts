import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSession } from '../../session';
import { type IValidator, type TValidationResult } from '../../validators/base';
import { createMetadata } from '../../metadata';

vi.mock('../../generate');

import { generateText } from '../../generate';
import {
  createGenerateOptions,
  type GenerateOptions,
} from '../../generate_options';
import { AssistantTemplate } from '../../templates';

class TestValidator implements IValidator {
  private description: string;

  constructor(
    private shouldPass: boolean,
    private feedback?: string,
  ) {
    this.description = feedback || (shouldPass ? 'Valid content' : 'Invalid content');
  }

  async validate(): Promise<TValidationResult> {
    return this.shouldPass
      ? { isValid: true }
      : { isValid: false, instruction: this.feedback || 'Validation failed' };
  }
  
  getDescription(): string {
    return this.description || 'Test validator';
  }
  
  getErrorMessage(): string {
    return this.feedback || 'Validation failed';
  }
}

describe('AssistantTemplate with Validator', () => {
  let generateOptions: GenerateOptions;

  beforeEach(() => {
    vi.clearAllMocks();

    generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    });

    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'This is a test response',
      metadata: createMetadata(),
    });
  });

  it('should pass validation when validator passes', async () => {
    const assistantTemplate = new AssistantTemplate(
      generateOptions,
      {
        validator: new TestValidator(true),
        maxAttempts: 1,
        raiseError: true
      }
    );

    const session = await assistantTemplate.execute(createSession());
    
    expect(session.getLastMessage()?.content).toBe('This is a test response');
  });
  
  it('should retry when validation fails and maxAttempts > 1', async () => {
    let attempts = 0;
    vi.mocked(generateText).mockImplementation(async () => {
      attempts++;
      return {
        type: 'assistant',
        content: `Response attempt ${attempts}`,
        metadata: createMetadata(),
      };
    });
 
    
 
    const conditionalValidator: IValidator = {
      validate: async (content): Promise<TValidationResult> => {
        return content.includes('2')
          ? { isValid: true }
          : { isValid: false, instruction: 'Need attempt 2' };
      },
      getDescription: () => 'Conditional validator',
      getErrorMessage: () => 'Validation failed'
    };
    
    const assistantTemplate = new AssistantTemplate(
      generateOptions,
      {
        validator: conditionalValidator,
        maxAttempts: 2,
        raiseError: true
      }
    );
    
    const session = await assistantTemplate.execute(createSession());
    
    expect(attempts).toBe(2);
    expect(session.getLastMessage()?.content).toBe('Response attempt 2');
  });
  
  it('should throw an exception when validation fails and raiseError is true', async () => {
    const assistantTemplate = new AssistantTemplate(
      generateOptions,
      {
        validator: new TestValidator(false, 'Validation failed'),
        maxAttempts: 1,
        raiseError: true
      }
    );
    
    await expect(assistantTemplate.execute(createSession())).rejects.toThrow(
      'Validation failed'
    );
  });
  
  it('should not throw when validation fails and raiseError is false', async () => {
    const assistantTemplate = new AssistantTemplate(
      generateOptions,
      {
        validator: new TestValidator(false, 'Validation failed'),
        maxAttempts: 1,
        raiseError: false
      }
    );
    
    const session = await assistantTemplate.execute(createSession());
    
    expect(session.getLastMessage()?.content).toBe('This is a test response');
  });
});
