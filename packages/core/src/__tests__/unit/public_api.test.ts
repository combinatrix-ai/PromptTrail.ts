import { describe, expect, it } from 'vitest';
import * as prompttrail from '../../index';
import type {
  AgentExecutionOptions,
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
    const options: AgentExecutionOptions = {
      context: { userId: 'U1' },
      signal: controller.signal,
    };
    const session = await prompttrail.Agent.user('hello').execute(
      undefined,
      options,
    );

    expect(session.getLastMessage()?.content).toBe('hello');
  });
});
