/**
 * This is a tagged record implementation for creating immutable objects.
 * We need to use `unique symbol` to create a unique type for the brand.
 * Also, we cannot do just `export const ctxBrand: unique symbol` because
 * it will disappear on transpilation and we will lose the runtime.
 */
export const ctxBrand: unique symbol = Symbol('ctxBrand') as any;
export const metaBrand: unique symbol = Symbol('metaBrand') as any;

export type Context<T extends object = {}> = Readonly<T> & {
  readonly [ctxBrand]: void;
};

/**
 * Context is a tagged record that allows you to create a read-only object
 * with additional properties. It is useful for creating immutable objects
 * with a specific type.
 *
 * @param v - The initial value of the context.
 * @returns A read-only object with the specified type.
 */
export function Context<T extends object = {}>(v: T): Context<T> {
  return v as Context<T>;
}

export namespace Context {
  /** recommended entry point */
  export const create = <T extends object>(v: T): Context<T> =>
    ({
      ...v,
      // We have actual ctxBrand key here, but this is a Symbol key
      // and won't appear in JSON.stringify etc.
      [ctxBrand]: undefined,
    }) as Context<T>;

  export const is = (x: unknown): x is Context<any> =>
    !!x && typeof x === 'object' && ctxBrand in (x as any);

  /** Overwrite existing key in Context */
  export const withValue = <C extends object, K extends string, V>(
    ctx: Context<C>,
    key: K,
    value: V,
  ): Context<C & { [P in K]: V }> =>
    Context.merge(ctx, { [key]: value } as { [P in K]: V });

  /**
   * Merge multiple fields into the existing Context.
   * Can create a new type with additional fields.
   */
  export const merge = <C extends object, U extends object>(
    ctx: Context<C>,
    patch: U,
  ): Context<C & U> => Context({ ...ctx, ...patch });
}

export type Metadata<T extends object = {}> = Readonly<T> & {
  readonly [metaBrand]: void;
};

/**
 * Metadata is a tagged record that allows you to create a read-only object
 * with additional properties. It is useful for creating immutable objects
 * with a specific type.
 *
 * @param v - The initial value of the metadata.
 * @returns A read-only object with the specified type.
 */
export function Metadata<T extends object = {}>(v: T): Metadata<T> {
  return v as Metadata<T>;
}

export namespace Metadata {
  /** recommended entry point */
  export const create = <T extends object>(v: T): Metadata<T> =>
    ({
      ...v,
      // We have actual metaBrand key here, but this is a Symbol key
      // and won't appear in JSON.stringify etc.
      [metaBrand]: undefined,
    }) as Metadata<T>;

  export const is = (x: unknown): x is Metadata<any> =>
    !!x && typeof x === 'object' && metaBrand in (x as any);

  /** Overwrite existing key in Metadata */
  export const withValue = <M extends object, K extends string, V>(
    meta: Metadata<M>,
    key: K,
    value: V,
  ): Metadata<M & { [P in K]: V }> =>
    Metadata.merge(meta, { [key]: value } as { [P in K]: V });

  /**
   * Merge multiple fields into the existing Context.
   * Can create a new type with additional fields.
   */
  export const merge = <M extends object, U extends object>(
    meta: Metadata<M>,
    patch: U,
  ): Metadata<M & U> => Metadata({ ...meta, ...patch });
}
