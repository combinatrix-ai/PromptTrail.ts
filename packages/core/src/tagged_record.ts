/**
 * This is a tagged record implementation for creating immutable objects.
 * We need to use `unique symbol` to create a unique type for the brand.
 * Also, we cannot do just `export const ctxBrand: unique symbol` because
 * it will disappear on transpilation and we will lose the runtime.
 */
export const varsBrand: unique symbol = Symbol('varsBrand') as any;
export const attrsBrand: unique symbol = Symbol('attrsBrand') as any;

export type Vars<T extends Record<string, unknown> = {}> = Readonly<T> & {
  readonly [varsBrand]: void;
};

/**
 * Vars is a tagged record that allows you to create a read-only object
 * with additional properties for use in a context.
 * It is useful for storing data from outside the context,
 * variables to be used in interactions, and other data that needs to be passed around.
 *
 * @param v - The initial value of the Vars.
 * @returns A read-only object with the specified type.
 */
export function Vars<T extends Record<string, unknown> = {}>(v: T): Vars<T> {
  return v as Vars<T>;
}

export namespace Vars {
  /** recommended entry point */
  export const create = <T extends Record<string, unknown> = {}>(
    v: T,
  ): Vars<T> =>
    ({
      ...v,
      // We have actual ctxBrand key here, but this is a Symbol key
      // and won't appear in JSON.stringify etc.
      [varsBrand]: undefined,
    }) as Vars<T>;

  export const is = (x: unknown): x is Vars<any> =>
    !!x && typeof x === 'object' && varsBrand in (x as any);

  /** Overwrite existing key in Context */
  export const withValue = <
    C extends Record<string, unknown>,
    K extends string,
    V,
  >(
    ctx: Vars<C>,
    key: K,
    value: V,
  ): Vars<C & { [P in K]: V }> =>
    Vars.patch(ctx, { [key]: value } as { [P in K]: V });

  /**
   * Merge multiple fields into the existing Context as a patch.
   * Can create a new type with additional fields.
   */
  export const patch = <
    C extends Record<string, unknown>,
    U extends Record<string, unknown>,
  >(
    ctx: Vars<C>,
    patch: U,
  ): Vars<C & U> => Vars({ ...ctx, ...patch });
}

export type Attrs<T extends Record<string, unknown> = {}> = Readonly<T> & {
  readonly [attrsBrand]: void;
};

/**
 * Attrs is a tagged record that allows you to create a read-only object
 * with additional properties in messages.
 * It is useful for storing information about the message, such as the role, hidden flag etc.
 *
 * @param v - The initial value of the metadata.
 * @returns A read-only object with the specified type.
 */
export function Attrs<T extends Record<string, unknown> = {}>(v: T): Attrs<T> {
  return v as Attrs<T>;
}

export namespace Attrs {
  /** recommended entry point */
  export const create = <T extends Record<string, unknown> = {}>(
    v: T,
  ): Attrs<T> =>
    ({
      ...v,
      // We have actual metaBrand key here, but this is a Symbol key
      // and won't appear in JSON.stringify etc.
      [attrsBrand]: undefined,
    }) as Attrs<T>;

  export const is = (x: unknown): x is Attrs<any> =>
    !!x && typeof x === 'object' && attrsBrand in (x as any);

  /** Overwrite existing key in Metadata */
  export const withValue = <
    M extends Record<string, unknown>,
    K extends keyof M,
  >(
    meta: Attrs<M> | undefined,
    key: K,
    value: M[K],
  ): Attrs<Omit<M, K> & { [P in K]: M[P] }> => {
    const patch = { [key]: value } as { [P in K]: M[P] };
    const base: Attrs<M> = meta ?? Attrs.create({} as M);
    // 2つめのジェネリック <M, K> を明示してもOK
    return Attrs.merge(base, patch);
  };

  /**
   * Merge multiple fields into the existing Context.
   * Can create a new type with additional fields.
   */

  export const merge = <
    M extends Record<string, unknown>,
    U extends keyof M, // ← 上書きするキー集合
  >(
    meta: Attrs<M>,
    patch: Pick<M, U>, // ← そのキーは *必須* で型も同じ
  ): Attrs<Omit<M, U> & Pick<M, U>> => Attrs({ ...meta, ...patch });
}
