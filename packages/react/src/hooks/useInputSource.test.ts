import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react-hooks';
import { useInputSource } from './useInputSource';

describe('useInputSource', () => {
  it('初期値で正しく初期化される', () => {
    const { result } = renderHook(() => useInputSource('initial value'));
    expect(result.current.value).toBe('initial value');
  });

  it('setValueで値を更新できる', () => {
    const { result } = renderHook(() => useInputSource('initial value'));
    act(() => {
      result.current.setValue('new value');
    });
    expect(result.current.value).toBe('new value');
  });

  it('inputSource.getInputは現在の値を返す', async () => {
    const { result } = renderHook(() => useInputSource('test value'));
    const inputValue = await result.current.inputSource.getInput();
    expect(inputValue).toBe('test value');
  });

  it('非文字列の値が文字列に変換される', async () => {
    const { result } = renderHook(() => useInputSource<number>(42));
    const inputValue = await result.current.inputSource.getInput();
    expect(inputValue).toBe('42');
  });
});
