import { useState, useMemo } from 'react';
import type { InputSource, Metadata } from '../types';

/**
 * React hook that provides an InputSource implementation backed by React state
 * @param initialValue Initial value for the input
 * @returns Object containing value, setValue, and inputSource
 */
export function useInputSource<T = string>(initialValue: T) {
  const [value, setValue] = useState<T>(initialValue);

  // Create a memoized InputSource implementation
  const inputSource = useMemo<InputSource>(() => {
    return {
      getInput: async (): Promise<string> => {
        // Convert value to string if it's not already a string
        return typeof value === 'string' ? value : String(value);
      },
    };
  }, [value]);

  return {
    value,
    setValue,
    inputSource,
  };
}
