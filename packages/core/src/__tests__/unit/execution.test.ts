import { describe, expect, it } from 'vitest';
import {
  DELETE_VALUE,
  Observer,
  ObserverBus,
  applyResolvedExecutionTransition,
  createObserverDeliveryBindings,
  inMemoryObserverDeliveryBindingStore,
  resolveExecutionTransition,
} from '../../execution';
import { Message } from '../../message';
import { createSession } from '../../session';

describe('execution transitions', () => {
  it('normalizes object patches into serializable transitions', () => {
    const session = createSession({
      context: { keep: 'yes', remove: 'old' },
      messages: [Message.user('hello')],
    });

    const transition = resolveExecutionTransition(session, {
      session: {
        appendMessages: [Message.assistant('world')],
        vars: {
          add: 1,
          remove: DELETE_VALUE,
        },
        middlewareState: {
          phaseCount: 2,
        },
      },
      command: { type: 'suspend', reason: 'approval' },
    });

    expect(transition).toMatchObject({
      schemaVersion: 1,
      beforeVersion: 0,
      afterVersion: 1,
      session: {
        messageOp: {
          type: 'append',
          messages: [{ type: 'assistant', content: 'world' }],
        },
        varsSet: { add: 1 },
        varsDelete: ['remove'],
        middlewareStateSet: { phaseCount: 2 },
        middlewareStateDelete: [],
      },
      command: { type: 'suspend', reason: 'approval' },
    });

    const applied = applyResolvedExecutionTransition(session, transition, {
      middlewareState: { old: true },
    });

    expect(applied.session.messages.map((message) => message.content)).toEqual([
      'hello',
      'world',
    ]);
    expect(applied.session.getVarsObject()).toEqual({ keep: 'yes', add: 1 });
    expect(applied.middlewareState).toEqual({ old: true, phaseCount: 2 });
    expect(applied.command).toEqual({ type: 'suspend', reason: 'approval' });
  });

  it('diffs returned Session patches without storing patch functions', () => {
    const session = createSession({
      context: { count: 1, stale: true },
      messages: [Message.user('start')],
    });

    const transition = resolveExecutionTransition(session, {
      session: (current) =>
        createSession({
          context: { count: current.getVar('count') + 1 },
          messages: [...current.messages, Message.assistant('next')],
        }),
    });

    expect(transition.session).toMatchObject({
      messageOp: {
        type: 'append',
        messages: [{ type: 'assistant', content: 'next' }],
      },
      varsSet: { count: 2 },
      varsDelete: ['stale'],
    });

    const applied = applyResolvedExecutionTransition(session, transition);
    expect(applied.session.getVarsObject()).toEqual({ count: 2 });
    expect(applied.session.getLastMessage()?.content).toBe('next');
  });

  it('treats contentParts message prefixes as append-compatible', () => {
    const session = createSession({
      messages: [
        {
          type: 'user',
          content: 'look',
          contentParts: [{ kind: 'text', text: 'look' }],
        },
      ],
    });

    const transition = resolveExecutionTransition(session, {
      session: (current) =>
        createSession({
          messages: [...current.messages, Message.assistant('next')],
        }),
    });

    expect(transition.session.messageOp).toMatchObject({
      type: 'append',
      messages: [{ type: 'assistant', content: 'next' }],
    });
  });

  it('compares message prefixes independent of object key insertion order', () => {
    const session = createSession({
      messages: [
        {
          type: 'user',
          content: 'ordered attrs',
          attrs: { a: 1, b: 2 },
        },
      ],
    });

    const transition = resolveExecutionTransition(session, {
      session: () =>
        createSession({
          messages: [
            {
              type: 'user',
              content: 'ordered attrs',
              attrs: { b: 2, a: 1 },
            },
            Message.assistant('next'),
          ],
        }),
    });

    expect(transition.session.messageOp).toMatchObject({
      type: 'append',
      messages: [{ type: 'assistant', content: 'next' }],
    });
  });

  it('uses explicit monotonic versions instead of message count', () => {
    const session = createSession({
      messages: [Message.user('one'), Message.user('two')],
    });

    const varsOnly = resolveExecutionTransition(
      session,
      {
        session: {
          vars: {
            done: true,
          },
        },
      },
      { beforeVersion: 10 },
    );
    expect(varsOnly.beforeVersion).toBe(10);
    expect(varsOnly.afterVersion).toBe(11);

    const multiAppend = resolveExecutionTransition(
      session,
      {
        session: {
          appendMessages: [Message.assistant('a'), Message.assistant('b')],
        },
      },
      { beforeVersion: varsOnly.afterVersion },
    );
    expect(multiAppend.beforeVersion).toBe(11);
    expect(multiAppend.afterVersion).toBe(12);
  });

  it('rejects ambiguous and non-serializable authored object patches', () => {
    const session = createSession();

    expect(() =>
      resolveExecutionTransition(session, {
        session: {
          appendMessages: [Message.user('append')],
          replaceMessages: [Message.user('replace')],
        },
      }),
    ).toThrow('appendMessages and replaceMessages');

    expect(() =>
      resolveExecutionTransition(session, {
        session: {
          vars: {
            bad: undefined,
          },
        },
      }),
    ).toThrow('cannot be undefined');

    expect(() =>
      resolveExecutionTransition(session, {
        session: () =>
          createSession({
            context: {
              bad: undefined,
            },
          }),
      }),
    ).toThrow('cannot be undefined');
  });
});

