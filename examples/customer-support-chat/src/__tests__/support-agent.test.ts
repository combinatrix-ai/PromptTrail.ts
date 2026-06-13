import { describe, expect, it, beforeEach } from 'vitest';
import {
  AgentGraphVersionError,
  Session,
  Source,
  type ModelOutput,
} from '@prompttrail/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  conversationIdFor,
  createReturnsAgent,
  createSupportAgents,
  createSupportRuntime,
  getRefundRecords,
  getReturnTransformInspections,
  listStoredUsers,
  readConversation,
  resetSupportDemoRecords,
} from '../lib/support-agent';
import { getInspectorPayload } from '../lib/inspector';
import { SqliteRunStore } from '../lib/sqlite-store';
import { readSupportAgentSourceSnippets } from '../lib/source-snippets';

const returnChoicesPayload = {
  reply: 'Which order should I return?',
  choices: [
    { id: 'ORD-1001', label: 'ORD-1001 - Trail Runner Backpack' },
    { id: 'ORD-1002', label: 'ORD-1002 - Insulated Camp Mug' },
    { id: 'ORD-1003', label: 'ORD-1003 - Warranty Replacement Strap' },
  ],
};

function returnChoicesSource() {
  return new (class extends Source<ModelOutput> {
    async getContent(): Promise<ModelOutput> {
      return {
        content: returnChoicesPayload.reply,
        structuredOutput: returnChoicesPayload,
      };
    }
  })();
}

function expectSubsequence<T>(actual: T[], expected: T[]): void {
  let cursor = 0;
  for (const item of actual) {
    if (Object.is(item, expected[cursor])) {
      cursor++;
    }
    if (cursor === expected.length) {
      return;
    }
  }
  expect(actual).toEqual(expect.arrayContaining(expected));
  expect(cursor).toBe(expected.length);
}

