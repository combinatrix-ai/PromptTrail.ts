import { describe, it, expect } from 'vitest';
import { renderHook } from '../test-setup';
import { useMessages, useMessagesByType } from './useMessages';
import { createSession } from '../test-mocks/core-mock';

describe('useMessages', () => {
  it('undefinedセッションの場合、空配列を返す', () => {
    const { result } = renderHook(() => useMessages(undefined));
    expect(result.current).toEqual([]);
  });

  it('セッションのメッセージを返す', () => {
    const session = createSession()
      .addMessage({ type: 'system', content: 'System message' })
      .addMessage({ type: 'user', content: 'User message' });
    
    const { result } = renderHook(() => useMessages(session));
    
    expect(result.current.length).toBe(2);
    expect(result.current[0].content).toBe('System message');
    expect(result.current[1].content).toBe('User message');
  });
});

describe('useMessagesByType', () => {
  it('undefinedセッションの場合、空配列を返す', () => {
    const { result } = renderHook(() => useMessagesByType(undefined, 'user'));
    expect(result.current).toEqual([]);
  });

  it('指定されたタイプのメッセージのみを返す', () => {
    const session = createSession()
      .addMessage({ type: 'system', content: 'System message' })
      .addMessage({ type: 'user', content: 'User message 1' })
      .addMessage({ type: 'assistant', content: 'Assistant message' })
      .addMessage({ type: 'user', content: 'User message 2' });
    
    const { result } = renderHook(() => useMessagesByType(session, 'user'));
    
    expect(result.current.length).toBe(2);
    expect(result.current[0].content).toBe('User message 1');
    expect(result.current[1].content).toBe('User message 2');
  });
});
