import { Agent, Source, Tool } from '@prompttrail/core';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

// Goal execution is still being migrated to the graph runtime. This example
// demonstrates the final Agent.goal authoring API and prints the compiled graph.

const searchDocumentation = Tool.create({
  name: 'searchDocumentation',
  description: 'Search project documentation for information.',
  inputSchema: z.object({
    query: z.string(),
    depth: z.enum(['shallow', 'deep']).default('shallow'),
  }),
  execute: async ({ query, depth }) => ({
    query,
    depth,
    found: ['architecture', 'authentication', 'api'].includes(
      query.toLowerCase(),
    ),
    summary:
      depth === 'deep'
        ? 'Detailed project notes with related implementation pointers.'
        : 'High-level project notes.',
  }),
});

const inspectCode = Tool.create({
  name: 'inspectCode',
  description: 'Inspect code structure for a requested subsystem.',
  inputSchema: z.object({
    subsystem: z.string(),
  }),
  execute: async ({ subsystem }) => ({
    subsystem,
    files: [`src/${subsystem}/index.ts`, `src/${subsystem}/service.ts`],
    notes: 'Representative code paths for the requested subsystem.',
  }),
});

export function createAutonomousResearcher() {
  return Agent.create('autonomousResearcher')
    .system(
      'system',
      'You are a code research assistant. Research thoroughly before answering.',
    )
    .tool('searchDocumentation', searchDocumentation)
    .tool('inspectCode', inspectCode)
    .goal('collectQuestion', "Get the user's research question.", {
      interaction: 'required',
    })
    .goal('researchTopic', 'Gather enough evidence to answer the question.', {
      maxAttempts: 6,
      tools: ['searchDocumentation', 'inspectCode'],
      model: Source.literal(
        'Use the registered research tools, then assess coverage.',
      ),
      isSatisfied: ({ session }) =>
        session.getMessagesByType('tool_result').length >= 2,
    })
    .goal('finalAnswer', 'Provide a comprehensive answer with citations.');
}

export async function showAutonomousResearcherGraph() {
  const agent = createAutonomousResearcher();
  const graph = agent.toGraph('v1');

  console.log('Agent:', graph.name);
  console.log('Graph version:', graph.version);
  console.log('Nodes:');
  for (const node of flattenGraphNodes(graph.name, graph.nodes)) {
    console.log(`- ${node.path} (${node.type})`);
  }
}

function flattenGraphNodes(
  parentPath: string,
  nodes: readonly { id: string; type: string; children?: readonly any[] }[],
): { path: string; type: string }[] {
  return nodes.flatMap((node) => {
    const path = `${parentPath}/${node.id}`;
    return [
      { path, type: node.type },
      ...flattenGraphNodes(path, node.children ?? []),
    ];
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  showAutonomousResearcherGraph().catch(console.error);
}
