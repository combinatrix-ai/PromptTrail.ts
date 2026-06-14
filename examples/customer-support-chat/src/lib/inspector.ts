import {
  createAgentGraphManifest,
  type Agent,
  type AgentGraphNodeType,
} from '@prompttrail/core';
import { agents, store, type SupportAgentName } from './support-agent';
import {
  type SqliteRunCounts,
  type SqliteRunStore,
  type SqliteWriteJournalEntry,
} from '@prompttrail/store-sqlite';
import { readSupportAgentSourceSnippets } from './source-snippets';

export interface InspectorRunState {
  runId: string | null;
  agentName: string | null;
  status: 'open' | 'done' | null;
  awaiting: string | null;
  sessionVersion: number | null;
  messageCount: number | null;
}

export interface InspectorGraphState {
  hash: string;
  nodes: Array<{ path: string; type: AgentGraphNodeType }>;
}

export interface InspectorPayload {
  run: InspectorRunState;
  graph: InspectorGraphState;
  source: {
    agent: string;
    tools: string;
  };
  persistence: {
    writes: SqliteWriteJournalEntry[];
    counts: SqliteRunCounts;
  };
}

interface InspectorPayloadOptions {
  conversationId: string;
  agentName: SupportAgentName;
  durableStore?: SqliteRunStore;
  agentRegistry?: Record<string, Agent>;
}

export async function getInspectorPayload({
  conversationId,
  agentName,
  durableStore = store,
  agentRegistry = agents,
}: InspectorPayloadOptions): Promise<InspectorPayload> {
  const agent = agentRegistry[agentName];
  const manifest = createAgentGraphManifest(agent.toGraph());
  const run = await durableStore.get(conversationId);
  const session = run ? (run.result ?? run.initial) : undefined;

  return {
    run: run
      ? {
          runId: conversationId,
          agentName: run.agentName,
          status: run.status,
          awaiting: run.graphSuspendedAt ?? null,
          sessionVersion: session?.version ?? null,
          messageCount: session?.messages.length ?? null,
        }
      : {
          runId: null,
          agentName: null,
          status: null,
          awaiting: null,
          sessionVersion: null,
          messageCount: null,
        },
    graph: {
      hash: manifest.hash,
      nodes: manifest.nodes.map((node) => ({
        path: node.path,
        type: node.type,
      })),
    },
    source: readSupportAgentSourceSnippets(agentName),
    persistence: {
      writes: durableStore.writesFor(conversationId),
      counts: durableStore.countsFor(conversationId),
    },
  };
}
