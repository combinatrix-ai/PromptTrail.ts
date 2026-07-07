import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cwd } from 'node:process';

export interface SupportAgentSourceSnippets {
  agent: string;
  tools: string;
}

type SourceRegion = 'support' | 'returns' | 'tools';

const supportAgentSourceCandidates = [
  join(cwd(), 'src', 'lib', 'support-agent.ts'),
  join(
    cwd(),
    'examples',
    'customer-support-chat',
    'src',
    'lib',
    'support-agent.ts',
  ),
];

/**
 * Dev-demo source reader: read the TypeScript module from the working tree so
 * the inspector shows the real checked-in agent and tool definitions. In a
 * bundled production deploy where the source file is absent, snippets degrade
 * to empty strings and the API still responds.
 */
export function readSupportAgentSourceSnippets(
  agent: 'support' | 'returns',
): SupportAgentSourceSnippets {
  const source = readSupportAgentModuleSource();
  if (!source) {
    return { agent: '', tools: '' };
  }

  return {
    agent: extractMarkedRegion(source, agent),
    tools: extractMarkedRegion(source, 'tools'),
  };
}

function readSupportAgentModuleSource(): string | undefined {
  const path = supportAgentSourceCandidates.find((candidate) =>
    existsSync(candidate),
  );
  if (!path) {
    return undefined;
  }
  return readFileSync(path, 'utf8');
}

function extractMarkedRegion(source: string, region: SourceRegion): string {
  const start = `// demo-source:${region}:start`;
  const end = `// demo-source:${region}:end`;
  const startIndex = source.indexOf(start);
  if (startIndex < 0) {
    return '';
  }
  const contentStart = startIndex + start.length;
  const endIndex = source.indexOf(end, contentStart);
  if (endIndex < 0) {
    return '';
  }
  return source.slice(contentStart, endIndex).trim();
}
