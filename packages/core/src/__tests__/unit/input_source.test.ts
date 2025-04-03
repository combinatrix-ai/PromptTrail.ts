import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
// readline の import は型の為だけに残すか、不要なら削除も検討
import type * as readline from 'node:readline/promises';
import {
  CallbackInputSource,
  CLIInputSource,
  StaticInputSource,
} from '../../input_source';
import { UserTemplate } from '../../templates';
import { createSession } from '../../session';
import { createMetadata } from '../../metadata';

// Mock the module completely within the factory function
vi.mock('node:readline/promises', async (importOriginal) => {
  const actualReadline = await importOriginal<typeof readline>();
  // Create mocks *inside* the factory
  const mockQuestion = vi.fn();
  const mockClose = vi.fn();
  const mockCreateInterface = vi.fn().mockImplementation(() => ({ // Keep the implementation
    question: mockQuestion,
    close: mockClose,
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
    removeAllListeners: vi.fn(),
    [Symbol.asyncDispose]: vi.fn(),
  }));

  return {
    ...actualReadline,
    createInterface: mockCreateInterface,
    // Export the inner mocks for resetting and assertion
    _mockQuestion: mockQuestion,
    _mockClose: mockClose,
  };
});

// Helper function to get the inner mocks after module is mocked
const getReadlineMocks = async () => {
  // Ensure we re-import to get the potentially updated mock references
  // (though vi.mock should handle this, being explicit might help)
  const rl = await import('node:readline/promises');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return rl as any as {
    createInterface: ReturnType<typeof vi.fn>;
    _mockQuestion: ReturnType<typeof vi.fn>;
    _mockClose: ReturnType<typeof vi.fn>;
  };
};


