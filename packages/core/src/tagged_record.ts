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
export type Attrs<T extends Record<string, unknown> = {}> = Readonly<T> & {
  readonly [attrsBrand]: void;
};

/**
 * Vars is a tagged record that allows you to create a read-only object
 * with additional properties for use in a Vars.
 * It is useful for storing data from outside the Vars,
 * variables to be used in interactions, and other data that needs to be passed around.
 *
 * @param v - The initial value of the Vars.
 * @returns A read-only object with the specified type.
 */
export function Vars<T extends Record<string, unknown> = {}>(v: T): Vars<T> {
  return v as Vars<T>;
}

/**
 * Attrs is a tagged record that allows you to create a read-only object
 * with additional properties in messages.
 * It is useful for storing information about the message, such as the role, hidden flag etc.
 *
 * @param v - The initial value of the Attrs.
 * @returns A read-only object with the specified type.
 */
export function Attrs<T extends Record<string, unknown> = {}>(v: T): Attrs<T> {
  return v as Attrs<T>;
}

export namespace Vars {
  /**
   * Create a new Vars object.
   * @param v - The initial value of the Vars.
   * @returns A new Vars object with the specified type.
   * @example
   * const v = Vars.create({ name: 'test', value: 123 });
   * console.log(v) // { name: 'test', value: 123 }
   * console.log(v.name) // 'test'
   * console.log(v.value) // 123
   */
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

  /**
   * Overwrite existing key in Vars
   * @param vars - The existing Vars object.
   * @param patch - The patch object containing the new value for the key. The key must be a valid key in the Vars object.
   * @returns A new Vars object with the updated key with the same type as the original Vars object.
   * @example
   * const v = Vars.create({ name: 'test', value: 123 });
   * const updated = Vars.set(v, { name: 'newTest' });
   * console.log(v) // { name: 'test', value: 123 }
   * console.log(updated) // { name: 'newTest', value: 123 }
   */
  export const set = <
    M extends Record<string, unknown>,
    U extends keyof M,
  >(
    vars: Vars<M> | undefined,
    patch: Pick<M, U> | Vars<Pick<M, U>>,
  ): Vars<Omit<M, U> & Pick<M, U>> => {
    const base: Vars<M> = vars ?? Vars.create({} as M);
    return Vars.create({
      ...base,
      ...patch,
    });
  }

  /**
   * Extend existing Vars object with new keys if they don't exist
   * @param vars - The existing Vars object.
   * @param patch - The patch object containing the new value for the key. The key can be a new key or an existing key.
   * @returns A new Vars object. The type of the new Vars object is the same as the original Vars object or extended type if new keys are added.
   * @example
   * const v = Vars.create({ name: 'test', value: 123 });
   * console.log(v) // { name: 'test', value: 123, newKey: 'newValue' }
   * typeof v // Vars<{ name: string; value: number }>
   * const updated = Vars.extend(v, { name: 'newTest' });
   * console.log(updated) // { name: 'newTest', value: 123 }
   * typeof updated // Vars<{ name: string; value: number }>
   * const updated2 = Vars.extend(v, { name: 'newTest', newKey: 'newValue' });
   * console.log(updated2) // { name: 'newTest', value: 123, newKey: 'newValue' }
   * typeof updated2 // Vars<{ name: string; value: number; newKey: string }>
   */
  export const extend = <
    M extends Record<string, unknown>,
    U extends Record<string, unknown>,
  >(
    vars: Vars<M> | undefined,
    patch: U | Vars<U>,
  ): Vars<Omit<M, keyof U> & U> => {
    const base: Vars<M> = vars ?? Vars.create({} as M);
    return Vars.create({
      ...base,
      ...patch,
    });
  }
}

export namespace Attrs {
  /**
   * Create a new Attrs object.
   * @param v - The initial value of the Attrs.
   * @returns A new Attrs object with the specified type.
   * @example
   * const v = Attrs.create({ name: 'test', value: 123 });
   * console.log(v) // { name: 'test', value: 123 }
   * console.log(v.name) // 'test'
   * console.log(v.value) // 123
   */
  export const create = <T extends Record<string, unknown> = {}>(
    v: T,
  ): Attrs<T> =>
    ({
      ...v,
      // We have actual attrsBrand key here, but this is a Symbol key
      // and won't appear in JSON.stringify etc.
      [attrsBrand]: undefined,
    }) as Attrs<T>;

  export const is = (x: unknown): x is Attrs<any> =>
    !!x && typeof x === 'object' && attrsBrand in (x as any);

  /**
   * Overwrite existing key in Attrs
   * @param attrs - The existing Attrs object.
   * @param patch - The patch object containing the new value for the key. The key must be a valid key in the Attrs object.
   * @returns A new Attrs object with the updated key with the same type as the original Attrs object.
   * @example
   * const v = Attrs.create({ name: 'test', value: 123 });
   * const updated = Attrs.set(v, { name: 'newTest' });
   * console.log(v) // { name: 'test', value: 123 }
   * console.log(updated) // { name: 'newTest', value: 123 }
   */
  export const set = <
    M extends Record<string, unknown>,
    U extends keyof M,
  >(
    attrs: Attrs<M> | undefined,
    patch: Pick<M, U> | Attrs<Pick<M, U>>,
  ): Attrs<Omit<M, U> & Pick<M, U>> => {
    const base: Attrs<M> = attrs ?? Attrs.create({} as M);
    return Attrs.create({
      ...base,
      ...patch,
    });
  };

  /**
   * Extend existing Attrs object with new keys if they don't exist
   * @param attrs - The existing Attrs object.
   * @param patch - The patch object containing the new value for the key. The key can be a new key or an existing key.
   * @returns A new Attrs object. The type of the new Attrs object is the same as the original Attrs object or extended type if new keys are added.
   * @example
   * const v = Attrs.create({ name: 'test', value: 123 });
   * console.log(v) // { name: 'test', value: 123, newKey: 'newValue' }
   * typeof v // Attrs<{ name: string; value: number }>
   * const updated = Attrs.extend(v, { name: 'newTest' });
   * console.log(updated) // { name: 'newTest', value: 123 }
   * typeof updated // Attrs<{ name: string; value: number }>
   * const updated2 = Attrs.extend(v, { name: 'newTest', newKey: 'newValue' });
   * console.log(updated2) // { name: 'newTest', value: 123, newKey: 'newValue' }
   * typeof updated2 // Attrs<{ name: string; value: number; newKey: string }>
   */
  export const extend = <
    M extends Record<string, unknown>,
    U extends Record<string, unknown>,
  >(
    attrs: Attrs<M> | undefined,
    patch: U | Attrs<U>,
  ): Attrs<Omit<M, keyof U> & U> => {
    const base: Attrs<M> = attrs ?? Attrs.create({} as M);
    return Attrs.create({
      ...base,
      ...patch,
    });
  }
}
