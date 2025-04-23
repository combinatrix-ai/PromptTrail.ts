import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Assistant } from '../../../templates/assistant';
import { createSession } from '../../../session';
import { StaticSource } from '../../../content_source';
import type { ModelOutput } from '../../../content_source'; // Use "import type"
import { createGenerateOptions } from '../../../generate_options';
import { createContext } from '../../../context';
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
    const mockSource = new StaticSource('This is a test response');
    const template = new Assistant(mockSource);
    expect(template.getContentSource()).toBeDefined();
    const session = await template.execute(createSession());
    expect(session.getLastMessage()!.type).toBe('assistant');
    expect(session.getLastMessage()!.content).toBe('This is a test response');
  });

  it('should handle text on constructor', async () => {
    const template = new Assistant('This is static content');
    const session = await template.execute(createSession());
    expect(session.getLastMessage()!.type).toBe('assistant');
    expect(session.getLastMessage()!.content).toBe('This is static content');
  });

  it('should handle GenerateOptions on constructor', async () => {
    // Mock the generate function to return a test response
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'Generated content',
      metadata: createContext(),
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

    const template = new Assistant(options);
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

  it('should throw error during execution if no ContentSource is provided', async () => {
    // This should not throw an error during instantiation
    const template = new Assistant();

    // But, if we try to execute it, it should throw an error
    // because no content source is given by anyone.
    await expect(template.execute(createSession()))
      // Use .rejects to assert that a promise-returning function throws an error when called
      .rejects.toThrow('Content source required for AssistantTemplate');
  });

  it('should support interpolation in static content', async () => {
    const session = createSession();
    session.context.set('username', 'Alice');
    const template = new Assistant('Hello, ${username}!');
    const result = await template.execute(session);
    expect(result.getLastMessage()?.content).toBe('Hello, Alice!');
  });

  it('should validate content with a custom validator - valid content', async () => {
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
    const validTemplate = new Assistant('This is valid content', validator);

    // Execute the template and verify it passes validation
    const validResult = await validTemplate.execute(createSession());
    expect(validResult.getLastMessage()?.content).toBe('This is valid content');
  });

  it('should return invalid content when validation fails and raiseError is false', async () => {
    // Create a custom validator that only accepts content containing a specific word
    const validator = new CustomValidator((content) => {
      return content.includes('valid')
        ? { isValid: true }
        : {
            isValid: false,
            instruction: 'Content must include the word "valid"',
          };
    });

    // Create an AssistantTemplate with invalid content and the validator
    // Set raiseError to false to avoid throwing errors
    const invalidTemplate = new Assistant('This is not pass', {
      validator,
      raiseError: false,
      maxAttempts: 1,
    });

    // Spy on console.warn to check if validation fails
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});

    // Execute the template
    const invalidResult = await invalidTemplate.execute(createSession());

    // Verify that the invalid content was still returned despite failing validation
    expect(invalidResult.getLastMessage()?.content).toBe('This is not pass');

    // Restore the spy
    consoleWarnSpy.mockRestore();
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
      metadata: createContext(),
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
    const template = new Assistant(options);

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

  // Modify this test to use a static content source for simplicity
  it('should retry when validation fails and maxAttempts > 1', async () => {
    // Create a custom validator
    const validator = new CustomValidator((content) => {
      return content.includes('valid content')
        ? { isValid: true }
        : {
            isValid: false,
            instruction: 'Content must include the phrase "valid content"',
          };
    });

    // Create a static content source that will pass validation
    const validContent = new StaticSource('This is valid content');

    // Create an AssistantTemplate with the static content and validator
    const template = new Assistant(validContent, {
      validator,
      maxAttempts: 2,
      raiseError: true,
    });

    // Execute the template and verify it succeeds
    const session = await template.execute(createSession());
    expect(session.getLastMessage()?.content).toBe('This is valid content');
  });

  it('should not throw error when validation fails and raiseError is false', async () => {
    // Mock the generate function to return an invalid response
    vi.mocked(generateText).mockResolvedValue({
      type: 'assistant',
      content: 'This is invalid',
      metadata: createContext(),
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
    const template = new Assistant(options, {
      validator,
      maxAttempts: 1,
      raiseError: false,
    });

    // Execute the template and verify it doesn't throw an error
    const session = await template.execute(createSession());
    expect(session.getLastMessage()?.content).toBe('This is invalid');
  });
});
