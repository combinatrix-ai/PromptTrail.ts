import { describe, expect, it } from 'vitest';
import * as prompttrail from '../../index';
import type {
  AgentDirectDurableOptions,
  AgentExecutionOptions,
  DurableTool,
  ExecutionDurableActivityOptions,
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
      activity: { kind: 'external-write', idempotencyKey: 'write:tool' },
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
    const options: AgentExecutionOptions = {
      context: { userId: 'U1' },
      signal: controller.signal,
      durable,
    };
    const session = await prompttrail.Agent.user('hello').execute(
      undefined,
      options,
    );

    expect(session.getLastMessage()?.content).toBe('hello');
  });

  it('types observer delivery binding helpers', async () => {
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
  });
});
