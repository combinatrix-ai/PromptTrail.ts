import { describe, expect, it } from 'vitest';
import {
  DELETE_VALUE,
  ObserverBus,
  applyResolvedExecutionTransition,
  observerReceives,
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
  it('filters events by replay policy', () => {
    const event = {
      id: '1',
      type: 'tool.started',
      at: '2026-01-01T00:00:00.000Z',
      seq: 1,
      replay: 'replayed' as const,
    };

    expect(
      observerReceives({ replayPolicy: 'live-only', handle() {} }, event),
    ).toBe(false);
    expect(
      observerReceives(
        { replayPolicy: 'live-and-journaled', handle() {} },
        event,
      ),
    ).toBe(false);
    expect(
      observerReceives({ replayPolicy: 'adopt-replayed', handle() {} }, event),
    ).toBe(true);
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

  it('uses stable queue keys for unnamed observers after replay filtering', async () => {
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
        replayPolicy: 'live-only',
        async handle(event) {
          seen.push(`live:${event.id}`);
          firstStarted?.();
          await first;
        },
      },
      {
        replayPolicy: 'adopt-replayed',
        handle(event) {
          seen.push(`adopt:${event.id}`);
        },
      },
    ]);

    const emitLive = bus.emit({
      id: 'live',
      type: 'event',
      at: '2026-01-01T00:00:00.000Z',
      seq: 1,
      replay: 'live',
    });
    await started;

    await bus.emit({
      id: 'replayed',
      type: 'event',
      at: '2026-01-01T00:00:00.000Z',
      seq: 2,
      replay: 'replayed',
    });

    expect(seen).toEqual(['live:live', 'adopt:live', 'adopt:replayed']);
    releaseFirst?.();
    await emitLive;
  });
});
