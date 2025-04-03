import { vi } from 'vitest';
import * as ReactHooks from '@testing-library/react-hooks';

export const renderHook = ReactHooks.renderHook;
export const act = ReactHooks.act;

vi.mock('react-dom/client', () => ({
  createRoot: vi.fn(() => ({
    render: vi.fn(),
    unmount: vi.fn(),
  })),
}));
