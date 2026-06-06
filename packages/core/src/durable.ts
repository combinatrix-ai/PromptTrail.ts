import { Message, type Message as PromptTrailMessage } from './message';
import { bundle } from './runtime_bindings';
import { server } from './runtime_server';
import { Session, type Attrs, type Vars } from './session';

export type InboundKind = 'user' | 'system' | 'control';

export interface Inbound {
  offset: number;
  kind: InboundKind;
  content: string;
  attrs?: Attrs;
}

export interface DurableTool<
  TArgs extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
> {
  description?: string;
  execute(args: TArgs): Promise<TResult>;
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  id: string;
}

export type AssistantResult<TAttrs extends Attrs = Attrs> =
  | string
  | PromptTrailMessage<TAttrs>
  | {
      content: string;
      attrs?: TAttrs;
      toolCalls?: ToolCall[];
      structuredContent?: Record<string, unknown>;
    };

export type AssistantHandler<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> = (
  session: Session<TVars, TAttrs>,
) => Promise<AssistantResult<TAttrs>> | AssistantResult<TAttrs>;

export interface DurableRunResult<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  status: 'done' | 'suspended';
  runId: string;
  session: Session<TVars, TAttrs>;
  awaiting?: string;
}

export class Suspend extends Error {
  constructor(readonly stepId: string) {
    super(`suspend:${stepId}`);
    this.name = 'Suspend';
  }
}

export class NondeterminismError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
    readonly position: number,
  ) {
    super(
      `Durable replay diverged at journal position ${position}: expected ${expected}, got ${actual}`,
    );
    this.name = 'NondeterminismError';
  }
}

interface JournalState {
  results: Map<string, unknown>;
  sequence: string[];
}

interface DurableExecutionState<TVars extends Vars, TAttrs extends Attrs> {
  runId: string;
  session: Session<TVars, TAttrs>;
  journal: JournalState;
  inbox: Inbound[];
  cursor: number;
  sequencePosition: number;
}

type DurableNode<TVars extends Vars, TAttrs extends Attrs> =
  | { type: 'system'; id: string; content: string }
  | {
      type: 'assistant';
      id: string;
      handler: AssistantHandler<TVars, TAttrs>;
    }
  | {
      type: 'chat';
      id: string;
      handler: AssistantHandler<TVars, TAttrs>;
    }
  | { type: 'runTools'; id: string }
  | { type: 'awaitUser'; id: string }
  | { type: 'steer'; id: string; mode: 'all' | 'one' }
  | {
      type: 'turn';
      id: string;
      nodes: DurableNode<TVars, TAttrs>[];
      untilNoToolCalls: boolean;
    };

function normalizeAssistantMessage<TAttrs extends Attrs>(
  result: AssistantResult<TAttrs>,
): PromptTrailMessage<TAttrs> {
  if (typeof result === 'string') {
    return Message.assistant(result);
  }
  if ('type' in result) {
    return result;
  }
  return {
    type: 'assistant',
    content: result.content,
    attrs: result.attrs,
    toolCalls: result.toolCalls,
    structuredContent: result.structuredContent,
  };
}

function stringifyToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  return JSON.stringify(result);
}

function toolCallsOf<TAttrs extends Attrs>(
  session: Session<any, TAttrs>,
): ToolCall[] {
  return (session.getLastMessage()?.toolCalls ?? []) as ToolCall[];
}

function childPath(parent: string, id: string): string {
  return parent ? `${parent}/${id}` : id;
}

async function journaled<T, TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const expected = state.journal.sequence[state.sequencePosition];
  if (state.journal.results.has(stepId)) {
    if (expected !== stepId) {
      throw new NondeterminismError(expected, stepId, state.sequencePosition);
    }
    state.sequencePosition++;
    return state.journal.results.get(stepId) as T;
  }
  if (expected !== undefined) {
    throw new NondeterminismError(expected, stepId, state.sequencePosition);
  }
  const result = await fn();
  state.journal.results.set(stepId, result);
  state.journal.sequence.push(stepId);
  state.sequencePosition++;
  return result;
}

