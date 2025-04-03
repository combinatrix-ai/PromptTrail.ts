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
