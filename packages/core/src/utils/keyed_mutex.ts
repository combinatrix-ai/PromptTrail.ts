/**
 * Serializes async work by key using a per-key promise chain.
 *
 * Each key holds the tail of a promise chain; a new task links after the
 * current tail and becomes the new tail, so tasks for the same key run one at a
 * time in submission order. Distinct keys never block each other. The map entry
 * is deleted once its chain drains so the map does not grow unbounded.
 */
export class KeyedMutex {
  private readonly locks = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key);
    let releaseCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const chain = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => current);
    this.locks.set(key, chain);

    await previous?.catch(() => undefined);
    try {
      return await fn();
    } finally {
      releaseCurrent();
      if (this.locks.get(key) === chain) {
        this.locks.delete(key);
      }
    }
  }
}