async function awaitInbound<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
): Promise<Inbound> {
  const offset = await journaled(state, stepId, async () => {
    const inbound = state.inbox.find(
      (message) => message.offset >= state.cursor,
    );
    if (!inbound) {
      throw new Suspend(stepId);
    }
    return inbound.offset;
  });
  state.cursor = offset + 1;
  const inbound = state.inbox.find((message) => message.offset === offset);
  if (!inbound) {
    throw new Error(`Missing inbox message at offset ${offset}`);
  }
  return inbound;
}

async function peekInbox<TVars extends Vars, TAttrs extends Attrs>(
  state: DurableExecutionState<TVars, TAttrs>,
  stepId: string,
  mode: 'all' | 'one',
): Promise<Inbound[]> {
  const offsets = await journaled(state, stepId, async () => {
    const visible = state.inbox.filter(
      (message) => message.offset >= state.cursor,
    );
    return (mode === 'one' ? visible.slice(0, 1) : visible).map(
      (message) => message.offset,
    );
  });
  if (offsets.length > 0) {
    state.cursor = offsets[offsets.length - 1] + 1;
  }
  return offsets.map((offset) => {
    const inbound = state.inbox.find((message) => message.offset === offset);
    if (!inbound) {
      throw new Error(`Missing inbox message at offset ${offset}`);
    }
    return inbound;
  });
}

export class DurableTurnBuilder<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  private nodes: DurableNode<TVars, TAttrs>[] = [];
  private shouldLoopUntilNoToolCalls = false;

  steer(id = 'steer', mode: 'all' | 'one' = 'all'): this {
    this.nodes.push({ type: 'steer', id, mode });
    return this;
  }

  assistant(id: string, handler: AssistantHandler<TVars, TAttrs>): this {
    this.nodes.push({ type: 'assistant', id, handler });
    return this;
  }

  runTools(id = 'tools'): this {
    this.nodes.push({ type: 'runTools', id });
    return this;
  }

  untilNoToolCalls(): this {
    this.shouldLoopUntilNoToolCalls = true;
    return this;
  }

  awaitUser(id = 'input'): this {
    this.nodes.push({ type: 'awaitUser', id });
    return this;
  }

  build(): {
    nodes: DurableNode<TVars, TAttrs>[];
    untilNoToolCalls: boolean;
  } {
    return {
      nodes: [...this.nodes],
      untilNoToolCalls: this.shouldLoopUntilNoToolCalls,
    };
  }
}

