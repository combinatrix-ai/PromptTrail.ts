import { describe, expect, expectTypeOf, it } from 'vitest';
import { Attrs } from '../../tagged_record';

describe('Context', () => {
  it('should create empty context', () => {
    const context = Attrs.create({});
    expect(Object.keys(context).length).toBe(0);
  });

  it('should create context with initial data', () => {
    const initial = { name: 'test', value: 123 };
    const context = Attrs.create(initial);
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
    const context = Attrs.create(data);
    expect(context.user).toBeDefined();
    expect(context.user.name).toBe('test');
    expect(context.user.settings).toBeDefined();
    expect(context.user.settings.theme).toBe('dark');
  });

  it('should create context with type inference', () => {
    const context = Attrs.create({
      name: 'test',
      count: 42,
      settings: { enabled: true },
    });

    expectTypeOf(context).toEqualTypeOf<
      Attrs<{
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

    const context = Attrs.create<UserContext>({
      name: 'John',
      age: 30,
      isAdmin: true,
    });

    expectTypeOf(context).toEqualTypeOf<Attrs<UserContext>>();

    expect(context.name).toBe('John');
    expect(context.age).toBe(30);
    expect(context.isAdmin).toBe(true);
  });

  it('should create a new object instance', () => {
    const original = { name: 'test' };
    const context = Attrs.create(original);

    // Verify it's a new object
    expect(context).not.toBe(original);

    // Modify the original, context should not change
    original.name = 'changed';
    expect(context.name).toBe('test');
  });

  it('should is work correctly', () => {
    const context = Attrs.create({ a: 1 });
    expect(Attrs.is(context)).toBe(true); // Branded
    expect(Attrs.is({ a: 1 })).toBe(false); // Not branded
    expect(Attrs.is({})).toBe(false);
    expect(Attrs.is(null)).toBe(false);
    expect(Attrs.is(undefined)).toBe(false);
  });
});
