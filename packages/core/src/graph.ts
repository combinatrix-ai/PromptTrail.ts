import type { ObserverLike } from './execution';
import type {
  ExecutionEffectDeclaration,
  HookDefinition,
  MiddlewareDefinition,
} from './interceptors';
import type { PromptTrailTool } from './tool';

type AnyMiddlewareDefinition = MiddlewareDefinition<any, any>;
type AnyHookDefinition = HookDefinition<any, any>;

export type AgentGraphNodeType =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tools'
  | 'inbox'
  | 'awaitInput'
  | 'goal'
  | 'scope'
  | 'loop'
  | 'conditional'
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
  metadata?: AgentGraphNodeMetadata;
}

export interface AgentGraphNodeMetadata {
  authoredId?: boolean;
}

export interface AgentGraphEdge {
  /** Graph-root-relative node path, for example `reply`. */
  from: string;
  /** Graph-root-relative node path, for example `tools`. */
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
  effect?: unknown;
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

/**
 * Creates the durable/app version manifest for an agent graph.
 *
 * The manifest hash covers the graph name/version, flattened node paths,
 * node ids/types, serializable node `data` (including template manifest
 * descriptors such as prompt text, provider-turn options, and structured
 * schemas), edges, tool names/activity declarations, and stable middleware /
 * hook ids. Non-serializable values are reduced to stable stand-ins such as
 * function names or object constructor names.
 *
 * WARNING: no manifest hash can detect edits inside a JavaScript closure body
 * when its name and surrounding graph data stay the same. Durable runs that
 * span code edits are unsupported in v1: edit the graph/configuration and
 * resume will fail fast when the manifest changes; edit an opaque closure body
 * and PromptTrail cannot prove it changed.
 */
export function createAgentGraphManifest(
  graph: AgentGraph,
): AgentGraphManifest {
  validateAgentGraph(graph, { durable: true, app: true });
  validateCheckpointEffectDeclarations(graph);
  warnCheckpointDerivedResumeIds(graph);
  const nodes = flattenManifestNodes(graph.name, graph.nodes);
  validateCheckpointVendorToolLoopConsent(graph.name, nodes);
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
      effect: toManifestValue(middleware.effect),
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

function validateCheckpointVendorToolLoopConsent(
  agentName: string,
  nodes: readonly AgentGraphManifestNode[],
): void {
  for (const node of nodes) {
    for (const descriptor of collectLlmSourceDescriptors(node.data)) {
      if (!isNativeAdapterWithTools(descriptor)) {
        continue;
      }
      if (getDescriptorGeneration(descriptor)?.toolLoop === 'vendor') {
        continue;
      }
      throw new AgentGraphValidationError(
        [
          `Checkpoint agent "${agentName}" node "${node.path}" uses a native provider adapter with tools but is missing toolLoop: 'vendor'.`,
          `Fix by switching the source to adapter: 'ai-sdk' so tool calls/results are graph-visible, or declare toolLoop: 'vendor' to accept that vendor tool executions are not durable (outside the once memo; the whole turn re-runs on resume).`,
        ].join(' '),
      );
    }
  }
}

function collectLlmSourceDescriptors(
  value: unknown,
): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectLlmSourceDescriptors(item));
  }

  const record = value as Record<string, unknown>;
  const descriptor = record.descriptor;
  if (
    record.kind === 'manifestDescriptor' &&
    descriptor &&
    typeof descriptor === 'object'
  ) {
    const descriptorRecord = descriptor as Record<string, unknown>;
    if (
      descriptorRecord.kind === 'source' &&
      descriptorRecord.sourceType === 'LlmSource'
    ) {
      return [descriptorRecord];
    }
  }

  return Object.values(record).flatMap((item) =>
    collectLlmSourceDescriptors(item),
  );
}

function isNativeAdapterWithTools(
  descriptor: Record<string, unknown>,
): boolean {
  const config = getDescriptorConfig(descriptor);
  const provider = getDescriptorProvider(descriptor);
  return (
    !!config &&
    isNativeProviderDescriptor(provider) &&
    hasAttachedToolDescriptor(config)
  );
}

function isNativeProviderDescriptor(
  provider: Record<string, unknown> | undefined,
): boolean {
  if (!provider) {
    return false;
  }
  if (provider.type === 'openai') {
    return provider.api === 'responses' && provider.adapter !== 'ai-sdk';
  }
  return (
    (provider.type === 'anthropic' || provider.type === 'google') &&
    provider.adapter !== 'ai-sdk'
  );
}

function hasAttachedToolDescriptor(config: Record<string, unknown>): boolean {
  const tools = config.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    return true;
  }

  const capabilities = config.capabilities;
  return (
    Array.isArray(capabilities) &&
    capabilities.some((capability) => {
      if (!capability || typeof capability !== 'object') {
        return false;
      }
      const kind = (capability as { kind?: unknown }).kind;
      return kind === 'tool' || kind === 'builtin' || kind === 'mcp';
    })
  );
}

function getDescriptorConfig(
  descriptor: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const config = descriptor.config;
  return config && typeof config === 'object'
    ? (config as Record<string, unknown>)
    : undefined;
}

