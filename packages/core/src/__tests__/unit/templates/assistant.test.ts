import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AssistantTemplate } from '../../../templates/assistant';
import { createSession } from '../../../session';
import { StaticSource } from '../../../content_source';
import type { ModelOutput } from '../../../content_source'; // Use "import type"
import { createGenerateOptions } from '../../../generate_options';
import { createMetadata } from '../../../metadata';
import { generateText } from '../../../generate';
import { CustomValidator } from '../../../validators/custom';
import { createWeatherTool } from '../../utils';

// Mock the generate module
vi.mock('../../../generate', () => ({
  generateText: vi.fn(),
}));

describe('AssistantTemplate', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should handle ContentSource on constructor', async () => {
    // Create a mock ModelOutput source
    // StaticSource should provide ModelOutput for AssistantTemplate
    // StaticSource is not generic, pass the ModelOutput object directly
    // StaticSource constructor expects a string
    const mockSource = new StaticSource('This is a test response');

    // Create an AssistantTemplate with the source
    const template = new AssistantTemplate(mockSource);

    // Verify the template has the content source
    expect(template.getContentSource()).toBeDefined();

    // Execute the template and verify the result
    const session = await template.execute(createSession());
    expect(session.getLastMessage()!.type).toBe('assistant');
    expect(session.getLastMessage()!.content).toBe('This is a test response');
  });

  it('should handle text on constructor', async () => {
    // Create an AssistantTemplate with a static text
    const template = new AssistantTemplate('This is static content');

    // Execute the template and verify the result
    const session = await template.execute(createSession());
    expect(session.getLastMessage()!.type).toBe('assistant');
    expect(session.getLastMessage()!.content).toBe('This is static content');
  });

  it('should handle GenerateOptions on constructor', async () => {
    // Mock the generate function to return a test response
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'Generated content',
      metadata: createMetadata(),
    });

    // Create GenerateOptions
    const options = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4',
      },
      temperature: 0.7,
    });

    // Create an AssistantTemplate with the generate options
    const template = new AssistantTemplate(options);

    // Execute the template and verify the result
    const session = await template.execute(createSession());
    expect(session.getLastMessage()!.type).toBe('assistant');
    expect(session.getLastMessage()!.content).toBe('Generated content');

    // Verify the generate function was called with the correct arguments
    expect(generateText).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: expect.objectContaining({
          type: 'openai',
          modelName: 'gpt-4',
        }),
      }),
    );
  });

  it('should throw error during instantiation if no ContentSource is provided', () => {
    // Expect the constructor to throw an error
    expect(() => {
      // Removed unused @ts-expect-error
      new AssistantTemplate();
    }).toThrow('Failed to initialize content source');
  });

  it('should support interpolation in static content', async () => {
    // Create a session with metadata
    const session = createSession();
    session.metadata.set('username', 'Alice');

    // Create an AssistantTemplate with interpolated text
    const template = new AssistantTemplate('Hello, ${username}!');

    // Execute the template and verify the result
    const result = await template.execute(session);
    expect(result.getLastMessage()?.content).toBe('Hello, Alice!');
  });

  it('should validate content with a custom validator', async () => {
    // Create a custom validator that only accepts content containing a specific word
    const validator = new CustomValidator((content) => {
      return content.includes('valid')
        ? { isValid: true }
        : {
            isValid: false,
            instruction: 'Content must include the word "valid"',
          };
    });

    // Create an AssistantTemplate with valid content and the validator
    const validTemplate = new AssistantTemplate(
      'This is valid content',
      validator,
    );

    // Execute the template and verify it passes validation
    const validResult = await validTemplate.execute(createSession());
    expect(validResult.getLastMessage()?.content).toBe('This is valid content');

    // Create an AssistantTemplate with invalid content and the validator
    const invalidTemplate = new AssistantTemplate('This is invalid', validator);

    // Execute the template and verify it fails validation
    // Expect the execute method to throw the specific validation error
    await expect(invalidTemplate.execute(createSession())).rejects.toThrow(
      'Assistant content validation failed', // Matches error thrown on line 90 in assistant.ts
    );
  });

  it('should handle LlmSource with toolCalls', async () => {
    // Mock the generate function to return a response with tool calls
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'I need to check the weather',
      toolCalls: [
        {
          name: 'weather',
          arguments: { location: 'Tokyo' },
          id: 'tool-123',
        },
      ],
      metadata: createMetadata(),
    });

    const weatherTool = createWeatherTool();

    // Create GenerateOptions with the weather tool
    const options = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4',
      },
    }).addTool('weather', weatherTool);

    // Create an AssistantTemplate with the generate options
    const template = new AssistantTemplate(options);

    // Execute the template and verify the result
    const session = await template.execute(createSession());
    expect(session.getLastMessage()?.type).toBe('assistant');
    expect(session.getLastMessage()?.content).toBe(
      'I need to check the weather',
    );
    // TODO: Fix this type error, toolCalls argument should exist on Message
    expect(session.getLastMessage()?.toolCalls).toEqual([
      {
        name: 'weather',
        arguments: { location: 'Tokyo' },
        id: 'tool-123',
      },
    ]);
  });

  it('should retry when validation fails and maxAttempts > 1', async () => {
    // Mock the generate function to return different responses on each call
    vi.mocked(generateText)
      .mockResolvedValueOnce({
        type: 'assistant',
        content: 'This is invalid',
        metadata: createMetadata(),
      })
      .mockResolvedValueOnce({
        type: 'assistant',
        content: 'This is valid content',
        metadata: createMetadata(),
      });

    // Create a custom validator
    const validator = new CustomValidator((content) => {
      return content.includes('valid')
        ? { isValid: true }
        : {
            isValid: false,
            instruction: 'Content must include the word "valid"',
          };
    });

    // Create GenerateOptions
    const options = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4',
      },
    });

    // Create an AssistantTemplate with validation options
    const template = new AssistantTemplate(options, {
      validator,
      maxAttempts: 2,
      raiseError: true,
    });

    // Execute the template and verify it succeeds on the second attempt
    const session = await template.execute(createSession());
    expect(session.getLastMessage()?.content).toBe('This is valid content');
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('should not throw error when validation fails and raiseError is false', async () => {
    // Mock the generate function to return an invalid response
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'This is invalid',
      metadata: createMetadata(),
    });

    // Create a custom validator
    const validator = new CustomValidator((content) => {
      return content.includes('valid')
        ? { isValid: true }
        : {
            isValid: false,
            instruction: 'Content must include the word "valid"',
          };
    });

    // Create GenerateOptions
    const options = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: 'test-api-key',
        modelName: 'gpt-4',
      },
    });

    // Create an AssistantTemplate with validation options and raiseError set to false
    const template = new AssistantTemplate(options, {
      validator,
      maxAttempts: 1,
      raiseError: false,
    });

    // Execute the template and verify it doesn't throw an error
    const session = await template.execute(createSession());
    expect(session.getLastMessage()?.content).toBe('This is invalid');
  });
});