describe('InputSource', () => {
  // Remove top-level mock variables and beforeEach related to them

  beforeEach(() => {
    // Only clear mocks globally if absolutely necessary,
    // but prefer per-test mock retrieval and reset.
    vi.clearAllMocks(); // Keep clearing calls
  });


  describe('StaticInputSource', () => {
    it('should return the static input value', async () => {
      const source = new StaticInputSource('static input');
      const input = await source.getInput();
      expect(input).toBe('static input');
    });
  });

  describe('CallbackInputSource', () => {
    // ... (CallbackInputSource tests remain unchanged) ...
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
      await expect(source.getInput({ metadata })).rejects.toThrow(error);
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
    });
  });

  describe('CLIInputSource', () => {
    // No top-level source or afterEach

    it('should return default value immediately if provided', async () => {
      const { createInterface: mockCreateInterface, _mockQuestion: mockQuestion } = await getReadlineMocks();
      mockQuestion.mockReset(); // Reset state for this test
      mockCreateInterface.mockClear(); // Clear calls for this test

      const source = new CLIInputSource(
        undefined,
        'Enter value',
        'default value',
      );
      try {
        const input = await source.getInput();
        expect(input).toBe('default value');
        expect(mockCreateInterface).toHaveBeenCalledTimes(1);
        expect(mockQuestion).not.toHaveBeenCalled();
      } finally {
        source.close();
      }
    });

    it('should prompt with description and return user input when no default value', async () => {
      const { createInterface: mockCreateInterface, _mockQuestion: mockQuestion } = await getReadlineMocks();
      mockQuestion.mockReset();
      mockCreateInterface.mockClear();

      const source = new CLIInputSource(
        undefined,
        'Enter your name',
        undefined,
      );
      try {
        mockQuestion.mockResolvedValueOnce('John Doe'); // Set for this test
        const input = await source.getInput();
        expect(input).toBe('John Doe');
        expect(mockCreateInterface).toHaveBeenCalledTimes(1);
        expect(mockQuestion).toHaveBeenCalledTimes(1);
        expect(mockQuestion).toHaveBeenCalledWith(expect.stringContaining('Enter your name'));
      } finally {
        source.close();
      }
    });

    it('should re-prompt when input is empty and no default value', async () => {
      const { createInterface: mockCreateInterface, _mockQuestion: mockQuestion } = await getReadlineMocks();
      mockQuestion.mockReset();
      mockCreateInterface.mockClear();

      const source = new CLIInputSource(
        undefined,
        'Enter something',
        undefined,
      );
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        mockQuestion.mockResolvedValueOnce(''); // Set for this test
        mockQuestion.mockResolvedValueOnce('valid input'); // Set for this test
        const input = await source.getInput();
        expect(input).toBe('valid input');
        expect(mockCreateInterface).toHaveBeenCalledTimes(1);
        expect(mockQuestion).toHaveBeenCalledTimes(2);
        expect(consoleSpy).toHaveBeenCalledWith(
          'Input cannot be empty without a default value. Asking again...',
        );
      } finally {
        consoleSpy.mockRestore();
        source.close();
      }
    });

    it('should use default description if none provided', async () => {
      const { createInterface: mockCreateInterface, _mockQuestion: mockQuestion } = await getReadlineMocks();
      mockQuestion.mockReset();
      mockCreateInterface.mockClear();

      const source = new CLIInputSource(
          undefined,
          undefined,
          undefined,
      );
      try {
        mockQuestion.mockResolvedValueOnce('some input'); // Set for this test
        await source.getInput();
        expect(mockCreateInterface).toHaveBeenCalledTimes(1);
        expect(mockQuestion).toHaveBeenCalledTimes(1);
        expect(mockQuestion).toHaveBeenCalledWith(expect.stringContaining('Input>'));
      } finally {
        source.close();
      }
    });

    it('should close the readline interface', async () => { // Make async to await getReadlineMocks
      const { createInterface: mockCreateInterface, _mockClose: mockClose } = await getReadlineMocks();
      mockClose.mockReset();
      mockCreateInterface.mockClear();

      const sourceToClose = new CLIInputSource();
      expect(mockCreateInterface).toHaveBeenCalledTimes(1);

      sourceToClose.close();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('should work with a custom readline interface passed explicitly', async () => {
      // Get global mocks to ensure they are NOT called
      const { createInterface: globalMockCreateInterface, _mockClose: globalMockClose } = await getReadlineMocks();
      globalMockCreateInterface.mockClear();
      globalMockClose.mockReset();

      const customMockQuestion = vi.fn().mockResolvedValue('custom input');
      const customMockClose = vi.fn();
      const customReadline = {
          question: customMockQuestion,
          close: customMockClose,
          on: vi.fn(), once: vi.fn(), emit: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), off: vi.fn(), setMaxListeners: vi.fn(), getMaxListeners: vi.fn(), listeners: vi.fn(), rawListeners: vi.fn(), listenerCount: vi.fn(), prependListener: vi.fn(), prependOnceListener: vi.fn(), eventNames: vi.fn(), removeAllListeners: vi.fn(), [Symbol.asyncDispose]: vi.fn(),
      } as unknown as readline.Interface;

      let source: CLIInputSource | undefined;
      try {
        source = new CLIInputSource(customReadline, 'Custom Prompt', undefined);
        const input = await source.getInput();
        expect(input).toBe('custom input');
        expect(globalMockCreateInterface).not.toHaveBeenCalled(); // Global mock not called
        expect(customMockQuestion).toHaveBeenCalledTimes(1);
        expect(customMockQuestion).toHaveBeenCalledWith(expect.stringContaining('Custom Prompt'));

        source.close();
        expect(customMockClose).toHaveBeenCalledTimes(1);
        expect(globalMockClose).not.toHaveBeenCalled(); // Global mock's close not called
      } finally {
         // Ensure close is called even if assertions fail, but avoid double closing if already called
         if (source && customMockClose.mock.calls.length === 0) {
            source.close();
         }
      }
    });


    describe('integration with UserTemplate', () => {

      it('should work with UserTemplate when no default value', async () => {
        const { createInterface: mockCreateInterface, _mockQuestion: mockQuestion } = await getReadlineMocks();
        mockQuestion.mockReset();
        mockCreateInterface.mockClear();

        const source = new CLIInputSource(
          undefined,
          'CLI Prompt for Template',
          undefined, // NO default value
        );
        try {
          mockQuestion.mockResolvedValueOnce('cli response from template'); // Set mock response for THIS test
          const template = new UserTemplate({ inputSource: source });
          const session = createSession();
          const updatedSession = await template.execute(session);
          const lastMessage = updatedSession.messages[updatedSession.messages.length - 1];

          expect(lastMessage.type).toBe('user');
          expect(lastMessage.content).toBe('cli response from template'); // Check against mock response
          expect(mockCreateInterface).toHaveBeenCalledTimes(1);
          expect(mockQuestion).toHaveBeenCalledTimes(1);
          expect(mockQuestion).toHaveBeenCalledWith(expect.stringContaining('CLI Prompt for Template'));
        } finally {
          source.close();
        }
      });

      it('should work with UserTemplate when default value is provided', async () => {
        const { createInterface: mockCreateInterface, _mockQuestion: mockQuestion } = await getReadlineMocks();
        mockQuestion.mockReset();
        mockCreateInterface.mockClear();

        const source = new CLIInputSource(
          undefined,
          'CLI Prompt with Default',
          'default template input', // Default value for THIS test
        );
        try {
          const template = new UserTemplate({ inputSource: source });
          const session = createSession();
          const updatedSession = await template.execute(session);
          const lastMessage = updatedSession.messages[updatedSession.messages.length - 1];

          expect(lastMessage.type).toBe('user');
          expect(lastMessage.content).toBe('default template input'); // Check against constructor default
          expect(mockCreateInterface).toHaveBeenCalledTimes(1);
          expect(mockQuestion).not.toHaveBeenCalled(); // Should not be called
        } finally {
          source.close();
        }
      });
    });
  });
});
