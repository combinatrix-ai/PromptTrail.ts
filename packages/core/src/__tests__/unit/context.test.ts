import { describe, it, expect } from 'vitest';
import { createContext } from '../../taggedRecord';

describe('Context', () => {
  it('should create empty context', () => {
    const context = createContext();
    // context = {_type: 'context'};
    expect(Object.keys(context).length).toBe(1);
    expect(context._type).toBe('context');
  });

  it('should create context with initial data', () => {
    const initial = { name: 'test', value: 123 };
    const context = createContext(initial);
    expect(context.name).toBe('test');
    expect(context.value).toBe(123);
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
    const context = createContext(data);
    expect(context.user).toEqual(data.user);
  });

  it('should create context with type inference', () => {
    const context = createContext({
      name: 'test',
      count: 42,
      settings: { enabled: true },
    });

    expect(context.name).toBe('test');
    expect(context.count).toBe(42);
    expect(context.settings).toEqual({ enabled: true });
  });

  it('should create a new object instance', () => {
    const original = { name: 'test' };
    const context = createContext(original);

    // Verify it's a new object
    expect(context).not.toBe(original);

    // Modify the original, context should not change
    original.name = 'changed';
    expect(context.name).toBe('test');
  });

  it('should work with type annotations', () => {
    type UserContext = {
      name: string;
      age: number;
      isAdmin: boolean;
    };

    const context = createContext<UserContext>({
      name: 'John',
      age: 30,
      isAdmin: true,
    });

    expect(context.name).toBe('John');
    expect(context.age).toBe(30);
    expect(context.isAdmin).toBe(true);
  });
});
