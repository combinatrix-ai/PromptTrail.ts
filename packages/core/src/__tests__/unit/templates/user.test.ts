import { describe, it, expect, vi } from 'vitest';
import { createSession } from '../../../session';
import { CallbackSource, CLISource, StaticSource } from '../../../content_source';
import { CustomValidator } from '../../../validators/custom';
import { UserTemplate } from '../../../templates/user';

// Define mockReadline and the mock at the describe level due to hoisting
const mockReadline = {
  question: vi.fn(),
  close: vi.fn(),
};

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn().mockReturnValue(mockReadline),
}));

describe('UserTemplate', () => {
  // Reset mocks before each test if needed, or manage within the specific test
  beforeEach(() => {
    vi.clearAllMocks(); // Clears mock calls, reset state if necessary
    // If mockReadline needs specific state reset:
    // mockReadline.question.mockReset();
    // mockReadline.close.mockReset();
  });
  it('should handle ContentSource on constructor', async () => {
    // Create a mock static source
    const mockSource = new StaticSource('User query from source');
    
    // Create a UserTemplate with the source
    const template = new UserTemplate(mockSource);
    
    // Verify the template has the content source
    expect(template.getContentSource()).toBeDefined();
    
    // Execute the template and verify the result
    const session = await template.execute(createSession());
    expect(session.getLastMessage()?.type).toBe('user');
    expect(session.getLastMessage()?.content).toBe('User query from source');
  });

  it('should handle text on constructor', async () => {
    // Create a UserTemplate with a static text
    const template = new UserTemplate('User static message');
    
    // Execute the template and verify the result
    const session = await template.execute(createSession());
    expect(session.getLastMessage()?.type).toBe('user');
    expect(session.getLastMessage()?.content).toBe('User static message');
  });

  it('should be instantiated without ContentSource, but be error on execute', async () => {
    
    // Create an instance of the test template
    const template = new UserTemplate();
    
    // Expect the execute method to throw an error
    await expect(template.execute(createSession())).rejects.toThrow(
      'Content source required for UserTemplate'
    );
  });

  it('should support interpolation in static content', async () => {
    // Create a session with metadata
    const session = createSession();
    session.metadata.set('query', 'weather');
    
    // Create a UserTemplate with interpolated text
    const template = new UserTemplate('What is the ${query} like today?');
    
    // Execute the template and verify the result
    const result = await template.execute(session);
    expect(result.getLastMessage()?.content).toBe('What is the weather like today?');
  });

  it('should support interpolation in content source', async () => {
    // Create a session with metadata
    const session = createSession();
    session.metadata.set('query', 'weather');
    

    const template = new UserTemplate(new StaticSource('What is the ${query} like today?'));
    

    const result = await template.execute(session);
    expect(result.getLastMessage()?.content).toBe('What is the weather like today?');
  });

  it('should work with CLISource', async () => {
    // Set the mock behavior for this specific test
    mockReadline.question.mockResolvedValue('CLI user input');

    // Create a CLISource
    const cliSource = new CLISource('Enter your query: ');
    
    // Create a UserTemplate with the CLI source
    const template = new UserTemplate(cliSource);
    
    // Execute the template and verify the result
    const session = await template.execute(createSession());
    expect(session.getLastMessage()?.type).toBe('user');
    expect(session.getLastMessage()?.content).toBe('CLI user input');
    
    // Verify the CLI prompt was used
    expect(mockReadline.question).toHaveBeenCalledWith('Enter your query: ');
    expect(mockReadline.close).toHaveBeenCalled();
  });

  it('should work with CallbackSource', async () => {
    // Create a callback function
    const callback = vi.fn().mockResolvedValue('Callback user input');
    
    // Create a CallbackSource
    const callbackSource = new CallbackSource(callback);
    
    // Create a UserTemplate with the callback source
    const template = new UserTemplate(callbackSource);
    
    // Execute the template and verify the result
    const session = await template.execute(createSession());
    expect(session.getLastMessage()?.type).toBe('user');
    expect(session.getLastMessage()?.content).toBe('Callback user input');
    
    // Verify the callback was called with the session metadata
    expect(callback).toHaveBeenCalledWith({ metadata: expect.anything() });
  });

  it('should validate content with a custom validator', async () => {
    // Create a custom validator that only accepts content containing a specific word
    const validator = new CustomValidator((content) => {
      return content.includes('valid')
        ? { isValid: true }
        : { isValid: false, instruction: 'Content must include the word "valid"' };
    });
    
    // Create a static source with validation
    const validSource = new StaticSource('This is valid user input', {
      validator,
      maxAttempts: 1,
      raiseError: true,
    });
    
    // Create a UserTemplate with valid source
    const validTemplate = new UserTemplate(validSource);
    
    // Execute the template and verify it passes validation
    const validResult = await validTemplate.execute(createSession());
    expect(validResult.getLastMessage()?.content).toBe('This is valid user input');
    
    // Create a static source with invalid content
    const invalidSource = new StaticSource('This is invalid', {
      validator,
      maxAttempts: 1,
      raiseError: true,
    });
    
    // Create a UserTemplate with invalid source
    const invalidTemplate = new UserTemplate(invalidSource);
    
    // Execute the template and verify it fails validation
    await expect(invalidTemplate.execute(createSession())).rejects.toThrow();
  });

  it('should retry validation with CallbackSource when maxAttempts > 1', async () => {
    // Create a validator
    const validator = new CustomValidator((content) => {
      return content.includes('valid')
        ? { isValid: true }
        : { isValid: false, instruction: 'Content must include the word "valid"' };
    });
    
    // Create a callback that returns different values on subsequent calls
    const callback = vi.fn()
      .mockResolvedValueOnce('This is invalid')
      .mockResolvedValueOnce('This is valid user input');
    
    // Create a CallbackSource with validation options
    const callbackSource = new CallbackSource(callback, {
      validator,
      maxAttempts: 2,
      raiseError: true,
    });
    
    // Create a UserTemplate with the callback source
    const template = new UserTemplate(callbackSource);
    
    // Execute the template and verify it succeeds on the second attempt
    const session = await template.execute(createSession());
    expect(session.getLastMessage()?.content).toBe('This is valid user input');
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('should not throw error when validation fails and raiseError is false', async () => {
    // Create a validator
    const validator = new CustomValidator((content) => {
      return content.includes('valid')
        ? { isValid: true }
        : { isValid: false, instruction: 'Content must include the word "valid"' };
    });
    
    // Create a static source with invalid content and raiseError set to false
    const invalidSource = new StaticSource('This is invalid', {
      validator,
      maxAttempts: 1,
      raiseError: false,
    });
    
    // Create a UserTemplate with the invalid source
    const template = new UserTemplate(invalidSource);
    
    // Execute the template and verify it doesn't throw an error
    const session = await template.execute(createSession());
    expect(session.getLastMessage()?.content).toBe('This is invalid');
  });
});