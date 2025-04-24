/**
 * Metadata type for type-safe key-value storage
 * This is just a typed Record for human intuition
 */
export type Metadata<T extends Record<string, unknown> = Record<string, unknown>> = T;

/**
 * Create a new metadata object with type inference
 * @param metadata Initial metadata values
 * @returns A new metadata object
 */
export function createMetadata<T extends Record<string, unknown>>(
  metadata: T = {} as T,
): Metadata<T> {
  return { ...metadata };
}
