import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AssistantTemplate } from '../../templates';
import { createSession } from '../../session';
import { type IValidator, AllValidator, AnyValidator } from '../../validator';
import * as generateModule from '../../generate';
import type { AssistantMessage, ProviderConfig } from '../../types';
import { GenerateOptions } from '../../generate_options';

vi.mock('../../generate', () => ({
  generateText: vi.fn(),
}));

describe('AssistantTemplate', () => {
  describe('with static content', () => {
    it('should return the static content', async () => {
      const template = new AssistantTemplate('static content');
      const session = createSession();
      
      const result = await template.execute(session);
      
      expect(result.messages[0].content).toBe('static content');
    });
    
    it('should validate static content with validator', async () => {
      const mockValidator: IValidator = {
        validate: vi.fn().mockResolvedValue({ isValid: true }),
        getDescription: vi.fn().mockReturnValue('mock validator'),
        getErrorMessage: vi.fn().mockReturnValue('validation failed'),
      };
      
      const template = new AssistantTemplate('static content', mockValidator);
      const session = createSession();
      
      const result = await template.execute(session);
      
      expect(result.messages[0].content).toBe('static content');
      expect(mockValidator.validate).toHaveBeenCalledWith('static content', expect.anything());
    });
    
    it('should throw error when static content fails validation', async () => {
      const mockValidator: IValidator = {
        validate: vi.fn().mockResolvedValue({ isValid: false, instruction: 'Invalid content' }),
        getDescription: vi.fn().mockReturnValue('mock validator'),
        getErrorMessage: vi.fn().mockReturnValue('validation failed'),
      };
      
      const template = new AssistantTemplate('static content', mockValidator);
      const session = createSession();
      
      await expect(template.execute(session)).rejects.toThrow('Assistant content validation failed');
      expect(mockValidator.validate).toHaveBeenCalledWith('static content', expect.anything());
    });
  });
  
  describe('with generate options', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });
    
    it('should generate content using the model', async () => {
      const mockResponse: AssistantMessage = {
        type: 'assistant',
        content: 'generated content',
        metadata: undefined
      };
      
      const generateTextMock = vi.mocked(generateModule.generateText);
      generateTextMock.mockResolvedValue(mockResponse);
      
      const mockProvider: ProviderConfig = {
        type: 'openai',
        apiKey: 'mock-api-key',
        modelName: 'mock-model'
      };
      
      const generateOptions = new GenerateOptions({ provider: mockProvider });
      const template = new AssistantTemplate(generateOptions);
      const session = createSession();
      
      const result = await template.execute(session);
      
      expect(result.messages[0].content).toBe('generated content');
      expect(generateTextMock).toHaveBeenCalledTimes(1);
    });
    
    it('should validate generated content with validator', async () => {
      const mockValidator: IValidator = {
        validate: vi.fn().mockResolvedValue({ isValid: true }),
        getDescription: vi.fn().mockReturnValue('mock validator'),
        getErrorMessage: vi.fn().mockReturnValue('validation failed'),
      };
      
      const mockResponse: AssistantMessage = {
        type: 'assistant',
        content: 'valid generated content',
        metadata: undefined
      };
      
      const generateTextMock = vi.mocked(generateModule.generateText);
      generateTextMock.mockResolvedValue(mockResponse);
      
      const mockProvider: ProviderConfig = {
        type: 'openai',
        apiKey: 'mock-api-key',
        modelName: 'mock-model'
      };
      
      const generateOptions = new GenerateOptions({ provider: mockProvider });
      const template = new AssistantTemplate(generateOptions, mockValidator);
      const session = createSession();
      
      const result = await template.execute(session);
      
      expect(result.messages[0].content).toBe('valid generated content');
      expect(mockValidator.validate).toHaveBeenCalledWith('valid generated content', expect.anything());
    });
    
    it('should throw error when generated content fails validation with default options', async () => {
      const mockValidator: IValidator = {
        validate: vi.fn().mockResolvedValue({ isValid: false, instruction: 'Invalid content' }),
        getDescription: vi.fn().mockReturnValue('mock validator'),
        getErrorMessage: vi.fn().mockReturnValue('validation failed'),
      };
      
      const mockResponse: AssistantMessage = {
        type: 'assistant',
        content: 'invalid generated content',
        metadata: undefined
      };
      
      const generateTextMock = vi.mocked(generateModule.generateText);
      generateTextMock.mockResolvedValue(mockResponse);
      
      const mockProvider: ProviderConfig = {
        type: 'openai',
        apiKey: 'mock-api-key',
        modelName: 'mock-model'
      };
      
      const generateOptions = new GenerateOptions({ provider: mockProvider });
      const template = new AssistantTemplate(generateOptions, mockValidator);
      const session = createSession();
      
      await expect(template.execute(session)).rejects.toThrow('Assistant response validation failed');
      expect(mockValidator.validate).toHaveBeenCalledWith('invalid generated content', expect.anything());
    });
    
    it('should retry generation when validation fails', async () => {
      const mockValidator: IValidator = {
        validate: vi.fn()
          .mockResolvedValueOnce({ isValid: false, instruction: 'Invalid content' })
          .mockResolvedValueOnce({ isValid: true }),
        getDescription: vi.fn().mockReturnValue('mock validator'),
        getErrorMessage: vi.fn().mockReturnValue('validation failed'),
      };
      
      const mockResponse1: AssistantMessage = {
        type: 'assistant',
        content: 'invalid generated content',
        metadata: undefined
      };
      
      const mockResponse2: AssistantMessage = {
        type: 'assistant',
        content: 'valid generated content',
        metadata: undefined
      };
      
      const generateTextMock = vi.mocked(generateModule.generateText);
      generateTextMock
        .mockResolvedValueOnce(mockResponse1)
        .mockResolvedValueOnce(mockResponse2);
      
      const mockProvider: ProviderConfig = {
        type: 'openai',
        apiKey: 'mock-api-key',
        modelName: 'mock-model'
      };
      
      const options = {
        validator: mockValidator,
        maxAttempts: 2,
        raiseError: true
      };
      
      const generateOptions = new GenerateOptions({ provider: mockProvider });
      const template = new AssistantTemplate(generateOptions, options);
      const session = createSession();
      
      const result = await template.execute(session);
      
      expect(result.messages[0].content).toBe('valid generated content');
      expect(mockValidator.validate).toHaveBeenCalledTimes(2);
      expect(generateTextMock).toHaveBeenCalledTimes(2);
    });
    
    it('should throw error when validation fails all attempts with raiseError=true', async () => {
      const mockValidator: IValidator = {
        validate: vi.fn().mockResolvedValue({ isValid: false, instruction: 'Invalid content' }),
        getDescription: vi.fn().mockReturnValue('mock validator'),
        getErrorMessage: vi.fn().mockReturnValue('validation failed'),
      };
      
      const mockResponse: AssistantMessage = {
        type: 'assistant',
        content: 'invalid generated content',
        metadata: undefined
      };
      
      const generateTextMock = vi.mocked(generateModule.generateText);
      generateTextMock.mockResolvedValue(mockResponse);
      
      const mockProvider: ProviderConfig = {
        type: 'openai',
        apiKey: 'mock-api-key',
        modelName: 'mock-model'
      };
      
      const options = {
        validator: mockValidator,
        maxAttempts: 2,
        raiseError: true
      };
      
      const generateOptions = new GenerateOptions({ provider: mockProvider });
      const template = new AssistantTemplate(generateOptions, options);
      const session = createSession();
      
      await expect(template.execute(session)).rejects.toThrow('Assistant response validation failed after 2 attempts');
      expect(mockValidator.validate).toHaveBeenCalledTimes(2);
      expect(generateTextMock).toHaveBeenCalledTimes(2);
    });
    
    it('should not throw error when validation fails all attempts with raiseError=false', async () => {
      const mockValidator: IValidator = {
        validate: vi.fn().mockResolvedValue({ isValid: false, instruction: 'Invalid content' }),
        getDescription: vi.fn().mockReturnValue('mock validator'),
        getErrorMessage: vi.fn().mockReturnValue('validation failed'),
      };
      
      const mockResponse: AssistantMessage = {
        type: 'assistant',
        content: 'invalid generated content',
        metadata: undefined
      };
      
      const generateTextMock = vi.mocked(generateModule.generateText);
      generateTextMock.mockResolvedValue(mockResponse);
      
      const mockProvider: ProviderConfig = {
        type: 'openai',
        apiKey: 'mock-api-key',
        modelName: 'mock-model'
      };
      
      const options = {
        validator: mockValidator,
        maxAttempts: 2,
        raiseError: false
      };
      
      const generateOptions = new GenerateOptions({ provider: mockProvider });
      const template = new AssistantTemplate(generateOptions, options);
      const session = createSession();
      
      const result = await template.execute(session);
      
      expect(result.messages[0].content).toBe('invalid generated content');
      expect(mockValidator.validate).toHaveBeenCalledTimes(2);
      expect(generateTextMock).toHaveBeenCalledTimes(3); // Initial + maxAttempts + final
    });
  });
  
  describe('with composite validators', () => {
    beforeEach(() => {
      vi.resetAllMocks();
    });
    
    it('should validate with AllValidator (all pass)', async () => {
      const mockValidator1: IValidator = {
        validate: vi.fn().mockResolvedValue({ isValid: true }),
        getDescription: vi.fn().mockReturnValue('validator 1'),
        getErrorMessage: vi.fn().mockReturnValue('validation 1 failed'),
      };
      
      const mockValidator2: IValidator = {
        validate: vi.fn().mockResolvedValue({ isValid: true }),
        getDescription: vi.fn().mockReturnValue('validator 2'),
        getErrorMessage: vi.fn().mockReturnValue('validation 2 failed'),
      };
      
      const allValidator = new AllValidator([mockValidator1, mockValidator2], { description: 'All validators must pass' });
      
      const mockResponse: AssistantMessage = {
        type: 'assistant',
        content: 'valid content for all validators',
        metadata: undefined
      };
      
      const generateTextMock = vi.mocked(generateModule.generateText);
      generateTextMock.mockResolvedValue(mockResponse);
      
      const mockProvider: ProviderConfig = {
        type: 'openai',
        apiKey: 'mock-api-key',
        modelName: 'mock-model'
      };
      
      const generateOptions = new GenerateOptions({ provider: mockProvider });
      const template = new AssistantTemplate(generateOptions, allValidator);
      const session = createSession();
      
      const result = await template.execute(session);
      
      expect(result.messages[0].content).toBe('valid content for all validators');
      expect(mockValidator1.validate).toHaveBeenCalledWith('valid content for all validators', expect.anything());
      expect(mockValidator2.validate).toHaveBeenCalledWith('valid content for all validators', expect.anything());
    });
    
    it('should fail validation with AllValidator when one validator fails', async () => {
      const mockValidator1: IValidator = {
        validate: vi.fn().mockResolvedValue({ isValid: true }),
        getDescription: vi.fn().mockReturnValue('validator 1'),
        getErrorMessage: vi.fn().mockReturnValue('validation 1 failed'),
      };
      
      const mockValidator2: IValidator = {
        validate: vi.fn().mockResolvedValue({ isValid: false, instruction: 'Validator 2 failed' }),
        getDescription: vi.fn().mockReturnValue('validator 2'),
        getErrorMessage: vi.fn().mockReturnValue('validation 2 failed'),
      };
      
      const allValidator = new AllValidator([mockValidator1, mockValidator2], { description: 'All validators must pass' });
      
      const mockResponse: AssistantMessage = {
        type: 'assistant',
        content: 'content that fails validator 2',
        metadata: undefined
      };
      
      const generateTextMock = vi.mocked(generateModule.generateText);
      generateTextMock.mockResolvedValue(mockResponse);
      
      const mockProvider: ProviderConfig = {
        type: 'openai',
        apiKey: 'mock-api-key',
        modelName: 'mock-model'
      };
      
      const generateOptions = new GenerateOptions({ provider: mockProvider });
      const template = new AssistantTemplate(generateOptions, allValidator);
      const session = createSession();
      
      await expect(template.execute(session)).rejects.toThrow('Assistant response validation failed');
      expect(mockValidator1.validate).toHaveBeenCalledWith('content that fails validator 2', expect.anything());
      expect(mockValidator2.validate).toHaveBeenCalledWith('content that fails validator 2', expect.anything());
    });
    
    it('should validate with AnyValidator when at least one validator passes', async () => {
      const mockValidator1: IValidator = {
        validate: vi.fn().mockResolvedValue({ isValid: false, instruction: 'Validator 1 failed' }),
        getDescription: vi.fn().mockReturnValue('validator 1'),
        getErrorMessage: vi.fn().mockReturnValue('validation 1 failed'),
      };
      
      const mockValidator2: IValidator = {
        validate: vi.fn().mockResolvedValue({ isValid: true }),
        getDescription: vi.fn().mockReturnValue('validator 2'),
        getErrorMessage: vi.fn().mockReturnValue('validation 2 failed'),
      };
      
      const anyValidator = new AnyValidator([mockValidator1, mockValidator2], { description: 'Any validator must pass' });
      
      const mockResponse: AssistantMessage = {
        type: 'assistant',
        content: 'content that passes validator 2',
        metadata: undefined
      };
      
      const generateTextMock = vi.mocked(generateModule.generateText);
      generateTextMock.mockResolvedValue(mockResponse);
      
      const mockProvider: ProviderConfig = {
        type: 'openai',
        apiKey: 'mock-api-key',
        modelName: 'mock-model'
      };
      
      const generateOptions = new GenerateOptions({ provider: mockProvider });
      const template = new AssistantTemplate(generateOptions, anyValidator);
      const session = createSession();
      
      const result = await template.execute(session);
      
      expect(result.messages[0].content).toBe('content that passes validator 2');
      expect(mockValidator1.validate).toHaveBeenCalledWith('content that passes validator 2', expect.anything());
      expect(mockValidator2.validate).toHaveBeenCalledWith('content that passes validator 2', expect.anything());
    });
    
    it('should fail validation with AnyValidator when all validators fail', async () => {
      const mockValidator1: IValidator = {
        validate: vi.fn().mockResolvedValue({ isValid: false, instruction: 'Validator 1 failed' }),
        getDescription: vi.fn().mockReturnValue('validator 1'),
        getErrorMessage: vi.fn().mockReturnValue('validation 1 failed'),
      };
      
      const mockValidator2: IValidator = {
        validate: vi.fn().mockResolvedValue({ isValid: false, instruction: 'Validator 2 failed' }),
        getDescription: vi.fn().mockReturnValue('validator 2'),
        getErrorMessage: vi.fn().mockReturnValue('validation 2 failed'),
      };
      
      const anyValidator = new AnyValidator([mockValidator1, mockValidator2], { description: 'Any validator must pass' });
      
      const mockResponse: AssistantMessage = {
        type: 'assistant',
        content: 'content that fails all validators',
        metadata: undefined
      };
      
      const generateTextMock = vi.mocked(generateModule.generateText);
      generateTextMock.mockResolvedValue(mockResponse);
      
      const mockProvider: ProviderConfig = {
        type: 'openai',
        apiKey: 'mock-api-key',
        modelName: 'mock-model'
      };
      
      const generateOptions = new GenerateOptions({ provider: mockProvider });
      const template = new AssistantTemplate(generateOptions, anyValidator);
      const session = createSession();
      
      await expect(template.execute(session)).rejects.toThrow('Assistant response validation failed');
      expect(mockValidator1.validate).toHaveBeenCalledWith('content that fails all validators', expect.anything());
      expect(mockValidator2.validate).toHaveBeenCalledWith('content that fails all validators', expect.anything());
    });
    
    it('should retry with composite validators until success', async () => {
      const mockValidator1: IValidator = {
        validate: vi.fn()
          .mockResolvedValueOnce({ isValid: false, instruction: 'Validator 1 failed' })
          .mockResolvedValueOnce({ isValid: true }),
        getDescription: vi.fn().mockReturnValue('validator 1'),
        getErrorMessage: vi.fn().mockReturnValue('validation 1 failed'),
      };
      
      const mockValidator2: IValidator = {
        validate: vi.fn()
          .mockResolvedValueOnce({ isValid: false, instruction: 'Validator 2 failed' })
          .mockResolvedValueOnce({ isValid: true }),
        getDescription: vi.fn().mockReturnValue('validator 2'),
        getErrorMessage: vi.fn().mockReturnValue('validation 2 failed'),
      };
      
      const allValidator = new AllValidator([mockValidator1, mockValidator2], { description: 'All validators must pass' });
      
      const mockResponse1: AssistantMessage = {
        type: 'assistant',
        content: 'invalid content',
        metadata: undefined
      };
      
      const mockResponse2: AssistantMessage = {
        type: 'assistant',
        content: 'valid content',
        metadata: undefined
      };
      
      const generateTextMock = vi.mocked(generateModule.generateText);
      generateTextMock
        .mockResolvedValueOnce(mockResponse1)
        .mockResolvedValueOnce(mockResponse2);
      
      const mockProvider: ProviderConfig = {
        type: 'openai',
        apiKey: 'mock-api-key',
        modelName: 'mock-model'
      };
      
      const options = {
        validator: allValidator,
        maxAttempts: 2,
        raiseError: true
      };
      
      const generateOptions = new GenerateOptions({ provider: mockProvider });
      const template = new AssistantTemplate(generateOptions, options);
      const session = createSession();
      
      const result = await template.execute(session);
      
      expect(result.messages[0].content).toBe('valid content');
      expect(mockValidator1.validate).toHaveBeenCalledTimes(2);
      expect(mockValidator2.validate).toHaveBeenCalledTimes(2);
      expect(generateTextMock).toHaveBeenCalledTimes(2);
    });
  });
});