export class DurableAgent<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  private nodes: DurableNode<TVars, TAttrs>[] = [];
  private tools = new Map<string, DurableTool>();

  constructor(readonly name: string) {}

  system(content: string, id = 'system'): this {
    this.nodes.push({ type: 'system', id, content });
    return this;
  }

  tool(name: string, tool: DurableTool): this {
    this.tools.set(name, tool);
    return this;
  }

  assistant(id: string, handler: AssistantHandler<TVars, TAttrs>): this {
    this.nodes.push({ type: 'assistant', id, handler });
    return this;
  }

  chat(id: string, handler: AssistantHandler<TVars, TAttrs>): this {
    this.nodes.push({ type: 'chat', id, handler });
    return this;
  }

  turn(
    id: string,
    builder: (
      turn: DurableTurnBuilder<TVars, TAttrs>,
    ) => DurableTurnBuilder<TVars, TAttrs>,
  ): this {
    const turn = builder(new DurableTurnBuilder<TVars, TAttrs>()).build();
    this.nodes.push({
      type: 'turn',
      id,
      nodes: turn.nodes,
      untilNoToolCalls: turn.untilNoToolCalls,
    });
    return this;
  }

  async execute(
    state: DurableExecutionState<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    let session = state.session;
    for (const node of this.nodes) {
      session = await this.executeNode(state, node, '', session);
      state.session = session;
    }
    return session;
  }

  private async executeNode(
    state: DurableExecutionState<TVars, TAttrs>,
    node: DurableNode<TVars, TAttrs>,
    path: string,
    session: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const nodePath = childPath(path, node.id);
    switch (node.type) {
      case 'system':
        return session.addMessage(Message.system(node.content));
      case 'assistant': {
        const message = await journaled(state, `${nodePath}/model`, async () =>
          normalizeAssistantMessage(await node.handler(session)),
        );
        return session.addMessage(message);
      }
      case 'chat': {
        let current = session;
        let iteration = 0;
        while (true) {
          const inbound = await awaitInbound(
            state,
            `${nodePath}#${iteration}/input`,
          );
          current = current.addMessage(
            Message.user(inbound.content, inbound.attrs as TAttrs | undefined),
          );
          state.session = current;
          const message = await journaled(
            state,
            `${nodePath}#${iteration}/model`,
            async () => normalizeAssistantMessage(await node.handler(current)),
          );
          current = current.addMessage(message);
          state.session = current;
          iteration++;
        }
      }
      case 'runTools': {
        let next = session;
        const calls = toolCallsOf(session);
        for (let index = 0; index < calls.length; index++) {
          const call = calls[index];
          const tool = this.tools.get(call.name);
          if (!tool) {
            throw new Error(`Unknown durable tool: ${call.name}`);
          }
          const result = await journaled(
            state,
            `${nodePath}/${call.id || index}`,
            () => tool.execute(call.arguments),
          );
          next = next.addMessage({
            type: 'tool_result',
            content: stringifyToolResult(result),
            attrs: { toolCallId: call.id } as unknown as TAttrs,
          });
        }
        return next;
      }
      case 'awaitUser': {
        const inbound = await awaitInbound(state, `${nodePath}/input`);
        return session.addMessage(
          Message.user(inbound.content, inbound.attrs as TAttrs | undefined),
        );
      }
      case 'steer': {
        const inbound = await peekInbox(state, `${nodePath}/peek`, node.mode);
        return inbound.reduce(
          (current, message) =>
            current.addMessage(
              Message.user(
                message.content,
                message.attrs as TAttrs | undefined,
              ),
            ),
          session,
        );
      }
      case 'turn': {
        if (!node.untilNoToolCalls) {
          let current = session;
          for (const child of node.nodes) {
            current = await this.executeNode(state, child, nodePath, current);
            state.session = current;
          }
          return current;
        }

        const awaitIndex = node.nodes.findIndex(
          (child) => child.type === 'awaitUser',
        );
        const loopNodes =
          awaitIndex === -1 ? node.nodes : node.nodes.slice(0, awaitIndex);
        const tailNodes = awaitIndex === -1 ? [] : node.nodes.slice(awaitIndex);

        let current = session;
        let iteration = 0;
        let shouldLoop = false;
        do {
          shouldLoop = false;
          for (const child of loopNodes) {
            current = await this.executeNode(
              state,
              child,
              `${nodePath}#${iteration}`,
              current,
            );
            state.session = current;
            if (child.type === 'assistant' && toolCallsOf(current).length > 0) {
              shouldLoop = true;
            }
          }
          iteration++;
        } while (shouldLoop);

        for (const child of tailNodes) {
          current = await this.executeNode(state, child, nodePath, current);
          state.session = current;
        }
        return current;
      }
    }
  }
}

export interface StoredRun<TVars extends Vars, TAttrs extends Attrs> {
  agent: DurableAgent<TVars, TAttrs>;
  agentName: string;
  initial: Session<TVars, TAttrs>;
  status: 'open' | 'done';
  result?: Session<TVars, TAttrs>;
  journal: JournalState;
  inbox: Inbound[];
}

export interface PromptTrailRunOptions<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  agent: string | DurableAgent<TVars, TAttrs>;
  runId?: string;
  input?: string | Omit<Inbound, 'offset'>;
  session?: Session<TVars, TAttrs>;
  durable?: boolean;
  resumable?: boolean;
}

export interface PromptTrailSendOptions {
  agent?: string;
  runId: string;
  input: string | Omit<Inbound, 'offset'>;
  durable?: boolean;
  resumable?: boolean;
}

export interface InboundRuntimeEvent {
  source: string;
  agent: string;
  runId: string;
  input: string;
  kind?: InboundKind;
  durable?: boolean;
  resumable?: boolean;
  attrs?: Attrs;
}

export interface EventSource {
  start(
    emit: (event: InboundRuntimeEvent) => Promise<void>,
  ): Promise<void> | void;
  stop?(): Promise<void> | void;
}

