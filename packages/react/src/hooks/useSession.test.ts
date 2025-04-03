import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react-hooks';
import { useSession } from './useSession';
import { createSession } from '@prompttrail/core';

describe('useSession', () => {
  it('初期セッションなしで正しく初期化される', () => {
    const { result } = renderHook(() => useSession());
    expect(result.current.session).toBeDefined();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('初期セッションで正しく初期化される', () => {
    const initialSession = createSession();
    const { result } = renderHook(() => useSession(initialSession));
    expect(result.current.session).toBe(initialSession);
  });

  it('初期セッション関数で正しく初期化される', () => {
    const initialSession = createSession();
    const { result } = renderHook(() => useSession(() => initialSession));
    expect(result.current.session).toBe(initialSession);
  });

  it('addMessageでメッセージを追加できる', () => {
    const { result } = renderHook(() => useSession());
    act(() => {
      result.current.addMessage({ type: 'user', content: 'Hello' });
    });
    expect(result.current.session?.messages.length).toBe(1);
    expect(result.current.session?.messages[0].content).toBe('Hello');
  });

  it('updateMetadataでメタデータを更新できる', () => {
    const { result } = renderHook(() => useSession());
    act(() => {
      result.current.updateMetadata({ key: 'value' });
    });
    expect(result.current.session?.metadata.get('key')).toBe('value');
  });

  it('executeTemplateでテンプレートを実行できる', async () => {
    const mockTemplate = {
      execute: vi.fn().mockResolvedValue(createSession().addMessage({ type: 'assistant', content: 'Response' })),
    };

    const { result } = renderHook(() => useSession());
    
    await act(async () => {
      await result.current.executeTemplate(mockTemplate as any);
    });

    expect(mockTemplate.execute).toHaveBeenCalled();
    expect(result.current.session?.messages.length).toBe(1);
    expect(result.current.session?.messages[0].content).toBe('Response');
  });

  it('executeTemplateはエラーを適切に処理する', async () => {
    const mockError = new Error('Test error');
    const mockTemplate = {
      execute: vi.fn().mockRejectedValue(mockError),
    };

    const { result } = renderHook(() => useSession());
    
    await act(async () => {
      await result.current.executeTemplate(mockTemplate as any);
    });

    expect(mockTemplate.execute).toHaveBeenCalled();
    expect(result.current.error).toBe(mockError);
  });
});
