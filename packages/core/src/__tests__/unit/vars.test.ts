import { describe, expect, expectTypeOf, it } from 'vitest';
import { Vars } from '../../tagged_record';

describe('Vars', () => {
  it('should create empty vars', () => {
    const vars = Vars.create({});
    expect(Object.keys(vars).length).toBe(0);
  });

  it('should create vars with initial data', () => {
    const initial = { name: 'test', value: 123 };
    const vars = Vars.create(initial);
    expect(vars.name).toBe('test');
    expect(vars.value).toBe(123);
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
    const vars = Vars.create(data);
    expect(vars.user).toBeDefined();
    expect(vars.user.name).toBe('test');
    expect(vars.user.settings).toBeDefined();
    expect(vars.user.settings.theme).toBe('dark');
  });

  it('should create vars with type inference', () => {
    const vars = Vars.create({
      name: 'test',
      count: 42,
      settings: { enabled: true },
    });

    expectTypeOf(vars).toEqualTypeOf<
      Vars<{
        name: string;
        count: number;
        settings: { enabled: boolean };
      }>
    >();
  });

  it('should work with type annotations', () => {
    type UserVars = {
      name: string;
      age: number;
      isAdmin: boolean;
    };

    const vars = Vars.create<UserVars>({
      name: 'John',
      age: 30,
      isAdmin: true,
    });

    expectTypeOf(vars).toEqualTypeOf<Vars<UserVars>>();

    expect(vars.name).toBe('John');
    expect(vars.age).toBe(30);
    expect(vars.isAdmin).toBe(true);
  });

  it('should create a new object instance', () => {
    const original = { name: 'test' };
    const vars = Vars.create(original);

    // Verify it's a new object
    expect(vars).not.toBe(original);

    // Modify the original, vars should not change
    original.name = 'changed';
    expect(vars.name).toBe('test');
  });

  it('should set update vars and dont change type with set', () => {
    const vars1 = Vars.create({ a: 1, b: 2 });
    const vars2 = Vars.create({ b: 3 });

    const merged = Vars.set(vars1, vars2);
    expectTypeOf(merged).toEqualTypeOf<
      Vars<{
        a: number;
        b: number;
      }>
    >();

    expect(merged.a).toBe(1);
    expect(merged.b).toBe(3); // Overwrites
  });

  it('should extend update/extend vars and may change type with extend', () => {
    const vars1 = Vars.create({ a: 1, b: 2 });
    const vars2 = Vars.create({ b: 3 });
    const vars3 = Vars.create({ b: 4, c: 5 });

    const merged = Vars.extend(vars1, vars2);
    expectTypeOf(merged).toEqualTypeOf<
      Vars<{
        a: number;
        b: number;
      }>
    >();
    expect(merged.a).toBe(1);
    expect(merged.b).toBe(3); // Overwrites
    // @ts-expect-error
    expect(merged.c).toBeUndefined(); // Not in vars1

    const merged2 = Vars.extend(vars1, vars3);
    expectTypeOf(merged2).toEqualTypeOf<
      Vars<{
        a: number;
        b: number;
        c: number;
      }>
    >();
    expect(merged2.a).toBe(1);
    expect(merged2.b).toBe(4); // Overwrites
    expect(merged2.c).toBe(5); // New key
  });

  it('should is work correctly', () => {
    const context = Vars.create({ a: 1 });
    expect(Vars.is(context)).toBe(true); // Branded
    expect(Vars.is({ a: 1 })).toBe(false); // Not branded
    expect(Vars.is({})).toBe(false);
    expect(Vars.is(null)).toBe(false);
    expect(Vars.is(undefined)).toBe(false);
  });
});