export interface DurableRunStore {
  get(runId: string): StoredRun<any, any> | undefined;
  set(runId: string, run: StoredRun<any, any>): void;
  has(runId: string): boolean;
  delete(runId: string): void;
  entries(): Iterable<[string, StoredRun<any, any>]>;
}

export class MemoryRunStore implements DurableRunStore {
  private runs = new Map<string, StoredRun<any, any>>();

  get(runId: string): StoredRun<any, any> | undefined {
    return this.runs.get(runId);
  }

  set(runId: string, run: StoredRun<any, any>): void {
    this.runs.set(runId, run);
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

export interface PromptTrailAppOptions {
  store?: DurableRunStore;
  agents?: Record<string, DurableAgent<any, any>>;
  sources?: Record<string, EventSource>;
}

export class PromptTrailApp {
  private readonly store: DurableRunStore;
  private readonly agents = new Map<string, DurableAgent<any, any>>();
  private readonly sources = new Map<string, EventSource>();
  private runCounter = 0;

  constructor(options: PromptTrailAppOptions = {}) {
    this.store = options.store ?? new MemoryRunStore();
    for (const [name, durableAgent] of Object.entries(options.agents ?? {})) {
      this.agent(name, durableAgent);
    }
    for (const [name, source] of Object.entries(options.sources ?? {})) {
      this.sources.set(name, source);
    }
  }

  agent(name: string, durableAgent: DurableAgent<any, any>): this {
    this.agents.set(name, durableAgent);
    return this;
  }

  source(name: string, source: EventSource): this {
    this.sources.set(name, source);
    return this;
  }

  async start(): Promise<void> {
    for (const source of this.sources.values()) {
      await source.start((event) => this.handleEvent(event));
    }
  }

  async stop(): Promise<void> {
    for (const source of this.sources.values()) {
      await source.stop?.();
    }
  }

  async run<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    options: PromptTrailRunOptions<TVars, TAttrs>,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    return this.startRun(options);
  }

  async send<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    options: PromptTrailSendOptions,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    const durable = options.durable ?? options.resumable ?? true;
    const existing = this.store.get(options.runId);
    if (!existing) {
      if (!options.agent) {
        throw new Error(`Unknown durable run: ${options.runId}`);
      }
      return this.startRun<TVars, TAttrs>({
        agent: options.agent,
        runId: options.runId,
        input: options.input,
        durable,
      });
    }

    this.append(options.runId, normalizeInbound(options.input));
    return this.resume<TVars, TAttrs>(options.runId);
  }

  async resume<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    runId: string,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    const run = this.getRun<TVars, TAttrs>(runId);
    if (run.status === 'done' && run.result) {
      return { status: 'done', runId, session: run.result };
    }

    const state: DurableExecutionState<TVars, TAttrs> = {
      runId,
      session: run.initial,
      journal: run.journal,
      inbox: run.inbox,
      cursor: 0,
      sequencePosition: 0,
    };

