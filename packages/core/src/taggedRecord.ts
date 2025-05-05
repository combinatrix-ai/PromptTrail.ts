/**
 * Base implementation of a record like structure used in session.context and message.metadata
 * session.context is primarily used to store conversation data such as userId, lastVisited, etc,
 * and is used for interpolation in templates or function calls.
 * message.metadata is used to store message specific data such as role (used for roleplay etc), non message template such as hidden, etc.
 */

/**
 * Metadata attached to a **message**
 * e.g.   { role: "assistant", hidden: true }
 */
export type Metadata<
  T extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<T & { _type: 'metadata' }>;

/**
 * Context carried by a **session**
 * e.g.   { userId: "abc", lastVisited: Date }
 */
export type Context<
  T extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<T & { _type: 'context' }>;

/**
 * Plain-object constructor for Metadata
 */
export function createMetadata<
  T extends Record<string, unknown> | Metadata = {},
>(value?: T): Metadata<T> {
  return { ...(value ?? {}), _type: 'metadata' } as Metadata<T>;
}

/**
 * Plain-object constructor for Context
 */
export function createContext<T extends Record<string, unknown> | Context = {}>(
  value?: T,
): Context<T> {
  return { ...(value ?? {}), _type: 'context' } as Context<T>;
}

export function updateMetadata<T extends Metadata, K extends keyof T>(
  metadata: T | undefined,
  key: K,
  value: T[K],
): T {
  if (!metadata) {
    return createMetadata({ [key]: value } as T);
  }
  return { ...metadata, [key]: value } as T;
}

export function updateContext<T extends Context, K extends keyof T>(
  context: T | undefined,
  key: K,
  value: T[K],
): T {
  if (!context) {
    return createContext({ [key]: value } as T);
  }
  return { ...context, [key]: value } as T;
}
