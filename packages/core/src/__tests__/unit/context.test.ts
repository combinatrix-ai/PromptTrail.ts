import { describe, expect, expectTypeOf, it } from 'vitest';
import { Context } from '../../tagged_record';

describe('Context', () => {
  it('should create empty context', () => {
    const context = Context.create({});
    expect(Object.keys(context).length).toBe(0);
  });

  it('should create context with initial data', () => {
    const initial = { name: 'test', value: 123 };
    const context = Context.create(initial);
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
    const context = Context.create(data);
    expect(context.user).toBeDefined();
    expect(context.user.name).toBe('test');
    expect(context.user.settings).toBeDefined();
    expect(context.user.settings.theme).toBe('dark');
  });

  it('should create context with type inference', () => {
    const context = Context.create({
      name: 'test',
      count: 42,
      settings: { enabled: true },
    });

    expectTypeOf(context).toEqualTypeOf<
      Context<{
        name: string;
        count: number;
        settings: { enabled: boolean };
      }>
    >();
  });

  it('should work with type annotations', () => {
    type UserContext = {
      name: string;
      age: number;
      isAdmin: boolean;
    };

    const context = Context.create<UserContext>({
      name: 'John',
      age: 30,
      isAdmin: true,
    });

    expectTypeOf(context).toEqualTypeOf<Context<UserContext>>();

    expect(context.name).toBe('John');
    expect(context.age).toBe(30);
    expect(context.isAdmin).toBe(true);
  });

  it('should create a new object instance', () => {
    const original = { name: 'test' };
    const context = Context.create(original);

    // Verify it's a new object
    expect(context).not.toBe(original);

    // Modify the original, context should not change
    original.name = 'changed';
    expect(context.name).toBe('test');
  });

  it('should merge contexts', () => {
    const context1 = Context.create({ a: 1, b: 2 });
    const context2 = Context.create({ b: 3, c: 4 });

    const merged = Context.merge(context1, context2);

    expect(merged.a).toBe(1);
    expect(merged.b).toBe(3); // Overwrites
    expect(merged.c).toBe(4); // New property
  });

  it('should is work correctly', () => {
    const context = Context.create({ a: 1 });
    expect(Context.is(context)).toBe(true); // Branded
    expect(Context.is({ a: 1 })).toBe(false); // Not branded
    expect(Context.is({})).toBe(false);
    expect(Context.is(null)).toBe(false);
    expect(Context.is(undefined)).toBe(false);
  });
});
