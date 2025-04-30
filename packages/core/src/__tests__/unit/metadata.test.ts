import { describe, it, expect } from 'vitest';
import { createMetadata, type Metadata } from '../../taggedRecord';

describe('Metadata', () => {
  it('should create empty metadata', () => {
    const metadata = createMetadata();
    expect(Object.keys(metadata).length).toBe(0);
  });

  it('should create metadata with initial data', () => {
    const initial = { name: 'test', value: 123 };
    const metadata = createMetadata(initial);
    expect(metadata.name).toBe('test');
    expect(metadata.value).toBe(123);
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
    const metadata = createMetadata(data);
    expect(metadata.user).toEqual(data.user);
  });

  it('should create metadata with type inference', () => {
    const metadata = createMetadata({
      name: 'test',
      count: 42,
      settings: { enabled: true },
    });

    expect(metadata.name).toBe('test');
    expect(metadata.count).toBe(42);
    expect(metadata.settings).toEqual({ enabled: true });
  });

  it('should create a new object instance', () => {
    const original = { name: 'test' };
    const metadata = createMetadata(original);

    // Verify it's a new object
    expect(metadata).not.toBe(original);

    // Modify the original, metadata should not change
    original.name = 'changed';
    expect(metadata.name).toBe('test');
  });

  it('should work with type annotations', () => {
    type UserMetadata = {
      name: string;
      age: number;
      isAdmin: boolean;
    };

    const metadata = createMetadata<UserMetadata>({
      name: 'John',
      age: 30,
      isAdmin: true,
    });

    expect(metadata.name).toBe('John');
    expect(metadata.age).toBe(30);
    expect(metadata.isAdmin).toBe(true);
  });
});
