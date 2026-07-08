import { describe, expect, it } from 'vitest';
import {
  Agent,
  buildCassette,
  buildGoldenOutcome,
  MemoryRunStore,
  PromptTrail,
  Source,
} from '@prompttrail/core';
import type { StoredRun } from '@prompttrail/core';
import { deserializeRunFixture, serializeRunFixture } from '../fixtures';

function serviceAgent(reply = 'hello') {
  return Agent.create('svc')
    .inbox('inbound')
    .assistant('reply', Source.llm().mock().mockResponse({ content: reply }));
}

async function recordRun(): Promise<StoredRun<any>> {
  const store = new MemoryRunStore();
  const app = PromptTrail.app({
    agents: { svc: serviceAgent() },
    store,
    recording: 'full',
  });
  await app.run({ agent: 'svc', runId: 'r1', input: 'hi', checkpoint: true });
  const run = await store.get('r1');
  if (!run) throw new Error('run not stored');
  return run;
}

describe('run fixture serialization', () => {
  it('round-trips a recorded run minus its agent, and stays replayable', async () => {
    const run = await recordRun();
    const json = serializeRunFixture(run);

    // Serializable JSON, no agent leaked.
    const parsed = JSON.parse(json);
    expect(parsed.agent).toBeUndefined();
    expect(parsed.agentName).toBe('svc');
    expect(Array.isArray(parsed.recording)).toBe(true);
    expect(parsed.recording.length).toBeGreaterThan(0);

    const fixture = deserializeRunFixture(json);
    expect(fixture.agent).toBeUndefined();

    // The reconstructed fixture drives the same cassette + golden the original
    // did — the agent is re-supplied separately at verify time.
    const withAgent = { ...fixture, agent: serviceAgent() as any };
    const cassette = buildCassette(withAgent);
    expect(cassette.model.length).toBeGreaterThan(0);
    const golden = buildGoldenOutcome(withAgent);
    expect(golden.finalReply.map((m) => m.content).join('')).toContain('hello');
  });
});
