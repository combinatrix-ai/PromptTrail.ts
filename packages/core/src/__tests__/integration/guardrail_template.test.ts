import { describe, it, expect, vi } from 'vitest';
import { createSession } from '../../session';
import {
  GuardrailTemplate,
  OnFailAction,
} from '../../templates/guardrail_template';
import { AssistantTemplate } from '../../templates';
import { BaseValidator } from '../../validators/base_validators';

// Mock model for testing
const mockModel = {
  send: vi.fn().mockResolvedValue({
    type: 'assistant',
    content: 'This is a test response',
    metadata: undefined,
  }),
};

// Create a simple test validator
class TestValidator extends BaseValidator {
  constructor(
    private shouldPass: boolean,
    private feedback?: string,
  ) {
    super();
  }

  async validate(content: string): Promise<any> {
    return this.createResult(this.shouldPass, {
      feedback: this.shouldPass
        ? undefined
        : this.feedback || 'Validation failed',
    });
  }
}

describe('GuardrailTemplate', () => {
  it('should pass validation when all validators pass', async () => {
    // Create a guardrail template with a passing validator
    const guardrailTemplate = new GuardrailTemplate({
      template: new AssistantTemplate({ model: mockModel as any }),
      validators: [new TestValidator(true)],
    });

    // Execute the template
    const session = await guardrailTemplate.execute(createSession());

    // Check that the validation passed
    const guardrailInfo = session.metadata.get('guardrail') as any;
    expect(guardrailInfo.passed).toBe(true);
    expect(guardrailInfo.attempt).toBe(1);
  });

  it('should retry when validation fails and onFail is RETRY', async () => {
    // Create a validator that fails on first attempt but passes on second
    let attempts = 0;
    const conditionalValidator = new TestValidator(
      false,
      'First attempt failed',
    );
    conditionalValidator.validate = async () => {
      attempts++;
      return {
        passed: attempts > 1, // Pass on second attempt
        feedback: attempts > 1 ? undefined : 'First attempt failed',
      };
    };

    // Create a guardrail template with the conditional validator
    const guardrailTemplate = new GuardrailTemplate({
      template: new AssistantTemplate({ model: mockModel as any }),
      validators: [conditionalValidator],
      onFail: OnFailAction.RETRY,
      maxAttempts: 3,
    });

    // Execute the template
    const session = await guardrailTemplate.execute(createSession());

    // Check that it retried and eventually passed
    const guardrailInfo = session.metadata.get('guardrail') as any;
    expect(guardrailInfo.passed).toBe(true);
    expect(guardrailInfo.attempt).toBe(2);
  });

  it('should throw an exception when validation fails and onFail is EXCEPTION', async () => {
    // Create a guardrail template with a failing validator and EXCEPTION action
    const guardrailTemplate = new GuardrailTemplate({
      template: new AssistantTemplate({ model: mockModel as any }),
      validators: [new TestValidator(false, 'Validation failed')],
      onFail: OnFailAction.EXCEPTION,
    });

    // Execute the template and expect it to throw
    await expect(guardrailTemplate.execute(createSession())).rejects.toThrow(
      'Validation failed',
    );
  });

  it('should continue when validation fails and onFail is CONTINUE', async () => {
    // Create a guardrail template with a failing validator and CONTINUE action
    const guardrailTemplate = new GuardrailTemplate({
      template: new AssistantTemplate({ model: mockModel as any }),
      validators: [new TestValidator(false, 'Validation failed')],
      onFail: OnFailAction.CONTINUE,
    });

    // Execute the template
    const session = await guardrailTemplate.execute(createSession());

    // Check that it continued despite failing validation
    const guardrailInfo = session.metadata.get('guardrail') as any;
    expect(guardrailInfo.passed).toBe(false);
    expect(guardrailInfo.attempt).toBe(1);
    expect(session.getLastMessage()?.content).toBe('This is a test response');
  });

  it('should call onRejection when validation fails', async () => {
    // Create a mock rejection handler
    const onRejection = vi.fn();

    // Create a guardrail template with a failing validator
    const guardrailTemplate = new GuardrailTemplate({
      template: new AssistantTemplate({ model: mockModel as any }),
      validators: [new TestValidator(false, 'Validation failed')],
      onFail: OnFailAction.CONTINUE,
      onRejection,
    });

    // Execute the template
    await guardrailTemplate.execute(createSession());

    // Check that onRejection was called
    expect(onRejection).toHaveBeenCalledTimes(1);
    expect(onRejection).toHaveBeenCalledWith(
      expect.objectContaining({ passed: false, feedback: 'Validation failed' }),
      'This is a test response',
      1,
    );
  });
});
