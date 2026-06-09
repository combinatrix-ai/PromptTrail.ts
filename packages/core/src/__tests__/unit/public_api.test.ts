import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as prompttrail from '../../index';
import type {
  AgentDirectDurableOptions,
  AgentExecuteOptions,
  AgentExecutionOptions,
  AgentGoalOptions,
  ClaudeTurnOptions,
  CodexTurnOptions,
  ExecutionDurableActivityOptions,
  ExecutionDurableBoundary,
  ExecutionEvent,
  ObserverDeliveryBindingStore,
  RuntimeAdapter,
} from '../../index';
// @ts-expect-error graph executor types are not package-root APIs.
import type { GraphExecutionOptions } from '../../index';

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

  it('types external-write tool activities with required idempotency keys', () => {
    const readTool = prompttrail.Tool.create({
      name: 'read',
      description: 'read',
      inputSchema: z.object({}),
      activity: { kind: 'external-read' },
      execute: () => 'read',
    });
    const writeTool = prompttrail.Tool.create({
      name: 'write',
      description: 'write',
      inputSchema: z.object({}),
      activity: {
        kind: 'external-write',
        idempotencyKey: 'write:tool',
        retry: { maxAttempts: 2 },
      },
      execute: () => 'write',
    });
    const missingKeyTool = prompttrail.Tool.create({
      name: 'missing',
      description: 'missing',
      inputSchema: z.object({}),
      // @ts-expect-error external-write durable tools need idempotency keys.
      activity: { kind: 'external-write' },
      execute: () => 'missing',
    });

    expect(readTool.metadata?.activity).toEqual({ kind: 'external-read' });
    expect(writeTool.metadata?.activity).toEqual({
      kind: 'external-write',
      idempotencyKey: 'write:tool',
      retry: { maxAttempts: 2 },
    });
    expect(missingKeyTool.metadata?.activity).toEqual({
      kind: 'external-write',
    });
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
      runId: 'public-direct-agent-run',
      store: prompttrail.memoryStore(),
      context: { userId: 'U1' },
      signal: controller.signal,
      durable,
      observers: [
        () => {
          // type coverage only
        },
      ],
    };
    const session = await prompttrail.Agent.create('public-direct-agent')
      .user('message', 'hello')
      .execute(options);

    expect(session.getLastMessage()?.content).toBe('hello');
  });

  it('types direct agent execution input option', async () => {
    const session = await prompttrail.Agent.quick()
      .assistant('reply')
      .execute({ input: 'hello from options' });

    expect(session.messages.map((message) => message.content)).toEqual([
      'hello from options',
      'reply',
    ]);
  });

  it('rejects positional Agent.execute arguments at runtime', async () => {
    const agent = prompttrail.Agent.quick().user('hello');

    await expect(
      (
        agent.execute as unknown as (
          session: prompttrail.Session,
        ) => Promise<prompttrail.Session>
      )(prompttrail.Session.create()),
    ).rejects.toThrow(/single options object/);
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

  it('keeps graph execution internals out of the package root', () => {
    expect(prompttrail).toHaveProperty('createAgentGraph');
    expect(prompttrail).toHaveProperty('createAgentGraphManifest');
    expect(prompttrail).not.toHaveProperty('executeAgentGraph');
    expect(prompttrail).not.toHaveProperty('GraphExecutionSuspended');
  });

  it('keeps provider turn adapter internals out of the package root', () => {
    const codexOptions: CodexTurnOptions = {
      transport: { kind: 'websocket', url: 'ws://127.0.0.1:8390' },
    };
    const claudeOptions: ClaudeTurnOptions = {
      sessionId: 'new',
    };

    expect(codexOptions.transport?.kind).toBe('websocket');
    expect(claudeOptions.sessionId).toBe('new');
    expect(prompttrail).not.toHaveProperty('CodexAppServerHttpClient');
    expect(prompttrail).not.toHaveProperty('createCodexAppServerHttpClient');
    expect(prompttrail).not.toHaveProperty('buildClaudeAgentQueryParams');
    expect(prompttrail).not.toHaveProperty('createDefaultClaudeAgentClient');
  });

  it('keeps runtime host internals out of the package root', () => {
    const adapter: RuntimeAdapter = { name: 'test-adapter' };

    expect(adapter.name).toBe('test-adapter');
    expect(prompttrail).not.toHaveProperty('server');
    expect(prompttrail).not.toHaveProperty('RuntimeServer');
    expect(prompttrail).not.toHaveProperty('dispatchRuntimeBindingEvent');
    expect(prompttrail).not.toHaveProperty('AssistantDeliveryTracker');
    expect(prompttrail).not.toHaveProperty('mockRuntimeFixture');
    expect(prompttrail).not.toHaveProperty('mockDiscord');
    expect(prompttrail.PromptTrail).toHaveProperty('server');
  });

  it('does not expose low-level template authoring classes from the package root', () => {
    expect(prompttrail).not.toHaveProperty('TemplateBase');
    expect(prompttrail).not.toHaveProperty('Composite');
    expect(prompttrail).not.toHaveProperty('System');
    expect(prompttrail).not.toHaveProperty('User');
    expect(prompttrail).not.toHaveProperty('Assistant');
    expect(prompttrail).not.toHaveProperty('Sequence');
    expect(prompttrail).not.toHaveProperty('Loop');
    expect(prompttrail).not.toHaveProperty('Subroutine');
    expect(prompttrail).not.toHaveProperty('Conditional');
    expect(prompttrail).not.toHaveProperty('Transform');
    expect(prompttrail).not.toHaveProperty('GenerateMessages');
    expect(prompttrail).not.toHaveProperty('CodexTurn');
    expect(prompttrail).not.toHaveProperty('ClaudeTurn');
  });

  it('does not expose static content-first Agent factories', () => {
    const Agent = prompttrail.Agent as unknown as Record<string, unknown>;

    expect(Agent).not.toHaveProperty('system');
    expect(Agent).not.toHaveProperty('user');
    expect(Agent).not.toHaveProperty('assistant');
    expect(prompttrail.Agent.quick).toBeTypeOf('function');
  });

  it('does not expose Scenario as a public authoring API', () => {
    expect(prompttrail).not.toHaveProperty('Scenario');
    expect(prompttrail).not.toHaveProperty('Scenarios');
    expect(prompttrail).not.toHaveProperty('StepTemplates');
  });

  it('does not expose durable agent classes as public authoring APIs', () => {
    expect(prompttrail).not.toHaveProperty('agent');
    expect(prompttrail).not.toHaveProperty('app');
    expect(prompttrail).not.toHaveProperty('manualSource');
    expect(prompttrail).not.toHaveProperty('DurableAgent');
    expect(prompttrail).not.toHaveProperty('DurableTurnBuilder');
    expect(prompttrail).not.toHaveProperty('DurableTool');
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
        assistant: prompttrail.Agent.create('assistant').assistant(
          'reply',
          () => 'ok',
        ),
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

  it('exposes runtime bundle creation as explicit IR API', () => {
    expect(prompttrail.PromptTrail).not.toHaveProperty('bundle');
    expect(prompttrail.PromptTrail).toHaveProperty('runtimeBundle');
  });
});