    try {
      const session = await run.agent.execute(state);
      run.status = 'done';
      run.result = session;
      return { status: 'done', runId, session };
    } catch (error) {
      if (error instanceof Suspend) {
        run.result = state.session;
        return {
          status: 'suspended',
          runId,
          awaiting: error.stepId,
          session: state.session,
        };
      }
      throw error;
    }
  }

  journal(runId: string): readonly string[] {
    return [...this.getRun(runId).journal.sequence];
  }

  private async handleEvent(event: InboundRuntimeEvent): Promise<void> {
    await this.send({
      agent: event.agent,
      runId: event.runId,
      input: {
        kind: event.kind ?? 'user',
        content: event.input,
        attrs: event.attrs,
      },
      durable: event.durable,
      resumable: event.resumable,
    });
  }

  private async startRun<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(
    options: PromptTrailRunOptions<TVars, TAttrs>,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    const durable = options.durable ?? options.resumable ?? false;
    const durableAgent = this.resolveAgent(options.agent);
    const runId = options.runId ?? `${durableAgent.name}-${++this.runCounter}`;
    const initial = options.session ?? Session.create<TVars, TAttrs>();
    const run: StoredRun<TVars, TAttrs> = {
      agent: durableAgent,
      agentName: durableAgent.name,
      initial,
      status: 'open',
      journal: { results: new Map(), sequence: [] },
      inbox: [],
    };

    if (durable) {
      this.store.set(runId, run);
      if (options.input !== undefined) {
        this.append(runId, normalizeInbound(options.input));
      }
      return this.resume<TVars, TAttrs>(runId);
    }

    if (options.input !== undefined) {
      run.inbox.push({ ...normalizeInbound(options.input), offset: 0 });
    }
    return this.executeEphemeral(runId, run);
  }

  private async executeEphemeral<
    TVars extends Vars = Vars,
    TAttrs extends Attrs = Attrs,
  >(
    runId: string,
    run: StoredRun<TVars, TAttrs>,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    const state: DurableExecutionState<TVars, TAttrs> = {
      runId,
      session: run.initial,
      journal: run.journal,
      inbox: run.inbox,
      cursor: 0,
      sequencePosition: 0,
    };
    try {
      const session = await run.agent.execute(state);
      return { status: 'done', runId, session };
    } catch (error) {
      if (error instanceof Suspend) {
        return {
          status: 'suspended',
          runId,
          awaiting: error.stepId,
          session: state.session,
        };
      }
      throw error;
    }
  }

  private append(runId: string, message: Omit<Inbound, 'offset'>): void {
    const run = this.getRun(runId);
    run.inbox.push({ ...message, offset: run.inbox.length });
    if (run.status === 'done') {
      run.status = 'open';
      run.result = undefined;
    }
  }

  private resolveAgent<TVars extends Vars, TAttrs extends Attrs>(
    durableAgent: string | DurableAgent<TVars, TAttrs>,
  ): DurableAgent<TVars, TAttrs> {
    if (typeof durableAgent !== 'string') {
      return durableAgent;
    }
    const resolved = this.agents.get(durableAgent);
    if (!resolved) {
      throw new Error(`Unknown agent: ${durableAgent}`);
    }
    return resolved as DurableAgent<TVars, TAttrs>;
  }

  private getRun<TVars extends Vars, TAttrs extends Attrs>(
    runId: string,
  ): StoredRun<TVars, TAttrs> {
    const run = this.store.get(runId);
    if (!run) {
      throw new Error(`Unknown durable run: ${runId}`);
    }
    return run as StoredRun<TVars, TAttrs>;
  }
}

export class MemoryDurableRuntime {
  private readonly app = new PromptTrailApp();

  async start<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    durableAgent: DurableAgent<TVars, TAttrs>,
    options: {
      runId: string;
      session?: Session<TVars, TAttrs>;
      input?: string;
    },
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    return this.app.run<TVars, TAttrs>({
      agent: durableAgent,
      runId: options.runId,
      session: options.session,
      input: options.input,
      durable: true,
    });
  }

  async send<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    runId: string,
    content: string | Omit<Inbound, 'offset'>,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    return this.app.send<TVars, TAttrs>({
      runId,
      input: content,
      durable: true,
    });
  }

  async resume<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    runId: string,
  ): Promise<DurableRunResult<TVars, TAttrs>> {
    return this.app.resume<TVars, TAttrs>(runId);
  }

  journal(runId: string): readonly string[] {
    return this.app.journal(runId);
  }
}

function normalizeInbound(
  input: string | Omit<Inbound, 'offset'>,
): Omit<Inbound, 'offset'> {
  return typeof input === 'string' ? { kind: 'user', content: input } : input;
}

export function agent<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
  name: string,
): DurableAgent<TVars, TAttrs> {
  return new DurableAgent<TVars, TAttrs>(name);
}

export function memoryStore(): DurableRunStore {
  return new MemoryRunStore();
}

export function app(options: PromptTrailAppOptions = {}): PromptTrailApp {
  return new PromptTrailApp(options);
}

export function manualSource(): EventSource & {
  emit(event: InboundRuntimeEvent): Promise<void>;
} {
  let emitEvent: ((event: InboundRuntimeEvent) => Promise<void>) | undefined;
  return {
    start(emit) {
      emitEvent = emit;
    },
    async emit(event) {
      if (!emitEvent) {
        throw new Error('Manual source has not been started');
      }
      await emitEvent(event);
    },
  };
}

export const PromptTrail = {
  app,
  bundle,
  server,
};