describe('observer bus', () => {
  it('accepts Observer.create object observers', async () => {
    const seen: string[] = [];
    const bus = new ObserverBus([
      Observer.create({
        name: 'logger',
        handle(event) {
          seen.push(event.type);
        },
      }),
    ]);

    await bus.emit({
      id: 'event-1',
      type: 'tool.completed',
      at: '2026-01-01T00:00:00.000Z',
      seq: 3,
    });

    expect(seen).toEqual(['tool.completed']);
  });

  it('serializes deliveries per observer', async () => {
    const seen: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const bus = new ObserverBus([
      {
        name: 'slow',
        async handle(event) {
          seen.push(`start:${event.id}`);
          if (event.id === '1') {
            firstStarted?.();
            await first;
          }
          seen.push(`end:${event.id}`);
        },
      },
    ]);

    const emit1 = bus.emit({
      id: '1',
      type: 'event',
      at: '2026-01-01T00:00:00.000Z',
      seq: 1,
    });
    const emit2 = bus.emit({
      id: '2',
      type: 'event',
      at: '2026-01-01T00:00:00.000Z',
      seq: 2,
    });

    await started;
    expect(seen).toEqual(['start:1']);
    releaseFirst?.();
    await Promise.all([emit1, emit2]);
    expect(seen).toEqual(['start:1', 'end:1', 'start:2', 'end:2']);
  });

  it('uses stable queue keys for unnamed observers', async () => {
    const seen: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStarted: (() => void) | undefined;
    let secondFastSeen: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const fastSecond = new Promise<void>((resolve) => {
      secondFastSeen = resolve;
    });
    const bus = new ObserverBus([
      {
        async handle(event) {
          seen.push(`slow:start:${event.id}`);
          if (event.id === '1') {
            firstStarted?.();
            await first;
          }
          seen.push(`slow:end:${event.id}`);
        },
      },
      {
        handle(event) {
          seen.push(`fast:${event.id}`);
          if (event.id === '2') {
            secondFastSeen?.();
          }
        },
      },
    ]);

    const emit1 = bus.emit({
      id: '1',
      type: 'event',
      at: '2026-01-01T00:00:00.000Z',
      seq: 1,
    });
    await started;
    expect(seen).toEqual(['slow:start:1', 'fast:1']);

    const emit2 = bus.emit({
      id: '2',
      type: 'event',
      at: '2026-01-01T00:00:00.000Z',
      seq: 2,
    });
    await fastSecond;

    expect(seen).toEqual(['slow:start:1', 'fast:1', 'fast:2']);
    releaseFirst?.();
    await Promise.all([emit1, emit2]);
    expect(seen).toEqual([
      'slow:start:1',
      'fast:1',
      'fast:2',
      'slow:end:1',
      'slow:start:2',
      'slow:end:2',
    ]);
  });

  it('emits observer.failed without failing best-effort observer delivery', async () => {
    const seen: string[] = [];
    const bus = new ObserverBus([
      {
        name: 'failing',
        handle(event) {
          seen.push(`failing:${event.type}`);
          throw new Error('observer broke');
        },
      },
      {
        name: 'reporter',
        handle(event) {
          seen.push(`reporter:${event.type}`);
        },
      },
    ]);

    await bus.emit({
      id: 'event-1',
      type: 'tool.started',
      at: '2026-01-01T00:00:00.000Z',
      seq: 3,
    });

    expect(seen).toEqual([
      'failing:tool.started',
      'reporter:tool.started',
      'reporter:observer.failed',
    ]);
  });

  it('throws observer failures when strictObservers is enabled', async () => {
    const bus = new ObserverBus(
      [
        {
          name: 'failing',
          handle() {
            throw new Error('observer broke');
          },
        },
      ],
      { strictObservers: true },
    );

    await expect(
      bus.emit({
        id: 'event-1',
        type: 'tool.started',
        at: '2026-01-01T00:00:00.000Z',
        seq: 3,
      }),
    ).rejects.toThrow('observer broke');
  });

  it('injects deliveryBindings.checkWrite into observer contexts', async () => {
    const writes: string[] = [];
    const bus = new ObserverBus([
      {
        name: 'writer',
        async handle(event, context) {
          await context.deliveryBindings?.checkWrite(
            String(event.idempotencyKey),
            async () => {
              writes.push(String(event.idempotencyKey));
              return { platformId: `msg:${event.idempotencyKey}` };
            },
          );
        },
      },
    ]);
    const event = {
      id: 'event-1',
      type: 'tool.started',
      at: '2026-01-01T00:00:00.000Z',
      seq: 3,
      idempotencyKey: 'progress:1',
    };

    await bus.emit(event);
    await bus.emit(event);

    expect(writes).toEqual(['progress:1']);
  });

  it('namespaces delivery binding writes per observer', async () => {
    const writes: string[] = [];
    const bus = new ObserverBus([
      {
        name: 'chat-progress',
        async handle(event, context) {
          await context.deliveryBindings?.checkWrite(
            String(event.idempotencyKey),
            async () => {
              writes.push(`chat:${event.idempotencyKey}`);
            },
          );
        },
      },
      {
        name: 'metrics-progress',
        async handle(event, context) {
          await context.deliveryBindings?.checkWrite(
            String(event.idempotencyKey),
            async () => {
              writes.push(`metrics:${event.idempotencyKey}`);
            },
          );
        },
      },
    ]);

    await bus.emit({
      id: 'event-1',
      type: 'tool.started',
      at: '2026-01-01T00:00:00.000Z',
      seq: 3,
      idempotencyKey: 'progress:1',
    });

    expect(writes).toEqual(['chat:progress:1', 'metrics:progress:1']);
  });

  it('uses unambiguous observer delivery binding namespace keys', async () => {
    const writes: string[] = [];
    const bus = new ObserverBus([
      {
        name: 'observer',
        async handle(_event, context) {
          await context.deliveryBindings?.checkWrite('1:progress', async () => {
            writes.push('named');
          });
        },
      },
      async (_event, context) => {
        await context.deliveryBindings?.checkWrite('progress', async () => {
          writes.push('anonymous');
        });
      },
    ]);

    await bus.emit({
      id: 'event-1',
      type: 'tool.started',
      at: '2026-01-01T00:00:00.000Z',
      seq: 3,
    });

    expect(writes).toEqual(['named', 'anonymous']);
  });

  it('namespaces caller-provided observer delivery bindings', async () => {
    const writes: string[] = [];
    const bindings = createObserverDeliveryBindings(
      inMemoryObserverDeliveryBindingStore(),
    );
    const bus = new ObserverBus([
      {
        name: 'first',
        async handle(event, context) {
          await context.deliveryBindings?.checkWrite(
            String(event.idempotencyKey),
            async () => {
              writes.push(`first:${event.idempotencyKey}`);
            },
          );
        },
      },
      {
        name: 'second',
        async handle(event, context) {
          await context.deliveryBindings?.checkWrite(
            String(event.idempotencyKey),
            async () => {
              writes.push(`second:${event.idempotencyKey}`);
            },
          );
        },
      },
    ]);

    await bus.emit(
      {
        id: 'event-1',
        type: 'tool.started',
        at: '2026-01-01T00:00:00.000Z',
        seq: 3,
        idempotencyKey: 'progress:1',
      },
      { deliveryBindings: bindings },
    );

    expect(writes).toEqual(['first:progress:1', 'second:progress:1']);
  });

  it('releases delivery binding claims when observer writes fail', async () => {
    const writes: string[] = [];
    let fail = true;
    const bus = new ObserverBus([
      {
        name: 'writer',
        async handle(event, context) {
          await context.deliveryBindings?.checkWrite(
            String(event.idempotencyKey),
            async () => {
              writes.push(String(event.idempotencyKey));
              if (fail) {
                fail = false;
                throw new Error('write failed');
              }
              return 'sent';
            },
          );
        },
      },
    ]);
    const event = {
      id: 'event-1',
      type: 'tool.started',
      at: '2026-01-01T00:00:00.000Z',
      seq: 3,
      idempotencyKey: 'progress:retry',
    };

    await bus.emit(event);
    await bus.emit(event);

    expect(writes).toEqual(['progress:retry', 'progress:retry']);
  });

  it('keeps delivery binding claims when completion bookkeeping fails', async () => {
    const claimed = new Set<string>();
    const writes: string[] = [];
    const bus = new ObserverBus(
      [
        {
          name: 'writer',
          async handle(event, context) {
            await context.deliveryBindings?.checkWrite(
              String(event.idempotencyKey),
              async () => {
                writes.push(String(event.idempotencyKey));
                return 'sent';
              },
            );
          },
        },
      ],
      {
        deliveryBindingStore: {
          claim(idempotencyKey) {
            if (claimed.has(idempotencyKey)) {
              return false;
            }
            claimed.add(idempotencyKey);
            return true;
          },
          complete() {
            throw new Error('complete failed');
          },
          delete(idempotencyKey) {
            claimed.delete(idempotencyKey);
          },
        },
      },
    );
    const event = {
      id: 'event-1',
      type: 'tool.started',
      at: '2026-01-01T00:00:00.000Z',
      seq: 3,
      idempotencyKey: 'progress:complete-failed',
    };

    await bus.emit(event);
    await bus.emit(event);

    expect(writes).toEqual(['progress:complete-failed']);
  });

  it('bounds in-memory observer delivery bindings', async () => {
    const writes: string[] = [];
    const bus = new ObserverBus(
      [
        {
          name: 'writer',
          async handle(event, context) {
            await context.deliveryBindings?.checkWrite(
              String(event.idempotencyKey),
              async () => {
                writes.push(String(event.idempotencyKey));
              },
            );
          },
        },
      ],
      {
        deliveryBindingStore: inMemoryObserverDeliveryBindingStore({
          maxEntries: 1,
        }),
      },
    );

    await bus.emit({
      id: 'event-1',
      type: 'tool.started',
      at: '2026-01-01T00:00:00.000Z',
      seq: 1,
      idempotencyKey: 'progress:1',
    });
    await bus.emit({
      id: 'event-2',
      type: 'tool.started',
      at: '2026-01-01T00:00:00.000Z',
      seq: 2,
      idempotencyKey: 'progress:2',
    });
    await bus.emit({
      id: 'event-3',
      type: 'tool.started',
      at: '2026-01-01T00:00:00.000Z',
      seq: 3,
      idempotencyKey: 'progress:1',
    });

    expect(writes).toEqual(['progress:1', 'progress:2', 'progress:1']);
  });
});