describe('customer support chat runtime', () => {
  beforeEach(() => {
    resetSupportDemoRecords();
  });

  it('accumulates two turns across separate handleMessage calls', async () => {
    const source = Source.llm()
      .mock()
      .mockCallback((session) => {
        const userTurns = session.messages.filter(
          (message) => message.type === 'user',
        ).length;
        return { content: `Support reply ${userTurns}` };
      });
    const runtime = createSupportRuntime(source);

    const first = await runtime.handleMessage('conversation-a', 'Hello');
    const second = await runtime.handleMessage(
      'conversation-a',
      'Where is ORD-1001?',
    );

    expect(first.messages.map((message) => message.content)).toEqual([
      'Hello',
      'Support reply 1',
    ]);
    expect(second.messages.map((message) => message.content)).toEqual([
      'Hello',
      'Support reply 1',
      'Where is ORD-1001?',
      'Support reply 2',
    ]);
  });

  it('executes lookupOrder from model toolCalls before the final reply', async () => {
    const source = Source.llm()
      .mock()
      .mockCallback((session) => {
        const toolResult = session.messages.find(
          (message) => message.type === 'tool_result',
        );

        if (toolResult) {
          return { content: `I found the order: ${toolResult.content}` };
        }

        return {
          content: 'I will check that order.',
          toolCalls: [
            {
              id: 'lookup-1',
              name: 'lookupOrder',
              arguments: { orderId: 'ORD-1001' },
            },
          ],
        };
      });
    const runtime = createSupportRuntime(source);

    const result = await runtime.handleMessage(
      'conversation-lookup',
      'Where is ORD-1001?',
    );

    expect(result.messages.map((message) => message.type)).toEqual([
      'user',
      'assistant',
      'tool_result',
      'assistant',
    ]);
    expect(result.messages[2]?.content).toContain('Trail Runner Backpack');
    expect(result.messages.at(-1)?.content).toContain('I found the order');
  });

  it('passes the resolved refund idempotency key to issueRefund', async () => {
    const source = Source.llm()
      .mock()
      .mockCallback((session) => {
        const toolResult = session.messages.find(
          (message) => message.type === 'tool_result',
        );

        if (toolResult) {
          return { content: 'Refund issued.' };
        }

        return {
          content: 'I will issue the refund.',
          toolCalls: [
            {
              id: 'refund-1',
              name: 'issueRefund',
              arguments: {
                orderId: 'ORD-1002',
                reason: 'Customer requested cancellation.',
              },
            },
          ],
        };
      });
    const runtime = createSupportRuntime(source);

    await runtime.handleMessage('conversation-refund', 'Refund ORD-1002');

    expect(getRefundRecords()).toEqual([
      {
        orderId: 'ORD-1002',
        reason: 'Customer requested cancellation.',
        idempotencyKey: 'refund:ORD-1002',
      },
    ]);
  });

  it('suspends the return wizard with projected order choices', async () => {
    const runtime = createSupportRuntime(
      Source.llm().mock(),
      returnChoicesSource(),
    );

    const result = await runtime.handleMessage(
      'returns-turn-1',
      'I need to return an order.',
      'returns',
    );

    expect(result.status).toBe('suspended');
    expect(result.awaiting).toBe('returns/order-choice');
    expect(result.messages.at(-1)).toMatchObject({
      type: 'assistant',
      content: returnChoicesPayload.reply,
      structuredContent: returnChoicesPayload,
    });
  });

  it('issues a keyed refund once for an eligible return choice', async () => {
    const runtime = createSupportRuntime(
      Source.llm().mock(),
      returnChoicesSource(),
    );

    await runtime.handleMessage(
      'returns-eligible',
      'The mug is not needed.',
      'returns',
    );
    const result = await runtime.handleMessage(
      'returns-eligible',
      'ORD-1002',
      'returns',
    );

    expect(result.status).toBe('done');
    expect(getRefundRecords()).toEqual([
      {
        orderId: 'ORD-1002',
        reason: 'The mug is not needed.',
        idempotencyKey: 'refund:ORD-1002',
      },
    ]);
    expect(getReturnTransformInspections()).toEqual([
      { type: 'user', content: 'ORD-1002' },
    ]);
    expect(result.messages.at(-1)?.content).toContain('RF-ORD-1002');
  });

  it('denies an ineligible return choice without recording a refund', async () => {
    const runtime = createSupportRuntime(
      Source.llm().mock(),
      returnChoicesSource(),
    );

    await runtime.handleMessage(
      'returns-ineligible',
      'The replacement is wrong.',
      'returns',
    );
    const result = await runtime.handleMessage(
      'returns-ineligible',
      'ORD-1003',
      'returns',
    );

    expect(result.status).toBe('done');
    expect(getRefundRecords()).toEqual([]);
    expect(result.messages.at(-1)?.content).toBe(
      'ORD-1003 is not eligible for a refund.',
    );
  });

  it('journals durable writes for a suspended and resumed return wizard', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'prompttrail-support-'));
    const dbPath = join(tempDir, 'support.db');
    const returnsSource = returnChoicesSource();
    const agents = createSupportAgents(Source.llm().mock(), returnsSource);
    const runId = 'returns-journal';

    try {
      const durableStore = new SqliteRunStore({
        path: dbPath,
        agents,
      });
      const runtime = createSupportRuntime(
        Source.llm().mock(),
        returnsSource,
        durableStore,
      );

      await runtime.handleMessage(
        runId,
        'The backpack is too small.',
        'returns',
      );
      await runtime.handleMessage(runId, 'ORD-1001', 'returns');

      const writes = durableStore.writesFor(runId);
      expectSubsequence(
        writes.map((write) => write.op),
        [
          'appendInbox',
          'appendSessionDelta',
          'appendInbox',
          'recordOnce',
          'appendSessionDelta',
          'patch',
        ],
      );
      expect(
        writes.some(
          (write) =>
            write.op === 'patch' && write.summary.includes('status=done'),
        ),
      ).toBe(true);
      expect(writes.map((write) => write.summary).join('\n')).toContain(
        'INSERT session_deltas',
      );
      durableStore.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('promotes legacy attrs toolCallId while hydrating SQLite deltas', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'prompttrail-support-'));
    const dbPath = join(tempDir, 'support.db');
    const agents = createSupportAgents(
      Source.llm().mock(),
      returnChoicesSource(),
    );
    const agent = agents.support;
    const runId = 'support:legacy-tool';

    try {
      const firstStore = new SqliteRunStore({
        path: dbPath,
        agents,
      });
      await firstStore.create(runId, {
        agent,
        agentName: 'support',
        initial: Session.create(),
        status: 'open',
        once: { run: new Map(), conversation: new Map() },
        outbox: [],
        inbox: [],
      });
      await firstStore.appendSessionDelta(runId, {
        fromVersion: 0,
        toVersion: 1,
        appendedMessages: [
          {
            type: 'tool_result',
            content: 'done',
            attrs: { toolCallId: 'legacy-call', provider: 'legacy' },
          },
        ],
      });
      firstStore.close();

      const secondStore = new SqliteRunStore({
        path: dbPath,
        agents,
      });
      const message = secondStore.get(runId)?.result?.messages[0];
      expect(message).toMatchObject({
        type: 'tool_result',
        content: 'done',
        toolCallId: 'legacy-call',
        attrs: { toolCallId: 'legacy-call', provider: 'legacy' },
      });
      secondStore.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('extracts non-empty source snippets from marked agent regions', () => {
    const supportSnippets = readSupportAgentSourceSnippets('support');
    const returnsSnippets = readSupportAgentSourceSnippets('returns');

    expect(supportSnippets.agent).toContain('Agent.create');
    expect(returnsSnippets.agent).toContain('Agent.create');
    expect(supportSnippets.tools).toContain('Tool.create');
  });

  it('builds inspector payloads for existing and missing conversations', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'prompttrail-support-'));
    const dbPath = join(tempDir, 'support.db');
    const supportSource = Source.llm()
      .mock()
      .mockCallback(() => ({ content: 'Support reply.' }));
    const agents = createSupportAgents(supportSource, returnChoicesSource());
    const runId = 'support:inspector';

    try {
      const durableStore = new SqliteRunStore({
        path: dbPath,
        agents,
      });
      const runtime = createSupportRuntime(
        supportSource,
        returnChoicesSource(),
        durableStore,
      );

      await runtime.handleMessage(runId, 'Hello', 'support');

      const existing = getInspectorPayload({
        conversationId: runId,
        agentName: 'support',
        durableStore,
        agentRegistry: agents,
      });
      expect(existing.run).toMatchObject({
        runId,
        agentName: 'support',
        status: 'done',
        awaiting: null,
        sessionVersion: expect.any(Number),
        messageCount: 3,
      });
      expect(existing.graph.hash).toEqual(expect.any(String));
      expect(existing.graph.nodes.length).toBeGreaterThan(0);
      expect(existing.persistence.counts.runs).toBe(1);
      expect(existing.persistence.writes.length).toBeGreaterThan(0);

      const missing = getInspectorPayload({
        conversationId: 'support:missing',
        agentName: 'support',
        durableStore,
        agentRegistry: agents,
      });
      expect(missing.run).toEqual({
        runId: null,
        agentName: null,
        status: null,
        awaiting: null,
        sessionVersion: null,
        messageCount: null,
      });
      expect(missing.persistence.counts).toEqual({
        runs: 0,
        session_deltas: 0,
        once_memo: 0,
        inbox: 0,
        outbox: 0,
      });
      durableStore.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('round-trips per-user durable runs through SQLite restart', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'prompttrail-support-'));
    const dbPath = join(tempDir, 'support.db');
    const supportSource = Source.llm()
      .mock()
      .mockCallback((session) => {
        const userTurns = session.messages.filter(
          (message) => message.type === 'user',
        ).length;
        return { content: `Support reply ${userTurns}` };
      });
    const returnsSource = returnChoicesSource();
    const user = 'mina-tanaka';
    const supportRunId = conversationIdFor('support', user);
    const returnsRunId = conversationIdFor('returns', user);

    try {
      const firstAgents = createSupportAgents(supportSource, returnsSource);
      const firstStore = new SqliteRunStore({
        path: dbPath,
        agents: firstAgents,
      });
      const firstRuntime = createSupportRuntime(
        supportSource,
        returnsSource,
        firstStore,
      );

      await firstRuntime.handleMessage(supportRunId, 'Hello', 'support');
      await firstRuntime.handleMessage(
        supportRunId,
        'Where is ORD-1001?',
        'support',
      );
      const suspended = await firstRuntime.handleMessage(
        returnsRunId,
        'The backpack does not fit.',
        'returns',
      );

      const supportBefore = readConversation(supportRunId, firstStore);
      const returnsBefore = readConversation(returnsRunId, firstStore);
      expect(suspended.status).toBe('suspended');
      expect(returnsBefore.messages.at(-1)?.structuredContent).toEqual(
        returnChoicesPayload,
      );
      expect(listStoredUsers(firstStore)).toEqual([user]);
      firstStore.close();

      const secondAgents = createSupportAgents(supportSource, returnsSource);
      const secondStore = new SqliteRunStore({
        path: dbPath,
        agents: secondAgents,
      });
      const secondRuntime = createSupportRuntime(
        supportSource,
        returnsSource,
        secondStore,
      );

      expect(readConversation(supportRunId, secondStore)).toEqual(
        supportBefore,
      );
      expect(readConversation(returnsRunId, secondStore)).toEqual(
        returnsBefore,
      );

      const resumed = await secondRuntime.handleMessage(
        returnsRunId,
        'ORD-1001',
        'returns',
      );
      expect(resumed.status).toBe('done');
      expect(getRefundRecords()).toEqual([
        {
          orderId: 'ORD-1001',
          reason: 'The backpack does not fit.',
          idempotencyKey: 'refund:ORD-1001',
        },
      ]);

      await secondRuntime.handleMessage(returnsRunId, 'ORD-1001', 'returns');
      expect(getRefundRecords()).toHaveLength(1);

      await expect(
        secondRuntime.app.resume(returnsRunId),
      ).resolves.toMatchObject({
        runId: returnsRunId,
      });
      secondStore.close();

      const tamperedAgents = createSupportAgents(supportSource, returnsSource);
      tamperedAgents.returns = createReturnsAgent(returnsSource).system(
        'tampered-policy',
        'This edited policy intentionally changes the durable graph hash.',
      );
      const tamperedStore = new SqliteRunStore({
        path: dbPath,
        agents: tamperedAgents,
      });
      const tamperedRuntime = createSupportRuntime(
        supportSource,
        returnsSource,
        tamperedStore,
      );

      await expect(tamperedRuntime.app.resume(returnsRunId)).rejects.toThrow(
        AgentGraphVersionError,
      );
      tamperedStore.close();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
