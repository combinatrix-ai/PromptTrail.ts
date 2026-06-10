import { describe, expect, it } from 'vitest';
import { PromptTrail, manualSource, memoryStore } from '../../durable';
import type { DurableRunStore, StoredRun } from '../../durable';
import { Source } from '../../source';
import { Agent } from '../../templates';

class TrackingRunStore implements DurableRunStore {
  readonly runs = new Map<string, StoredRun<any, any>>();
  readonly snapshots: Array<{
    runId: string;
    status: StoredRun<any, any>['status'];
    onceRunEntries: number;
    resultMessages?: number;
    outbox: number;
  }> = [];

  get(runId: string): StoredRun<any, any> | undefined {
    return this.runs.get(runId);
  }

  set(runId: string, run: StoredRun<any, any>): void {
    this.runs.set(runId, run);
    this.snapshots.push({
      runId,
      status: run.status,
      onceRunEntries: run.once.run.size,
      resultMessages: run.result?.messages.length,
      outbox: run.outbox.length,
    });
  }

  has(runId: string): boolean {
    return this.runs.has(runId);
  }

  delete(runId: string): void {
    this.runs.delete(runId);
  }

  entries(): Iterable<[string, StoredRun<any, any>]> {
    return this.runs.entries();
  }
}

describe('checkpoint app runtime', () => {
  it('can run graph Agents through PromptTrail.app ephemerally', async () => {
    const events: string[] = [];
    const assistant = Agent.create('graphAssistant').turn('main', (turn) =>
      turn.inbox('inbound').assistant('reply', Source.literal('ok')),
    );
    const app = PromptTrail.app({
      agents: { assistant },
      observers: [
        {
          handle(event) {
            events.push(
              `${event.seq}:${event.type}:${event.conversationId}:${event.source}`,
            );
          },
        },
      ],
    });

    const result = await app.run({
      agent: 'assistant',
      input: 'hello',
    });

    expect(result.status).toBe('done');
    expect(result.runId).toBe('graphAssistant-1');
    expect(result.session.messages.map((message) => message.content)).toEqual([
      'hello',
      'ok',
    ]);
    expect(events).toEqual([
      '0:run.started:graphAssistant-1:app',
      '1:run.completed:graphAssistant-1:app',
    ]);
  });

  it('stores checkpoint app runs for graph Agents', async () => {
    const store = memoryStore();
    const events: string[] = [];
    const assistant = Agent.create('graphAssistant').assistant(
      'reply',
      Source.literal('ok'),
    );
    const app = PromptTrail.app({
      store,
      agents: { assistant },
      observers: [
        {
          handle(event) {
            events.push(`${event.seq}:${event.type}:${event.source}`);
          },
        },
      ],
    });

    const result = await app.run({
      agent: 'assistant',
      checkpoint: true,
    });

    expect(result.status).toBe('done');
    expect(result.runId).toBe('graphAssistant-1');
    expect(result.session.getLastMessage()?.content).toBe('ok');
    expect(store.get(result.runId)).toMatchObject({
      status: 'done',
      graphCursor: 0,
    });
    expect(events).toEqual([
      '0:run.started:graph',
      '1:model.started:model',
      '2:model.completed:model',
      '3:run.completed:graph',
    ]);
  });

  it('persists once memo entries and assistant delivery outbox before completion', async () => {
    const store = new TrackingRunStore();
    const assistant = Agent.create('persisted')
      .tool('write', {
        kind: 'tool',
        name: 'write',
        description: 'Write.',
        inputSchema: {
          parse: (input: unknown) => input,
        } as any,
        activity: { kind: 'external-write', idempotencyKey: 'write:1' },
        execute: () => 'written',
      })
      .assistant('reply', () => ({
        content: 'need write',
        toolCalls: [{ id: 'call-1', name: 'write', arguments: {} }],
      }))
      .turn('tools', (turn) => turn.tools('run'));
    const app = PromptTrail.app({
      agents: { persisted: assistant },
      store,
    });

    await app.run({
      agent: 'persisted',
      runId: 'run-persist-commits',
      checkpoint: true,
      context: {
        delivery: {
          platform: 'discord',
          channel: 'C_general',
        },
      },
    });

    expect(store.snapshots).toContainEqual(
      expect.objectContaining({
        runId: 'run-persist-commits',
        status: 'open',
        onceRunEntries: 1,
      }),
    );
    expect(app.assistantDeliveryOutbox('run-persist-commits')).toHaveLength(1);
  });

  it('does not duplicate graph goal prompts when resuming checkpoint app runs', async () => {
    const assistant = Agent.create('graphAssistant').goal(
      'collect',
      'Collect input',
      {
        interaction: 'required',
        model: Source.literal('question?'),
      },
    );
    const app = PromptTrail.app({
      store: memoryStore(),
      agents: { assistant },
    });

    const first = await app.run({
      agent: 'assistant',
      runId: 'run-graph-goal',
      checkpoint: true,
    });
    const second = await app.resume('run-graph-goal');

    expect(first.status).toBe('suspended');
    expect(second.status).toBe('suspended');
    expect(
      second.session.messages.filter(
        (message) => message.content === 'Collect input',
      ),
    ).toHaveLength(1);
  });

  it('uses app checkpoint defaults for send and source-created runs', async () => {
    const defaultStore = memoryStore();
    const disabledStore = memoryStore();
    const source = manualSource();
    const assistant = Agent.create('send-default').turn('main', (turn) =>
      turn.inbox('inbound').assistant('reply', () => 'hello'),
    );
    const durableApp = PromptTrail.app({
      agents: { assistant },
      store: defaultStore,
      defaults: {
        checkpoint: true,
      },
    });
    const ephemeralApp = PromptTrail.app({
      agents: { assistant },
      sources: { manual: source },
      store: disabledStore,
    });

    await durableApp.send({
      agent: 'assistant',
      runId: 'run-send-default-durable',
      input: 'hello',
    });
    await ephemeralApp.start();
    await source.emit({
      source: 'manual',
      agent: 'assistant',
      runId: 'run-source-default-ephemeral',
      input: 'hello',
    });

    expect(defaultStore.get('run-send-default-durable')).toBeDefined();
    expect(disabledStore.get('run-source-default-ephemeral')).toBeUndefined();
  });

  it('emits checkpoint app lifecycle observer events across resume', async () => {
    const events: string[] = [];
    const assistant = Agent.create('observed')
      .assistant('reply', () => 'hello')
      .turn('wait', (turn) => turn.awaitInput('input'));
    const app = PromptTrail.app({
      agents: { observed: assistant },
      observers: [
        (event) => {
          if (!event.type.startsWith('run.')) {
            return;
          }
          events.push(
            `${event.seq}:${event.type}:${event.stepId ?? '-'}:${event.sessionVersion ?? '-'}`,
          );
        },
      ],
      store: memoryStore(),
    });

    const first = await app.run({
      agent: 'observed',
      runId: 'run-observed',
      checkpoint: true,
    });
    const second = await app.send({
      runId: 'run-observed',
      input: 'continue',
    });

    expect(first.status).toBe('suspended');
    expect(second.status).toBe('done');
    expect(events).toEqual([
      '0:run.started:-:0',
      '3:run.suspended:observed/wait/input:1',
      '4:run.started:-:1',
      '5:run.completed:-:2',
    ]);
  });

  it('routes events from app sources into checkpoint runs', async () => {
    const source = manualSource();
    const assistant = Agent.create('assistant')
      .system('system', 'System')
      .turn('main', (turn) =>
        turn
          .inbox('inbox')
          .assistant(
            'reply',
            (session) => `seen:${session.getMessagesByType('user').length}`,
          )
          .awaitInput('next'),
      );
    const app = PromptTrail.app({
      agents: { assistant },
      sources: { manual: source },
      store: memoryStore(),
    });

    await app.start();
    await source.emit({
      source: 'manual',
      agent: 'assistant',
      runId: 'run-6',
      input: 'hello',
      checkpoint: true,
    });

    const result = await app.resume('run-6');

    expect(result.status).toBe('suspended');
    expect(result.session.messages.map((message) => message.content)).toEqual([
      'System',
      'hello',
      'seen:1',
    ]);
  });
});
