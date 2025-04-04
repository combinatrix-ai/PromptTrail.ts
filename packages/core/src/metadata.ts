/**
 * Type-safe metadata implementation using Map
 */

/**
 * Type-safe metadata class extending Map with additional functionality
 */
/**
 * Metadata interface for type-safe key-value storage
 */
export interface Metadata<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  get<K extends keyof T>(key: K): T[K] | undefined;
  set<K extends keyof T>(key: K, value: T[K]): this;
  has(key: keyof T): boolean;
  delete(key: keyof T): boolean;
  clear(): void;
  keys(): IterableIterator<keyof T>;
  values(): IterableIterator<T[keyof T]>;
  entries(): IterableIterator<[keyof T, T[keyof T]]>;
  clone(): Metadata<T>;
  toObject(): T;
  toJSON(): T;
  toString(): string;
  forEach(callback: (value: T[keyof T], key: keyof T) => void): void;
  readonly size: number;
  merge<U extends Record<string, unknown>>(
    other: Metadata<U> | U,
  ): Metadata<T & U>;
  mergeNew<U extends Record<string, unknown>>(
    other: Metadata<U> | U,
  ): Metadata<T & U>;
  [Symbol.iterator](): Iterator<[keyof T, T[keyof T]]>;
}

/**
 * Internal implementation of Metadata interface
 */
class _MetadataImpl<T extends Record<string, unknown> = Record<string, unknown>>
  implements Metadata<T>
{
  private data: Map<string, unknown>;

  constructor(options: { initial?: T } = {}) {
    this.data = new Map();
    if (options.initial) {
      Object.entries(options.initial).forEach(([key, value]) => {
        this.data.set(key, value);
      });
    }
  }

  /**
   * Get a value from metadata
   */
  get<K extends keyof T>(key: K): T[K] | undefined {
    return this.data.get(String(key)) as T[K] | undefined;
  }

  /**
   * Set a value in metadata
   */
  set<K extends keyof T>(key: K, value: T[K]): this {
    this.data.set(String(key), value);
    return this;
  }

  /**
   * Check if metadata contains a key
   */
  has(key: keyof T): boolean {
    return this.data.has(String(key));
  }

  /**
   * Delete a key from metadata
   */
  delete(key: keyof T): boolean {
    return this.data.delete(String(key));
  }

  /**
   * Clear all metadata
   */
  clear(): void {
    this.data.clear();
  }

  /**
   * Get all keys in metadata
   */
  keys(): IterableIterator<keyof T> {
    return this.data.keys() as IterableIterator<keyof T>;
  }

  /**
   * Get all values in metadata
   */
  values(): IterableIterator<T[keyof T]> {
    return this.data.values() as IterableIterator<T[keyof T]>;
  }

  /**
   * Get all entries in metadata
   */
  entries(): IterableIterator<[keyof T, T[keyof T]]> {
    return this.data.entries() as IterableIterator<[keyof T, T[keyof T]]>;
  }

  /**
   * Create a new Metadata instance with the same data
   */
  clone(): Metadata<T> {
    const newMetadata = new _MetadataImpl<T>();
    for (const [key, value] of this.entries()) {
      newMetadata.set(key, this.cloneValue(value));
    }
    return newMetadata;
  }

  /**
   * Convert metadata to a plain object
   */
  toObject(): T {
    const obj = {} as T;
    for (const [key, value] of this.entries()) {
      obj[key] = value;
    }
    return obj;
  }

  /**
   * Convert metadata to JSON
   */
  toJSON(): T {
    return this.toObject();
  }

  /**
   * Create a string representation of metadata
   */
  toString(): string {
    return JSON.stringify(this.toObject(), null, 2);
  }

  /**
   * Iterate over metadata entries
   */
  forEach(callback: (value: T[keyof T], key: keyof T) => void): void {
    this.data.forEach((value, key) =>
      callback(value as T[keyof T], key as keyof T),
    );
  }

  /**
   * Get the number of entries in metadata
   */
  get size(): number {
    return this.data.size;
  }

  /**
   * Merge another metadata instance or object into this one
   */
  merge<U extends Record<string, unknown>>(
    other: Metadata<U> | U,
  ): Metadata<T & U> {
    const newMetadata = new _MetadataImpl<T & U>();

    // Copy current data
    for (const [key, value] of this.entries()) {
      newMetadata.data.set(String(key), value);
    }

    // Merge new data
    if ('entries' in other && typeof other.entries === 'function') {
      // Handle Metadata interface
      for (const [key, value] of other.entries()) {
        newMetadata.data.set(String(key), value);
      }
    } else {
      // Handle plain object
      Object.entries(other).forEach(([key, value]) => {
        newMetadata.data.set(key, value);
      });
    }

    return newMetadata;
  }

  /**
   * Create a new metadata instance by merging this one with another
   */
  mergeNew<U extends Record<string, unknown>>(
    other: Metadata<U> | U,
  ): Metadata<T & U> {
    return this.merge(other);
  }

  private cloneValue<V>(value: V): V {
    if (value === null || value === undefined) {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((v) => this.cloneValue(v)) as unknown as V;
    }
    if (typeof value === 'object') {
      const cloned: Record<string, unknown> = {};
      Object.entries(value as Record<string, unknown>).forEach(([k, v]) => {
        cloned[k] = this.cloneValue(v);
      });
      return cloned as V;
    }
    return value;
  }

  /**
   * Iterator implementation
   */
  *[Symbol.iterator](): Iterator<[keyof T, T[keyof T]]> {
    yield* this.entries();
  }
}

/**
 * Create a new metadata instance with type inference
 */
export function createMetadata<T extends Record<string, unknown>>(
  options: {
    initial?: T;
  } = {},
): Metadata<T> {
  return new _MetadataImpl<T>(options);
}
