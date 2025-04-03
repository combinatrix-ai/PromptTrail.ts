import { vi } from 'vitest';
import * as ReactHooks from '@testing-library/react-hooks';

export const renderHook = ReactHooks.renderHook;
export const act = ReactHooks.act;

/**
 * Mock react-dom/client for testing environment
 * 
 * This mock is necessary because:
 * 1. React 18's createRoot API is used in the JSDOM environment
 * 2. Without this mock, tests would try to interact with actual DOM elements
 * 3. By providing mock implementations, we can test React hooks in isolation
 *    without needing a full DOM implementation
 */
vi.mock('react-dom/client', () => ({
  createRoot: vi.fn(() => ({
    render: vi.fn(),
    unmount: vi.fn(),
  })),
}));

/**
 * Mock @prompttrail/core for testing
 * 
 * This mock provides the necessary functions and types from the core package
 * to allow tests to run without requiring the actual TypeScript declaration files.
 * This helps resolve module resolution issues in CI environments.
 */
vi.mock('@prompttrail/core', () => {
  type MockMessage = {
    type: string;
    content: string;
    [key: string]: any;
  };
  
  type MockSession = {
    messages: MockMessage[];
    metadata: {
      get: (key: string) => any;
      set: (key: string, value: any) => void;
    };
    addMessage: (message: MockMessage) => MockSession;
    getMessagesByType: (type: string) => MockMessage[];
    updateMetadata?: (metadata: Record<string, any>) => MockSession;
  };
  
  const createMockSession = (): MockSession => {
    const mockSession: MockSession = {
      messages: [],
      metadata: {
        get: vi.fn((key: string) => key === 'key' ? 'value' : undefined),
        set: vi.fn(),
      },
      addMessage: vi.fn((message: MockMessage) => {
        mockSession.messages.push(message);
        return mockSession;
      }),
      getMessagesByType: vi.fn((type: string) => {
        return type ? mockSession.messages.filter((m) => m.type === type) : [];
      }),
      updateMetadata: vi.fn((metadata: Record<string, any>) => {
        Object.entries(metadata).forEach(([key, value]) => {
          mockSession.metadata.set(key, value);
        });
        return mockSession;
      }),
    };
    return mockSession;
  };
  
  return {
    createSession: vi.fn(() => createMockSession()),
  };
});
