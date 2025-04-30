/**
 * Base implementation of a record like structure used in session.context and message.metadata
 * session.context is primarily used to store conversation data such as userId, lastVisited, etc,
 * and is used for interpolation in templates or function calls.
 * message.metadata is used to store message specific data such as role (used for roleplay etc), non message template such as hidden, etc.
 */

/**
 * Discriminated helpers – narrow with `_type`
 */
interface BaseTag<K extends string> {
  readonly _type: K;
}

/**
 * Metadata attached to a **message**
 * e.g.   { role: "assistant", hidden: true }
 */
export type Metadata<
  T extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<T & BaseTag<'metadata'>>;

/**
 * Context carried by a **session**
 * e.g.   { userId: "abc", lastVisited: Date }
 */
export type Context<
  T extends Record<string, unknown> = Record<string, unknown>,
> = Readonly<T & BaseTag<'context'>>;

/**
 * Plain-object constructor for Metadata
 */
export function createMetadata<T extends Record<string, unknown> = {}>(
  value?: T,
): Metadata<T> {
  return { ...(value ?? {}), _type: 'metadata' } as Metadata<T>;
}

/**
 * Plain-object constructor for Context
 */
export function createContext<T extends Record<string, unknown> = {}>(
  value?: T,
): Context<T> {
  return { ...(value ?? {}), _type: 'context' } as Context<T>;
}

/**
 * Non-destructive merge that preserves the tag.
 */
export function withUpdate<
  T extends Record<string, unknown>,
  U extends Record<string, unknown>,
  K extends 'metadata' | 'context',
>(
  obj: Readonly<T & BaseTag<K>>,
  patch: U,
): Readonly<Omit<T, keyof U> & U & BaseTag<K>> {
  return { ...obj, ...patch };
}
