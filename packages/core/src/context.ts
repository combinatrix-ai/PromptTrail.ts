/**
 * Context type for type-safe key-value storage
 */
export type Context<T extends Record<string, unknown> = Record<string, unknown>> = T;

/**
 * Create a new context object with type inference
 * @param options Options for creating the context
 * @returns A new context object
 */
export function createContext<T extends Record<string, unknown>>(
  options: {
    initial?: T;
  } = {},
): Context<T> {
  return { ...(options.initial || {}) } as Context<T>;
}
