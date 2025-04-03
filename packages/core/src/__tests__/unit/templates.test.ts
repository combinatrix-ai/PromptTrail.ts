import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AssistantTemplate } from '../../templates';
import { createSession } from '../../session';
import { type IValidator } from '../../validator';
import * as generateModule from '../../generate';
import type { Message, AssistantMessage, ProviderConfig } from '../../types';
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
    
    it('should throw error when generated content fails validation', async () => {
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
  });
});
