import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as prompttrail from '../../index';
import type {
  AgentCheckpointOption,
  AgentExecuteOptionsWithCheckpoint,
  AgentExecutionOptions,
  AgentGoalOptions,
  ClaudeTurnOptions,
  CodexTurnOptions,
  ExecutionDurableBoundary,
  ExecutionEffectDeclaration,
  ObserverDeliveryBindingStore,
} from '../../index';
import type { RuntimeAdapter } from '../../runtime_server';
// @ts-expect-error graph executor types are not package-root APIs.
import type { GraphExecutionOptions } from '../../index';
type _GraphExecutionOptionsHidden = GraphExecutionOptions;
// @ts-expect-error runtime host adapter types live under ./runtime_server.
import type { RuntimeAdapter as RootRuntimeAdapter } from '../../index';
type _RuntimeAdapterHidden = RootRuntimeAdapter;

describe('public API surface', () => {
  it('has an explicit curated runtime value surface', () => {
    expect(Object.keys(prompttrail).sort()).toEqual([
      'Agent',
      'AgentGraphValidationError',
      'AgentGraphVersionError',
      'AllValidator',
      'AnyValidator',
      'BaseValidator',
      'CLISource',
      'CallbackSource',
      'CompositeValidator',
      'CustomValidator',
      'DEFAULT_PROVIDER_TURN_RESTART_NOTICE',
      'DELETE_VALUE',
      'Delivery',
      'Hook',
      'JsonValidator',
      'KeywordValidator',
      'LengthValidator',
      'ListSource',
      'LiteralSource',
      'LlmSource',
      'MemoryRunStore',
      'Message',
      'Middleware',
      'ModelSource',
      'Observer',
      'Parallel',
      'PromptTrail',
      'ProviderTurnUnresumableError',
      'RandomSource',
      'RegexMatchValidator',
      'RegexNoMatchValidator',
      'SchemaValidator',
      'Session',
      'SessionBuilder',
      'Source',
      'StringSource',
      'Structured',
      'Tool',
      'Validation',
      'assertProviderFileReferenceUsable',
      'assertProviderFileReferenceUsableForProvider',
      'createAgentGraph',
      'createAgentGraphManifest',
      'createProviderFileContentPart',
      'createSession',
      'isProviderFileReferenceExpired',
      'manifestConfigDigest',
      'memoryStore',
      'on',
      'validateAgentGraph',
    ]);
  });

  it('does not re-export ai-sdk tool helpers from core', () => {
    expect(prompttrail).not.toHaveProperty('tool');
    expect(prompttrail).not.toHaveProperty('aiSdkToolToPromptTrailTool');
    expect(prompttrail).not.toHaveProperty('promptTrailToolToAiSdkTool');
    expect(prompttrail).not.toHaveProperty('toAiSdkToolSet');
    expect(prompttrail).not.toHaveProperty('executePromptTrailTool');
    expect(prompttrail).not.toHaveProperty('toolResultToCallToolResult');
    expect(prompttrail).toHaveProperty('Tool');
  });

  it('does not expose root providerOptions fluent configuration', () => {
    expect(prompttrail.Source.llm()).not.toHaveProperty('providerOptions');
  });

  it('types binary effect declarations', () => {
    const repeatable: ExecutionEffectDeclaration = {
      repeatable: true,
      kind: 'external-read',
    };
    const keyed: ExecutionEffectDeclaration = {
      idempotencyKey: 'write:1',
      kind: 'external-write',
    };
    const functionKey: ExecutionEffectDeclaration = {
      idempotencyKey: (input) => `write:${String(input)}`,
    };
    // @ts-expect-error declared effects must be keyed or repeatable.
    const missingDeclaration: ExecutionEffectDeclaration = {
      kind: 'external-write',
    };

    expect(repeatable.repeatable).toBe(true);
    expect(keyed.idempotencyKey).toBe('write:1');
    expect(typeof functionKey.idempotencyKey).toBe('function');
    if (typeof functionKey.idempotencyKey === 'function') {
      expect(functionKey.idempotencyKey('1')).toBe('write:1');
    }
    expect(missingDeclaration.kind).toBe('external-write');
  });

  it('types binary tool effect declarations', () => {
    const readTool = prompttrail.Tool.create({
      name: 'read',
      description: 'read',
      inputSchema: z.object({}),
      effect: { repeatable: true },
      execute: () => 'read',
    });
    const writeTool = prompttrail.Tool.create({
      name: 'write',
      description: 'write',
      inputSchema: z.object({}),
      effect: {
        idempotencyKey: 'write:tool',
        kind: 'external-write',
        retry: { maxAttempts: 2 },
      },
      execute: () => 'write',
    });
    const missingKeyTool = prompttrail.Tool.create({
      name: 'missing',
      description: 'missing',
      inputSchema: z.object({}),
      // @ts-expect-error declared effects must be keyed or repeatable.
      effect: { kind: 'external-write' },
      execute: () => 'missing',
    });

    expect(readTool.metadata?.effect).toEqual({ repeatable: true });
    expect(writeTool.metadata?.effect).toEqual({
      idempotencyKey: 'write:tool',
      kind: 'external-write',
      retry: { maxAttempts: 2 },
    });
    expect(missingKeyTool.metadata?.effect).toEqual({
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
    const checkpoint: AgentCheckpointOption = prompttrail.memoryStore();
    const options: AgentExecuteOptionsWithCheckpoint = {
      runId: 'public-direct-agent-run',
      checkpoint,
      context: { userId: 'U1' },
      signal: controller.signal,
      observers: [
        () => {
          // type coverage only
        },
      ],
    };
    const result = await prompttrail.Agent.create('public-direct-agent')
      .user('message', 'hello')
      .execute(options);

    expect(result.status).toBe('done');
    expect(result.session.getLastMessage()?.content).toBe('hello');
  });

  it('types id-less source and function message handlers', async () => {
    const source = prompttrail.Source.callback(async () => 'from-source');
    const session = await prompttrail.Agent.create('public-idless-handlers')
      .system(source)
      .user(source)
      .assistant((current) => `reply:${current.getLastMessage()?.content}`)
      .execute();

    expect(session.messages.map((message) => message.content)).toEqual([
      'from-source',
      'from-source',
      'reply:from-source',
    ]);
  });

  it('types direct agent execution input option', async () => {
    const session = await prompttrail.Agent.create('public-api')
      .assistant('reply')
      .execute({ input: 'hello from options' });

    expect(session.messages.map((message) => message.content)).toEqual([
      'hello from options',
      'reply',
    ]);
  });

  it('rejects positional Agent.execute arguments at runtime', async () => {
    const agent = prompttrail.Agent.create('public-api').user('hello');

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
    expect(prompttrail).not.toHaveProperty('RuntimeAdapter');
    expect(prompttrail).not.toHaveProperty('dispatchRuntimeBindingEvent');
    expect(prompttrail).not.toHaveProperty('dispatchRuntimeEvent');
    expect(prompttrail).not.toHaveProperty('AssistantDeliveryTracker');
    expect(prompttrail).not.toHaveProperty('mockRuntimeFixture');
    expect(prompttrail).not.toHaveProperty('mockPlatformConnector');
    expect(prompttrail.PromptTrail).toHaveProperty('server');
  });

  it('keeps low-level interceptor runners out of the package root', () => {
    expect(prompttrail).toHaveProperty('Middleware');
    expect(prompttrail).toHaveProperty('Hook');
    expect(prompttrail).not.toHaveProperty('runExecutionPhase');
    expect(prompttrail).not.toHaveProperty('runMiddlewareWrapper');
    expect(prompttrail).not.toHaveProperty('createExecutionRuntimeState');
    expect(prompttrail).not.toHaveProperty('extendExecutionRuntimeState');
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
    expect(Agent).not.toHaveProperty('quick');
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

  it('types durable boundary once helper', async () => {
    const boundary: ExecutionDurableBoundary = {
      async once(_name, _dep, fn) {
        return fn();
      },
    };

    await expect(boundary.once('createdAt', 'dep', () => 1_000)).resolves.toBe(
      1_000,
    );
  });

  it('exposes runtime bundle creation as explicit IR API', () => {
    expect(prompttrail.PromptTrail).not.toHaveProperty('bundle');
    expect(prompttrail.PromptTrail).toHaveProperty('runtimeBundle');
  });
});
