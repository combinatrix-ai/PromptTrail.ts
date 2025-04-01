import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as readline from 'node:readline/promises';
import {
  CallbackInputSource,
  CLIInputSource,
  StaticInputSource,
} from '../../input_source';
import { UserTemplate } from '../../templates';
import { createSession } from '../../session';
import { createMetadata } from '../../metadata';

// Mock readline module
const mockQuestion = vi.fn();
const mockClose = vi.fn();

vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn().mockImplementation(() => ({
    question: mockQuestion,
    close: mockClose,
    // Add required EventEmitter methods
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    off: vi.fn(),
    setMaxListeners: vi.fn(),
    getMaxListeners: vi.fn(),
    listeners: vi.fn(),
    rawListeners: vi.fn(),
    listenerCount: vi.fn(),
    prependListener: vi.fn(),
    prependOnceListener: vi.fn(),
    eventNames: vi.fn(),
  })),
}));

describe('InputSource', () => {
  describe('StaticInputSource', () => {
    it('should return default value when provided', async () => {
      const source = new StaticInputSource('default');
      const input = await source.getInput();
      expect(input).toBe('default');
    });
  });

  describe('CallbackInputSource', () => {
    it('should call callback with context', async () => {
      const callback = vi.fn().mockResolvedValue('test input');
      const source = new CallbackInputSource(callback);
      const metadata = createMetadata();
      metadata.set('key', 'value');

      const input = await source.getInput({ metadata });
      expect(input).toBe('test input');
      expect(callback).toHaveBeenCalledWith({ metadata });
    });

    it('should handle async callbacks correctly', async () => {
      const callback = vi.fn().mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return 'delayed input';
      });
      const source = new CallbackInputSource(callback);

      const metadata = createMetadata();
      const input = await source.getInput({ metadata });
      expect(input).toBe('delayed input');
    });

    it('should propagate callback errors', async () => {
      const error = new Error('Callback failed');
      const callback = vi.fn().mockRejectedValue(error);
      const source = new CallbackInputSource(callback);

      const metadata = createMetadata();
      await expect(source.getInput({ metadata })).rejects.toThrow(
        error,
      );
    });

    describe('integration with UserTemplate', () => {
      it('should work with UserTemplate and provide input', async () => {
        const callback = vi.fn().mockResolvedValue('user response');
        const source = new CallbackInputSource(callback);
        const template = new UserTemplate({
          inputSource: source,
        });

        const session = createSession();
        const updatedSession = await template.execute(session);
        const lastMessage =
          updatedSession.messages[updatedSession.messages.length - 1];

        expect(lastMessage.type).toBe('user');
        expect(lastMessage.content).toBe('user response');
        expect(callback).toHaveBeenCalledWith({
          metadata: expect.any(Object),
        });
      });

      it('should work with validation in UserTemplate', async () => {
        const callback = vi
          .fn()
          .mockResolvedValueOnce('invalid')
          .mockResolvedValueOnce('valid');
        const source = new CallbackInputSource(callback);
        const validate = vi
          .fn()
          .mockResolvedValueOnce(false)
          .mockResolvedValueOnce(true);

        const template = new UserTemplate({
          inputSource: source,
          validate,
        });

        const session = createSession();
        const updatedSession = await template.execute(session);
        const lastMessage =
          updatedSession.messages[updatedSession.messages.length - 1];

        expect(lastMessage.content).toBe('valid');
        expect(callback).toHaveBeenCalledTimes(2);
        expect(validate).toHaveBeenCalledTimes(2);
        expect(validate).toHaveBeenCalledWith('invalid');
        expect(validate).toHaveBeenCalledWith('valid');
      });

      it('should call onInput callback when provided', async () => {
        const inputCallback = vi.fn().mockResolvedValue('test input');
        const source = new CallbackInputSource(inputCallback);
        const onInput = vi.fn();

        const template = new UserTemplate({
          inputSource: source,
          onInput,
        });

        const session = createSession();
        await template.execute(session);

        expect(onInput).toHaveBeenCalledWith('test input');
      });

      it('should handle default values correctly', async () => {
        const callback = vi
          .fn()
          .mockImplementation((context) => {
            return Promise.resolve('default value modified');
          });
        const source = new CallbackInputSource(callback);

        const template = new UserTemplate({
          inputSource: source,
        });

        const session = createSession();
        const updatedSession = await template.execute(session);
        const lastMessage =
          updatedSession.messages[updatedSession.messages.length - 1];

        expect(lastMessage.content).toBe('default value modified');
        expect(callback).toHaveBeenCalledWith({
          metadata: expect.any(Object),
        });
      });
    });
  });

  describe('CLIInputSource', () => {
    let source: CLIInputSource;

    beforeEach(() => {
      vi.clearAllMocks();
      source = new CLIInputSource(
        'Enter value',
        'default value',
      );
    });

    afterEach(() => {
      source.close();
    });

    // it('should prompt with description and return user input', async () => {
    //   mockQuestion.mockResolvedValueOnce('user input');

    //   const input = await source.getInput();

    //   expect(input).toBe('user input');
    //   expect(mockQuestion).toHaveBeenCalledWith('Enter value: ');
    // });

    // it('should show default value in prompt and return it when input is empty', async () => {
    //   mockQuestion.mockResolvedValueOnce('');

    //   const input = await source.getInput();

    //   expect(input).toBe('default');
    //   expect(mockQuestion).toHaveBeenCalledWith(
    //     'Enter value (default: default): ',
    //   );
    // });

    // it('should return user input even when default is available', async () => {
    //   mockQuestion.mockResolvedValueOnce('user input');

    //   const input = await source.getInput({
    //     description: 'Enter value',
    //     defaultValue: 'default',
    //   });

      expect(input).toBe('user input');
    });
    
    it('should work with custom readline interface', async () => {
      const customReadline = {
        question: async (_prompt: string): Promise<string> => {
          return 'custom input';
        },
        close: vi.fn(),
      } as unknown as readline.Interface;
      
      const customSource = new CLIInputSource(customReadline);
      
      const input = await customSource.getInput({
        description: 'Enter value',
      });
      
      expect(input).toBe('custom input');
      customSource.close();
    });

    // describe('integration with UserTemplate', () => {
    //   it('should work with UserTemplate', async () => {
    //     mockQuestion.mockResolvedValueOnce('cli response');

    //     const template = new UserTemplate(
    //       inputSource: source
    //     );

    //     const session = createSession();
    //     const updatedSession = await template.execute(session);
    //     const lastMessage =
    //       updatedSession.messages[updatedSession.messages.length - 1];

    //     expect(lastMessage.type).toBe('user');
    //     expect(lastMessage.content).toBe('cli response');
    //     expect(mockQuestion).toHaveBeenCalledWith('Enter value: ');
    //   });

      it('should work with validation', async () => {
        // TODO: Implement validation for CLIInputSource
        // mockQuestion
        //   .mockResolvedValueOnce('invalid')
        //   .mockResolvedValueOnce('valid');

        // const validate = vi
        //   .fn()
        //   .mockResolvedValueOnce(false)
        //   .mockResolvedValueOnce(true);

        // const template = new UserTemplate({
        //   description: 'Enter value',
        //   inputSource: source,
        //   validate,
        // });

        // const session = createSession();
        // const updatedSession = await template.execute(session);
        // const lastMessage =
        //   updatedSession.messages[updatedSession.messages.length - 1];

        // expect(lastMessage.content).toBe('valid');
        // expect(mockQuestion).toHaveBeenCalledTimes(2);
        // expect(validate).toHaveBeenCalledTimes(2);
      });
    });
  });