function getDescriptorProvider(
  descriptor: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const provider = getDescriptorConfig(descriptor)?.provider;
  return provider && typeof provider === 'object'
    ? (provider as Record<string, unknown>)
    : undefined;
}

function getDescriptorGeneration(
  descriptor: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const generation = getDescriptorConfig(descriptor)?.generation;
  return generation && typeof generation === 'object'
    ? (generation as Record<string, unknown>)
    : undefined;
}

function validateCheckpointEffectDeclarations(graph: AgentGraph): void {
  for (const [name, tool] of Object.entries(graph.tools)) {
    const effect = tool.activity ?? tool.metadata?.activity;
    if (!isExecutionEffectDeclaration(effect)) {
      throw new AgentGraphValidationError(
        checkpointEffectDeclarationError({
          agentName: graph.name,
          subjectKind: 'tool',
          subjectName: name,
          declarationProperty: 'activity',
        }),
      );
    }
  }

  graph.middleware.forEach((middleware, index) => {
    for (const phase of executionWrapperPhases(middleware as object)) {
      if (!isExecutionEffectDeclaration(middleware.effect)) {
        throw new AgentGraphValidationError(
          checkpointEffectDeclarationError({
            agentName: graph.name,
            subjectKind: 'middleware',
            subjectName: middleware.name ?? `<anonymous:${index}>`,
            phase,
            declarationProperty: 'effect',
          }),
        );
      }
    }
  });

  graph.hooks.forEach((hook, index) => {
    for (const phase of executionWrapperPhases(hook as object)) {
      const effect = (hook as { effect?: unknown }).effect;
      if (!isExecutionEffectDeclaration(effect)) {
        throw new AgentGraphValidationError(
          checkpointEffectDeclarationError({
            agentName: graph.name,
            subjectKind: 'hook',
            subjectName: hook.name ?? `<anonymous:${index}>`,
            phase,
            declarationProperty: 'effect',
          }),
        );
      }
    }
  });
}

function executionWrapperPhases(
  handler: object,
): Array<'wrapModelCall' | 'wrapToolCall'> {
  const record = handler as Record<string, unknown>;
  return (['wrapModelCall', 'wrapToolCall'] as const).filter(
    (phase) => typeof record[phase] === 'function',
  );
}

function checkpointEffectDeclarationError(options: {
  agentName: string;
  subjectKind: 'tool' | 'middleware' | 'hook';
  subjectName: string;
  phase?: string;
  declarationProperty: 'activity' | 'effect';
}): string {
  const phase = options.phase ? ` ${options.phase}` : '';
  return [
    `Checkpoint agent "${options.agentName}" ${options.subjectKind} "${options.subjectName}"${phase} is missing an ExecutionEffectDeclaration.`,
    `Fix by declaring ${options.declarationProperty}: { repeatable: true } or ${options.declarationProperty}: { idempotencyKey: 'stable-key' } (or a function key).`,
  ].join(' ');
}

function warnCheckpointDerivedResumeIds(graph: AgentGraph): void {
  const paths = collectDerivedResumeIdentityPaths(
    graph.nodes,
    graph.name,
  ).sort();
  if (paths.length === 0) {
    return;
  }
  console.warn(
    `Checkpoint agent "${graph.name}" has auto-derived ids on resume-sensitive nodes. Add explicit ids to keep resume stable across graph edits: ${paths.join(', ')}`,
  );
}

function collectDerivedResumeIdentityPaths(
  nodes: readonly AgentGraphNode[],
  parentPath: string,
): string[] {
  return nodes.flatMap((node) => {
    const path = `${parentPath}/${node.id}`;
    const childPaths = collectDerivedResumeIdentityPaths(
      node.children ?? [],
      path,
    );
    const ownPaths =
      node.metadata?.authoredId === false &&
      isResumeSensitiveNode(node, childPaths)
        ? [path]
        : [];
    return [...ownPaths, ...childPaths];
  });
}

function isResumeSensitiveNode(
  node: AgentGraphNode,
  childWarningPaths: readonly string[],
): boolean {
  if (node.type === 'awaitInput') {
    return true;
  }
  if (node.type === 'goal' && graphDataInteraction(node.data) !== 'none') {
    return true;
  }
  return node.type === 'loop' && childWarningPaths.length > 0;
}

function graphDataInteraction(data: unknown): unknown {
  return data && typeof data === 'object'
    ? (data as { interaction?: unknown }).interaction
    : undefined;
}

function isExecutionEffectDeclaration(
  value: unknown,
): value is ExecutionEffectDeclaration {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return 'idempotencyKey' in value || 'repeatable' in value;
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

/**
 * Reduces an arbitrary configuration value to an edit-detecting digest for
 * manifest descriptors. Use this for option bags that may carry secrets
 * (transport env, raw SDK options): the manifest is persisted with the run,
 * so their plaintext must not appear in it, but an edit still has to
 * invalidate resume. The digest is lossy (fnv1a over the stable manifest
 * serialization) — it cannot be reversed into the original values.
 */
export function manifestConfigDigest(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  return {
    kind: 'configDigest',
    digest: stableHash(toManifestValue(value)),
  };
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
