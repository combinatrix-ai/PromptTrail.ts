import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAcceptance } from '../../acceptance';
import type { AcceptanceCase } from '../../acceptance';
import type { ReplayTrace } from '../../replay';
import type { Session } from '../../session';
import { Source } from '../../source';
import { Agent } from '../../templates';
import { Tool } from '../../tool';

/** An echo agent with no model call — the deterministic acceptance target. */
function echoAgent() {
  return Agent.create('echo')
    .inbox('in')
    .assistant(
      'reply',
      (session) => `ack: ${session.getLastMessage()?.content}`,
    );
}

function lastAssistant(session: Session): string | undefined {
  return [...session.messages].reverse().find((m) => m.type === 'assistant')
    ?.content;
}

describe('B3 acceptance mode — live model, sealed tools', () => {
  it('falls a model miss through to the REAL provider while a tool miss stays sealed', async () => {
    let sideEffectCount = 0;
    const countingTool = Tool.create({
      name: 'bump',
      description: 'Increments a counter as a side effect.',
      inputSchema: z.object({ n: z.number() }),
      effect: { idempotencyKey: 'bump:1' },
      execute: (input: { n: number }) => {
        sideEffectCount += 1;
        return `bumped:${input.n}`;
      },
    });
    // The mock LLM source stands in for the REAL provider: on a cassette miss
    // under `miss: 'live'`, the funnel runs it (not a sentinel).
    const liveModel = Source.llm({ temperature: 0 })
      .mock()
      .mockResponse({
        content: 'live-answer',
        toolCalls: [{ id: 'c1', name: 'bump', arguments: { n: 7 } }],
      });
    const agent = Agent.create('acc')
      .inbox('in')
      .tool('bump', countingTool)
      .assistant('ask', liveModel)
      .tools('run');

    let captured: { trace: ReplayTrace; session: Session } | undefined;
    const cases: AcceptanceCase[] = [
      {
        name: 'live-model-sealed-tool',
        inbox: ['hello'],
        // No modelStubs and no cassette → the model call goes live, the tool
        // call is sealed to a sentinel.
        assert: (trace, session) => {
          captured = { trace, session };
        },
      },
    ];

    const report = await runAcceptance(agent, cases);
    expect(report.ok).toBe(true);

    const { trace, session } = captured!;
    // The tool NEVER executed — side effects stay sealed even in acceptance.
    expect(sideEffectCount).toBe(0);
    // The model call fell through to the live mock and is flagged `live`.
    const modelMiss = trace.misses.find((m) => m.kind === 'model');
    expect(modelMiss).toMatchObject({ kind: 'model', live: true });
    // The tool miss is sealed — recorded WITHOUT a `live` marker.
    const toolMiss = trace.misses.find((m) => m.kind === 'tool');
    expect(toolMiss).toBeDefined();
    expect(toolMiss?.live).toBeUndefined();
    // The live model output actually reached the session.
    expect(
      session.messages.some((m) => m.content.includes('live-answer')),
    ).toBe(true);
    // The sealed tool result is the sentinel, not a real `bumped:7`.
    const toolResult = session.messages.find((m) => m.type === 'tool_result');
    expect(toolResult?.content).toContain('[replay-miss]');
  });
});

describe('B3 runAcceptance report shape', () => {
  it('reports ok:false with the failing case captured, both durations recorded', async () => {
    const cases: AcceptanceCase[] = [
      {
        name: 'passes',
        inbox: ['ping'],
        assert: (_trace, session) => {
          expect(lastAssistant(session)).toBe('ack: ping');
        },
      },
      {
        name: 'fails',
        inbox: ['ping'],
        assert: () => {
          throw new Error('intentional acceptance failure');
        },
      },
    ];

    const report = await runAcceptance(echoAgent(), cases);
    expect(report.ok).toBe(false);
    expect(report.cases).toHaveLength(2);

    const [pass, fail] = report.cases;
    expect(pass).toMatchObject({ name: 'passes', ok: true });
    expect(pass.error).toBeUndefined();
    expect(fail).toMatchObject({ name: 'fails', ok: false });
    expect(fail.error).toContain('intentional acceptance failure');
    // Both cases ran (no abort on the first failure) and are timed.
    for (const result of report.cases) {
      expect(typeof result.durationMs).toBe('number');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('does not abort the suite when an earlier case fails', async () => {
    const cases: AcceptanceCase[] = [
      {
        name: 'first-fails',
        inbox: ['x'],
        assert: () => {
          throw new Error('boom');
        },
      },
      {
        name: 'second-still-runs',
        inbox: ['ping'],
        assert: (_trace, session) => {
          expect(lastAssistant(session)).toBe('ack: ping');
        },
      },
    ];
    const report = await runAcceptance(echoAgent(), cases);
    expect(report.cases.map((c) => c.ok)).toEqual([false, true]);
  });
});

describe('B3 modelStubs sugar', () => {
  it('builds a positional cassette so the model call resolves from a stub (no live)', async () => {
    const agent = Agent.create('stubbed')
      .inbox('in')
      .assistant('reply', Source.llm({ temperature: 0 }));

    let captured: ReplayTrace | undefined;
    const cases: AcceptanceCase[] = [
      {
        name: 'stub-resolves',
        inbox: ['question'],
        modelStubs: ['stubbed-response'],
        assert: (trace, session) => {
          captured = trace;
          expect(
            session.messages.some((m) =>
              m.content.includes('stubbed-response'),
            ),
          ).toBe(true);
        },
      },
    ];

    const report = await runAcceptance(agent, cases);
    expect(report.ok).toBe(true);
    // The stub was consumed positionally — no live fall-through.
    expect(captured!.misses).toEqual([]);
    expect(captured!.modelCalls).toHaveLength(1);
    expect(captured!.modelCalls[0].hit).toBe('positional');
  });
});
