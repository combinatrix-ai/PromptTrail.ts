import type { ObserverLike } from './execution';
import type { HookDefinition, MiddlewareDefinition } from './interceptors';
import type { PromptTrailTool } from './tool';

type AnyMiddlewareDefinition = MiddlewareDefinition<any, any>;
type AnyHookDefinition = HookDefinition<any, any>;

export type AgentGraphNodeType =
  | 'system'
  | 'user'
  | 'assistant'
  | 'messages'
  | 'patch'
  | 'tools'
  | 'inbox'
  | 'awaitInput'
  | 'goal'
  | 'turn'
  | 'loop'
  | 'conditional'
  | 'subroutine'
  | 'parallel'
  | 'structured'
  | 'transform'
  | 'codexTurn'
  | 'claudeTurn';

export interface AgentGraphNode {
  id: string;
  type: AgentGraphNodeType;
  data?: unknown;
  children?: readonly AgentGraphNode[];
}

export interface AgentGraphEdge {
  /** Graph-root-relative node path, for example `turn/reply`. */
  from: string;
  /** Graph-root-relative node path, for example `turn/tools`. */
  to: string;
  condition?: string;
}

export interface AgentGraph {
  name: string;
  version: string;
  nodes: readonly AgentGraphNode[];
  edges: readonly AgentGraphEdge[];
  tools: Record<string, PromptTrailTool<unknown, unknown>>;
  middleware: readonly AnyMiddlewareDefinition[];
  hooks: readonly AnyHookDefinition[];
  observers: readonly ObserverLike[];
}

export interface AgentGraphInput {
  name: string;
  version?: string;
  nodes?: readonly AgentGraphNode[];
  edges?: readonly AgentGraphEdge[];
  tools?: Record<string, PromptTrailTool<unknown, unknown>>;
  middleware?: readonly AnyMiddlewareDefinition[];
  hooks?: readonly AnyHookDefinition[];
  observers?: readonly ObserverLike[];
}

export interface AgentGraphValidationOptions {
  durable?: boolean;
  app?: boolean;
}

export interface AgentGraphManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  hash: string;
  nodes: readonly AgentGraphManifestNode[];
  edges: readonly AgentGraphEdge[];
  tools: readonly AgentGraphManifestTool[];
  handlers: readonly AgentGraphManifestHandler[];
}

export interface AgentGraphManifestNode {
  path: string;
  id: string;
  type: AgentGraphNodeType;
  data?: unknown;
}

export interface AgentGraphManifestTool {
  name: string;
  activity?: unknown;
}

export interface AgentGraphManifestHandler {
  layer: 'agent';
  kind: 'middleware' | 'hook';
  id: string;
  order: number;
}

export class AgentGraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentGraphValidationError';
  }
}

export class AgentGraphVersionError extends Error {
  constructor(
    readonly expectedHash: string,
    readonly actualHash: string,
    readonly agentName: string,
  ) {
    super(
      `Agent graph version mismatch for ${agentName}: expected ${expectedHash}, got ${actualHash}.`,
    );
    this.name = 'AgentGraphVersionError';
  }
}

export function createAgentGraph(input: AgentGraphInput): AgentGraph {
  const graph: AgentGraph = {
    name: input.name,
    version: input.version ?? 'unversioned',
    nodes: input.nodes ?? [],
    edges: input.edges ?? [],
    tools: input.tools ?? {},
    middleware: input.middleware ?? [],
    hooks: input.hooks ?? [],
    observers: input.observers ?? [],
  };
  validateAgentGraph(graph, { durable: true, app: true });
  return graph;
}

export function validateAgentGraph(
  graph: AgentGraph,
  options: AgentGraphValidationOptions = {},
): void {
  if (!isStableGraphId(graph.name)) {
    throw new AgentGraphValidationError(
      `Agent graph name must be a stable id: ${graph.name}`,
    );
  }

  const requireStableNodeIds = options.durable || options.app;
  const seenPaths = new Set<string>();
  for (const node of graph.nodes) {
    validateGraphNode(node, graph.name, {
      requireStableNodeIds,
      seenPaths,
    });
  }

  for (const edge of graph.edges) {
    if (!seenPaths.has(edgeNodePath(graph.name, edge.from))) {
      throw new AgentGraphValidationError(
        `Graph edge references missing from node: ${edge.from}`,
      );
    }
    if (!seenPaths.has(edgeNodePath(graph.name, edge.to))) {
      throw new AgentGraphValidationError(
        `Graph edge references missing to node: ${edge.to}`,
      );
    }
  }

  if (requireStableNodeIds) {
    validateHandlerIds('middleware', graph.middleware);
    validateHandlerIds('hook', graph.hooks);
  }
}

