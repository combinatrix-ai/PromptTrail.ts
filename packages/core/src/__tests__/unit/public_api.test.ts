import { describe, expect, it } from 'vitest';
import * as prompttrail from '../../index';
import type {
  AgentDirectDurableOptions,
  AgentExecuteOptions,
  AgentExecutionOptions,
  AgentGoalOptions,
  DurableTool,
  ExecutionDurableActivityOptions,
  ExecutionDurableBoundary,
  ExecutionEvent,
  ObserverDeliveryBindingStore,
} from '../../index';

describe('public API surface', () => {
  it('does not re-export ai-sdk tool helpers from core', () => {
    expect(prompttrail).not.toHaveProperty('tool');
    expect(prompttrail).not.toHaveProperty('aiSdkToolToPromptTrailTool');
    expect(prompttrail).not.toHaveProperty('promptTrailToolToAiSdkTool');
    expect(prompttrail).not.toHaveProperty('toAiSdkToolSet');
    expect(prompttrail).toHaveProperty('Tool');
  });

  it('does not expose root providerOptions fluent configuration', () => {
    expect(prompttrail.Source.llm()).not.toHaveProperty('providerOptions');
  });

  it('types external-write durable activities with required idempotency keys', () => {
    const read: ExecutionDurableActivityOptions = { kind: 'external-read' };
    const write: ExecutionDurableActivityOptions = {
      kind: 'external-write',
      idempotencyKey: 'write:1',
    };
    // @ts-expect-error external-write activities need an idempotency key.
    const missingKey: ExecutionDurableActivityOptions = {
      kind: 'external-write',
    };

    expect(read.kind).toBe('external-read');
    expect(write.idempotencyKey).toBe('write:1');
    expect(missingKey.kind).toBe('external-write');
  });

  it('types external-write durable tool activities with required idempotency keys', () => {
    const readTool: DurableTool = {
      activity: { kind: 'external-read' },
      execute: () => 'read',
    };
    const writeTool: DurableTool = {
      activity: {
        kind: 'external-write',
        idempotencyKey: 'write:tool',
        retry: { maxAttempts: 2 },
      },
      execute: () => 'write',
    };
    const dynamicWriteTool: DurableTool = {
      activity: (call) => ({
        kind: 'external-write',
        idempotencyKey: `write:${call.id}`,
      }),
      execute: () => 'write',
    };
    const missingKeyTool: DurableTool = {
      // @ts-expect-error external-write durable tools need idempotency keys.
      activity: { kind: 'external-write' },
      execute: () => 'missing',
    };
    const dynamicMissingKeyTool: DurableTool = {
      // @ts-expect-error dynamic external-write durable tool activities need idempotency keys.
      activity: () => ({ kind: 'external-write' }),
      execute: () => 'missing',
    };

    expect(readTool.activity).toEqual({ kind: 'external-read' });
    expect(writeTool.activity).toEqual({
      kind: 'external-write',
      idempotencyKey: 'write:tool',
      retry: { maxAttempts: 2 },
    });
    expect(typeof dynamicWriteTool.activity).toBe('function');
    expect(missingKeyTool.activity).toEqual({ kind: 'external-write' });
    expect(typeof dynamicMissingKeyTool.activity).toBe('function');
  });

  it('types run lifecycle hook aliases', () => {
    const hook = prompttrail.Hook.create({
      name: 'lifecycle',
      onRunStart: ({ session }) => ({
        session: { vars: { started: session.messages.length } },
      }),
      onRunEnd: ({ session }) => ({
        session: { vars: { ended: session.messages.length } },
      }),
      onBeforeTemplate: ({ session }) => ({
        session: { vars: { beforeTemplate: session.messages.length } },
      }),
      onAfterTemplate: ({ session }) => ({
        session: { vars: { afterTemplate: session.messages.length } },
      }),
    });

    expect(hook.name).toBe('lifecycle');
  });

  it('types direct agent execution options', async () => {
    const controller = new AbortController();
    const durable: AgentDirectDurableOptions = {
      runId: 'public-direct-agent-run',
      store: prompttrail.memoryStore(),
    };
    const options: AgentExecuteOptions = {
      context: { userId: 'U1' },
      signal: controller.signal,
      durable,
    };
    const session = await prompttrail.Agent.user('hello').execute(options);

    expect(session.getLastMessage()?.content).toBe('hello');
  });

  it('types direct agent execution input option', async () => {
    const session = await prompttrail.Agent.create()
      .assistant('reply')
      .execute({ input: 'hello from options' });

    expect(session.messages.map((message) => message.content)).toEqual([
      'hello from options',
      'reply',
    ]);
  });

  it('exports final agent graph authoring helpers', () => {
    const options: AgentGoalOptions = {
      interaction: 'required',
      maxAttempts: 2,
      isSatisfied: ({ attempt }) => attempt > 0,
    };

    expect(prompttrail).toHaveProperty('AgentTurnGraphBuilder');
    expect(options.interaction).toBe('required');
  });

  it('does not expose Scenario as a public authoring API', () => {
    expect(prompttrail).not.toHaveProperty('Scenario');
    expect(prompttrail).not.toHaveProperty('Scenarios');
    expect(prompttrail).not.toHaveProperty('StepTemplates');
  });

  it('does not expose durable agent classes as public authoring APIs', () => {
    expect(prompttrail).not.toHaveProperty('DurableAgent');
    expect(prompttrail).not.toHaveProperty('DurableTurnBuilder');
    expect(prompttrail).not.toHaveProperty('MemoryDurableRuntime');
  });

  it('types observer delivery binding helpers', async () => {
    const deliveryBindingStore: ObserverDeliveryBindingStore = {
      claim() {
        return true;
      },
      complete() {},
      delete() {},
    };
    const options: AgentExecutionOptions = {
      observerDeliveryBindings: { deliveryBindingStore },
    };
    const observer = prompttrail.Observer.create({
      name: 'progress',
      async handle(event, context) {
        await context.deliveryBindings?.checkWrite(
          event.idempotencyKey ?? event.id,
          () => ({ platformId: 'message-1' }),
        );
      },
    });

    expect(observer.name).toBe('progress');
    expect(options.observerDeliveryBindings?.deliveryBindingStore).toBe(
      deliveryBindingStore,
    );
  });

  it('types durable boundary memo sugar helpers', async () => {
    const boundary: ExecutionDurableBoundary = {
      async memo(_name, fn) {
        return fn();
      },
      async now() {
        return 1_000;
      },
      async randomId() {
        return 'id-1';
      },
      async activity(_name, _options, fn) {
        return fn();
      },
    };

    await expect(boundary.now('createdAt')).resolves.toBe(1_000);
    await expect(boundary.randomId('traceId')).resolves.toBe('id-1');
  });

  it('types durable event replay helpers', async () => {
    const events: ExecutionEvent[] = [];
    const app = prompttrail.PromptTrail.app({
      agents: {
        assistant: prompttrail.agent('assistant').assistant('reply', () => 'ok'),
      },
      store: prompttrail.memoryStore(),
    });

    await app.run({
      agent: 'assistant',
      runId: 'public-event-replay',
      durable: true,
    });
    const stored: readonly ExecutionEvent[] = app.events('public-event-replay');
    const replayed: readonly ExecutionEvent[] = await app.replayEvents(
      'public-event-replay',
      [
        {
          replayPolicy: 'adopt-replayed',
          handle(event) {
            events.push(event);
          },
        },
      ],
    );

    expect(stored.length).toBeGreaterThan(0);
    expect(replayed).toHaveLength(stored.length);
    expect(events.every((event) => event.replay === 'replayed')).toBe(true);
  });
});
