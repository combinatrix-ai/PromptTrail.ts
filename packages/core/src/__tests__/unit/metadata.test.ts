import { describe, it, expect } from 'vitest';
import { createContext } from '../../context';

describe('Metadata', () => {
  it('should create empty metadata', () => {
    const metadata = createContext();
    expect(metadata.size).toBe(0);
  });

  it('should create metadata with initial data', () => {
    const initial = { name: 'test', value: 123 };
    const metadata = createContext({ initial });
    expect(metadata.get('name')).toBe('test');
    expect(metadata.get('value')).toBe(123);
  });

  it('should set and get values', () => {
    const metadata = createContext<{ name: string; count: number }>();
    metadata.set('name', 'test');
    metadata.set('count', 42);
    expect(metadata.get('name')).toBe('test');
    expect(metadata.get('count')).toBe(42);
  });

  it('should clone metadata', () => {
    const metadata = createContext({
      initial: { name: 'test', obj: { nested: true } },
    });
    const cloned = metadata.clone();

    expect(cloned.get('name')).toBe('test');
    expect(cloned.get('obj')).toEqual({ nested: true });

    // Verify deep clone
    const obj = cloned.get('obj') as { nested: boolean };
    obj.nested = false;
    expect(metadata.get('obj')).toEqual({ nested: true });
  });

  it('should merge metadata', () => {
    const metadata1 = createContext({ initial: { a: 1, b: 2 } });
    const metadata2 = createContext({ initial: { b: 3, c: 4 } });

    const merged = metadata1.merge(metadata2);
    expect(merged.toObject()).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('should convert to JSON', () => {
    const data = { name: 'test', value: 123 };
    const metadata = createContext({ initial: data });
    expect(metadata.toJSON()).toEqual(data);
  });

  it('should support iteration', () => {
    const data = { a: 1, b: 2, c: 3 };
    const metadata = createContext({ initial: data });
    const entries = Array.from(metadata);
    expect(entries).toEqual(Object.entries(data));
  });

  it('should handle nested objects', () => {
    const data = {
      user: {
        name: 'test',
        settings: {
          theme: 'dark',
        },
      },
    };
    const metadata = createContext({ initial: data });
    expect(metadata.get('user')).toEqual(data.user);
  });

  it('should create metadata with type inference', () => {
    const metadata = createContext({
      initial: {
        name: 'test',
        count: 42,
        settings: { enabled: true },
      },
    });

    expect(metadata.get('name')).toBe('test');
    expect(metadata.get('count')).toBe(42);
    expect(metadata.get('settings')).toEqual({ enabled: true });
  });
});