export function createAgentGraphManifest(
  graph: AgentGraph,
): AgentGraphManifest {
  validateAgentGraph(graph, { durable: true, app: true });
  const nodes = flattenManifestNodes(graph.name, graph.nodes);
  const tools = Object.entries(graph.tools)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, tool]) => ({
      name,
      activity: toManifestValue(tool.activity ?? tool.metadata?.activity),
    }));
  const handlers: AgentGraphManifestHandler[] = [
    ...graph.middleware.map((middleware, order) => ({
      layer: 'agent' as const,
      kind: 'middleware' as const,
      id: stableHandlerId(middleware, 'middleware', order),
      order,
    })),
    ...graph.hooks.map((hook, order) => ({
      layer: 'agent' as const,
      kind: 'hook' as const,
      id: stableHandlerId(hook, 'hook', order),
      order,
    })),
  ];
  const unsigned = {
    schemaVersion: 1 as const,
    name: graph.name,
    version: graph.version,
    nodes,
    edges: [...graph.edges],
    tools,
    handlers,
  };
  return {
    ...unsigned,
    hash: stableHash(unsigned),
  };
}

function validateGraphNode(
  node: AgentGraphNode,
  parentPath: string,
  options: {
    requireStableNodeIds: boolean | undefined;
    seenPaths: Set<string>;
  },
): void {
  if (options.requireStableNodeIds && !isStableGraphId(node.id)) {
    throw new AgentGraphValidationError(
      `Graph node id must be stable at ${parentPath}: ${node.id}`,
    );
  }
  if (node.id.includes('/')) {
    throw new AgentGraphValidationError(
      `Graph node id cannot contain "/": ${node.id}`,
    );
  }

  const path = `${parentPath}/${node.id}`;
  if (options.seenPaths.has(path)) {
    throw new AgentGraphValidationError(`Duplicate graph node path: ${path}`);
  }
  options.seenPaths.add(path);

  const localIds = new Set<string>();
  for (const child of node.children ?? []) {
    if (localIds.has(child.id)) {
      throw new AgentGraphValidationError(
        `Duplicate child graph node id at ${path}: ${child.id}`,
      );
    }
    localIds.add(child.id);
    validateGraphNode(child, path, options);
  }
}

function validateHandlerIds(
  kind: 'middleware' | 'hook',
  handlers: ReadonlyArray<{ name?: string }>,
): void {
  const seen = new Set<string>();
  for (let index = 0; index < handlers.length; index++) {
    const id = handlers[index].name;
    if (!isStableGraphId(id)) {
      throw new AgentGraphValidationError(
        `Durable ${kind} at index ${index} must have a stable name.`,
      );
    }
    if (seen.has(id)) {
      throw new AgentGraphValidationError(`Duplicate durable ${kind}: ${id}`);
    }
    seen.add(id);
  }
}

function flattenManifestNodes(
  parentPath: string,
  nodes: readonly AgentGraphNode[],
): AgentGraphManifestNode[] {
  return nodes.flatMap((node) => {
    const path = `${parentPath}/${node.id}`;
    return [
      {
        path,
        id: node.id,
        type: node.type,
        data: toManifestValue(node.data),
      },
      ...flattenManifestNodes(path, node.children ?? []),
    ];
  });
}

function stableHandlerId(
  handler: { name?: string },
  kind: 'middleware' | 'hook',
  order: number,
): string {
  if (!handler.name) {
    throw new AgentGraphValidationError(
      `Durable ${kind} at index ${order} must have a stable name.`,
    );
  }
  return handler.name;
}

function isStableGraphId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    /^[A-Za-z][A-Za-z0-9_-]*$/.test(value)
  );
}

function toManifestValue(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'function') {
    return { kind: 'function', name: value.name || undefined };
  }
  if (typeof value !== 'object') {
    return { kind: typeof value };
  }
  if (seen.has(value)) {
    return { kind: 'circular' };
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => toManifestValue(item, seen));
    }
    if (isManifestDescribable(value)) {
      return {
        kind: 'manifestDescriptor',
        descriptor: toManifestValue(value.getManifestDescriptor(), seen),
      };
    }
    if (!isPlainObject(value)) {
      return {
        kind: 'object',
        ctor: value.constructor?.name || undefined,
      };
    }
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, toManifestValue(record[key], seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface ManifestDescribable {
  getManifestDescriptor: () => unknown;
}

function isManifestDescribable(value: object): value is ManifestDescribable {
  return (
    typeof (value as { getManifestDescriptor?: unknown })
      .getManifestDescriptor === 'function'
  );
}

function stableHash(value: unknown): string {
  return fnv1a(stableStringify(value));
}

function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'null';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function edgeNodePath(graphName: string, edgePath: string): string {
  if (edgePath.startsWith(`${graphName}/`)) {
    return edgePath;
  }
  return `${graphName}/${edgePath}`;
}
