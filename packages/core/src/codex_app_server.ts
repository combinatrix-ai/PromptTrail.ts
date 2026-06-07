import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import {
  createInterface,
  type Interface as ReadlineInterface,
} from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { Message } from './message';
import type { Session, Attrs, Vars } from './session';
import {
  type RetainLevel,
  type RuntimeEvent,
  type RuntimeEventSummary,
} from './runtime';
import type {
  ApprovalHandler,
  ApprovalRequest,
  CapabilitySet,
  McpServer,
  PromptTrailTool,
  RuntimeSkill,
} from './capabilities';
import { zodToJsonSchema, type JsonSchema } from './json_schema';
import { executePromptTrailTool, isPromptTrailTool } from './tool';

export type CodexThreadId =
  | string
  | 'new'
  | 'auto'
  | ((
      session: Session<any, any>,
      context: Record<string, unknown> | undefined,
    ) => string | undefined | Promise<string | undefined>);

export type CodexTurnInput =
  | string
  | unknown[]
  | ((
      session: Session<any, any>,
      context: Record<string, unknown> | undefined,
    ) => string | unknown[] | Promise<string | unknown[]>);

export interface CodexThreadStartParams {
  cwd?: string;
  model?: string;
  sandboxPolicy?: unknown;
  approvalPolicy?: unknown;
  dynamicTools?: CodexDynamicToolDefinition[];
  [key: string]: unknown;
}

export interface CodexTurnStartParams {
  threadId: string;
  input?: string | unknown[];
  cwd?: string;
  model?: string;
  sandboxPolicy?: unknown;
  approvalPolicy?: unknown;
  [key: string]: unknown;
}

export interface CodexThreadStartResult {
  threadId: string;
  thread?: { id?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface CodexTurnEvent {
  method?: string;
  type?: string;
  id?: number | string;
  result?: unknown;
  error?: unknown;
  item?: unknown;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodexInboundRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
  raw: CodexTurnEvent;
}

export type CodexInboundRequestHandler = (
  request: CodexInboundRequest,
) => unknown | Promise<unknown>;

export interface CodexDynamicToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export interface CodexTurnResult {
  threadId?: string;
  turnId?: string;
  status?: string;
  finalAnswer?: string;
  items?: unknown[];
  events?: RuntimeEvent[] | RuntimeEventSummary[];
  plan?: unknown;
  diff?: unknown;
  commands?: unknown[];
  raw?: unknown;
  [key: string]: unknown;
}

export interface CodexSkillListResult {
  skills?: unknown[];
  [key: string]: unknown;
}

export interface CodexRuntimeSkillInfo {
  name?: string;
  description?: string;
  instructions?: string;
  skillId?: string;
  id?: string;
  path?: string;
  [key: string]: unknown;
}

export interface CodexAppServerClient {
  listSkills?(): Promise<CodexSkillListResult | unknown[]>;
  startThread(params: CodexThreadStartParams): Promise<CodexThreadStartResult>;
  startTurn(
    params: CodexTurnStartParams,
  ): Promise<CodexTurnResult | AsyncIterable<CodexTurnEvent>>;
  close?(): Promise<void>;
}

export interface CodexAppServerHttpClientOptions {
  url: string;
  fetch?: typeof fetch;
}

export class CodexAppServerHttpClient implements CodexAppServerClient {
  private nextId = 1;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CodexAppServerHttpClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async startThread(
    params: CodexThreadStartParams,
  ): Promise<CodexThreadStartResult> {
    return this.request<CodexThreadStartResult>('thread/start', params);
  }

  async startTurn(params: CodexTurnStartParams): Promise<CodexTurnResult> {
    return this.request<CodexTurnResult>('turn/start', params);
  }

  async listSkills(): Promise<CodexSkillListResult | unknown[]> {
    return this.request<CodexSkillListResult | unknown[]>('skills/list');
  }

  private async request<T>(method: string, params?: unknown): Promise<T> {
    const response = await this.fetchImpl(this.options.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextId++,
        method,
        ...(params === undefined ? {} : { params }),
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Codex App Server request failed: ${response.status} ${response.statusText}`,
      );
    }

    const payload = (await response.json()) as {
      error?: { message?: string };
      result?: T;
    };

    if (payload.error) {
      throw new Error(
        `Codex App Server ${method} error: ${payload.error.message ?? 'unknown error'}`,
      );
    }

    if (payload.result === undefined) {
      throw new Error(`Codex App Server ${method} returned no result`);
    }

    return payload.result;
  }
}

export function createCodexAppServerHttpClient(
  options: CodexAppServerHttpClientOptions,
): CodexAppServerClient {
  return new CodexAppServerHttpClient(options);
}

export interface CodexAppServerLineJsonRpcClientOptions {
  readable: Readable;
  writable: Writable;
  timeoutMs?: number;
  close?: () => void | Promise<void>;
}

export class CodexAppServerLineJsonRpcClient implements CodexAppServerClient {
  private nextId = 1;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<
    number,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    private readonly options: CodexAppServerLineJsonRpcClientOptions,
  ) {
    this.lines = createInterface({ input: options.readable });
    this.lines.on('line', (line) => this.handleLine(line));
    this.lines.on('close', () => {
      this.rejectPending(new Error('Codex App Server line transport closed'));
    });
    this.lines.on('error', () => {
      this.rejectPending(new Error('Codex App Server line transport error'));
    });
  }

  async startThread(
    params: CodexThreadStartParams,
  ): Promise<CodexThreadStartResult> {
    return this.request<CodexThreadStartResult>('thread/start', params);
  }

  async startTurn(params: CodexTurnStartParams): Promise<CodexTurnResult> {
    return this.request<CodexTurnResult>('turn/start', params);
  }

  async listSkills(): Promise<CodexSkillListResult | unknown[]> {
    return this.request<CodexSkillListResult | unknown[]>('skills/list');
  }

  async close(): Promise<void> {
    this.lines.close();
    await this.options.close?.();
    this.rejectPending(new Error('Codex App Server line transport closed'));
  }

  private request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const request = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });
      this.options.writable.write(`${JSON.stringify(request)}\n`);
    });
  }

  private handleLine(line: string): void {
    if (!line.trim()) {
      return;
    }
    const message = JSON.parse(line) as {
      id?: number | string;
      error?: unknown;
      result?: unknown;
    };
    if (message.id === undefined) {
      return;
    }
    const id = typeof message.id === 'number' ? message.id : Number(message.id);
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(id);
    if (message.error) {
      pending.reject(
        new Error(
          `Codex App Server ${pending.method} error: ${formatUnknownError(message.error)}`,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export interface CodexAppServerStdioClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export class CodexAppServerStdioClient
  extends CodexAppServerLineJsonRpcClient
  implements CodexAppServerClient
{
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(options: CodexAppServerStdioClientOptions) {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.pipe(process.stderr);
    super({
      readable: child.stdout,
      writable: child.stdin,
      timeoutMs: options.timeoutMs,
      close: () => {
        child.kill();
      },
    });
    this.child = child;
  }

  override async close(): Promise<void> {
    await super.close();
    this.child.kill();
  }
}

export function createCodexAppServerStdioClient(
  options: CodexAppServerStdioClientOptions,
): CodexAppServerClient {
  return new CodexAppServerStdioClient(options);
}

export interface CodexAppServerUnixSocketClientOptions {
  path: string;
  timeoutMs?: number;
}

export class CodexAppServerUnixSocketClient
  extends CodexAppServerLineJsonRpcClient
  implements CodexAppServerClient
{
  private readonly socket: Socket;

  constructor(options: CodexAppServerUnixSocketClientOptions) {
    const socket = createConnection(options.path);
    super({
      readable: socket,
      writable: socket,
      timeoutMs: options.timeoutMs,
      close: () => {
        socket.end();
      },
    });
    this.socket = socket;
  }

  override async close(): Promise<void> {
    await super.close();
    this.socket.end();
  }
}

export function createCodexAppServerUnixSocketClient(
  options: CodexAppServerUnixSocketClientOptions,
): CodexAppServerClient {
  return new CodexAppServerUnixSocketClient(options);
}

export interface CodexAppServerWebSocketClientOptions {
  url: string;
  WebSocket?: typeof WebSocket;
  timeoutMs?: number;
  clientInfo?: {
    name?: string;
    title?: string;
    version?: string;
  };
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
  onRequest?: CodexInboundRequestHandler;
}

export class CodexAppServerWebSocketClient implements CodexAppServerClient {
  private socket?: WebSocket;
  private nextId = 1;
  private initialized = false;
  private readonly pending = new Map<
    number,
    {
      method: string;
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  private readonly pendingTurns = new Map<
    string,
    {
      result: CodexTurnResult;
      resolve: (value: CodexTurnResult) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(private readonly options: CodexAppServerWebSocketClientOptions) {}

  async startThread(
    params: CodexThreadStartParams,
  ): Promise<CodexThreadStartResult> {
    const result = (await this.request('thread/start', params)) as
      | CodexThreadStartResult
      | { thread?: { id?: string } };
    const threadId =
      'threadId' in result && typeof result.threadId === 'string'
        ? result.threadId
        : result.thread?.id;

    if (!threadId) {
      throw new Error('Codex App Server thread/start returned no thread id');
    }

    return { ...result, threadId };
  }

  async startTurn(params: CodexTurnStartParams): Promise<CodexTurnResult> {
    const result = (await this.request('turn/start', params)) as {
      turn?: {
        id?: string;
        status?: string;
        items?: unknown[];
        error?: unknown;
      };
    };
    const turnId = result.turn?.id;
    if (!turnId) {
      throw new Error('Codex App Server turn/start returned no turn id');
    }

    return this.waitForTurnCompletion(params.threadId, turnId, result.turn);
  }

  async listSkills(): Promise<CodexSkillListResult | unknown[]> {
    return this.request('skills/list') as Promise<
      CodexSkillListResult | unknown[]
    >;
  }

  async close(): Promise<void> {
    if (this.socket && this.socket.readyState === 1) {
      this.socket.close();
    }
    this.socket = undefined;
    this.initialized = false;
    this.rejectPending(new Error('Codex App Server WebSocket closed'));
  }

  private async waitForTurnCompletion(
    threadId: string,
    turnId: string,
    turn: { status?: string; items?: unknown[]; error?: unknown } = {},
  ): Promise<CodexTurnResult> {
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const initialItems = Array.isArray(turn.items) ? [...turn.items] : [];
    const initialResult: CodexTurnResult = {
      threadId,
      turnId,
      status: turn.status,
      items: initialItems,
      events: [],
      error: turn.error,
    };

    if (turn.status && turn.status !== 'inProgress') {
      initialResult.finalAnswer = extractCodexFinalAnswer(initialResult);
      return initialResult;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingTurns.delete(turnId);
        reject(new Error(`Codex App Server turn timed out: ${turnId}`));
      }, timeoutMs);
      this.pendingTurns.set(turnId, {
        result: initialResult,
        resolve,
        reject,
        timeout,
      });
    });
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    await this.ensureInitialized();
    const socket = this.socket;
    if (!socket) {
      throw new Error('Codex App Server WebSocket is not connected');
    }

    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const request = {
      method,
      id,
      ...(params === undefined ? {} : { params }),
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      socket.send(JSON.stringify(request));
    });
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.socket?.readyState === WebSocket.OPEN) {
      return;
    }

    const WebSocketCtor = this.options.WebSocket ?? globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw new Error(
        'Codex App Server WebSocket transport requires a WebSocket implementation.',
      );
    }

    const socket = new WebSocketCtor(this.options.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Codex App Server WebSocket connection timed out'));
      }, this.options.timeoutMs ?? 120_000);

      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Codex App Server WebSocket connection failed'));
      });
    });

    socket.addEventListener('message', (event) => {
      this.handleMessage(event.data);
    });
    socket.addEventListener('close', () => {
      this.initialized = false;
      this.rejectPending(new Error('Codex App Server WebSocket closed'));
    });
    socket.addEventListener('error', () => {
      this.rejectPending(new Error('Codex App Server WebSocket error'));
    });

    await this.requestWithoutInitialization('initialize', {
      clientInfo: {
        name: 'prompttrail_ts',
        title: 'PromptTrail.ts',
        version: '0.0.1',
        ...this.options.clientInfo,
      },
    });
    socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    this.initialized = true;
  }

  private async requestWithoutInitialization(
    method: string,
    params?: unknown,
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket) {
      throw new Error('Codex App Server WebSocket is not connected');
    }

    const id = this.nextId++;
    const timeoutMs = this.options.timeoutMs ?? 120_000;
    const request = { method, id, ...(params === undefined ? {} : { params }) };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex App Server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      socket.send(JSON.stringify(request));
    });
  }

  private handleMessage(data: unknown): void {
    const text =
      typeof data === 'string'
        ? data
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : String(data);
    const message = JSON.parse(text) as CodexTurnEvent;

    if (message.id !== undefined) {
      const requestId =
        typeof message.id === 'number' ? message.id : Number(message.id);
      const pending = this.pending.get(requestId);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(requestId);
        if (message.error) {
          pending.reject(
            new Error(
              `Codex App Server ${pending.method} error: ${formatUnknownError(message.error)}`,
            ),
          );
        } else {
          pending.resolve(message.result);
        }
        return;
      }

      if (typeof message.method === 'string') {
        void this.handleInboundRequest(message);
        return;
      }
    }

    this.handleNotification(message);
  }

  private async handleInboundRequest(message: CodexTurnEvent): Promise<void> {
    const id = message.id;
    const method = message.method;
    if (id === undefined || typeof method !== 'string') {
      return;
    }

    try {
      if (!this.options.onRequest) {
        this.sendJsonRpcError(id, -32601, `No handler for ${method}`);
        return;
      }

      const result = await this.options.onRequest({
        id,
        method,
        params: message.params,
        raw: message,
      });
      this.sendJsonRpcResult(id, result ?? null);
    } catch (error) {
      this.sendJsonRpcError(id, -32603, formatUnknownError(error));
    }
  }

  private sendJsonRpcResult(id: number | string, result: unknown): void {
    this.socket?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result,
      }),
    );
  }

  private sendJsonRpcError(
    id: number | string,
    code: number,
    message: string,
  ): void {
    this.socket?.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code, message },
      }),
    );
  }

  private handleNotification(message: CodexTurnEvent): void {
    const params = message.params ?? {};
    const turnId = getTurnIdFromNotification(message);
    const turnState = turnId ? this.pendingTurns.get(turnId) : undefined;
    const runtimeEvent = normalizeCodexRuntimeEvent(message);
    if (runtimeEvent) {
      void this.options.onEvent?.(runtimeEvent);
      if (turnState) {
        turnState.result.events = [
          ...((turnState.result.events as RuntimeEvent[] | undefined) ?? []),
          runtimeEvent,
        ];
      }
    }

    if (!turnState) {
      return;
    }

    if (
      message.method === 'item/started' ||
      message.method === 'item/completed'
    ) {
      const item = params.item;
      if (item) {
        turnState.result.items = [...(turnState.result.items ?? []), item];
      }
    }

    if (message.method === 'item/agentMessage/delta') {
      const delta = getDeltaText(params);
      if (delta) {
        turnState.result.finalAnswer = `${turnState.result.finalAnswer ?? ''}${delta}`;
      }
    }

    if (message.method === 'turn/completed') {
      if (!turnId) {
        return;
      }
      clearTimeout(turnState.timeout);
      this.pendingTurns.delete(turnId);
      const turn = params.turn as
        | { status?: string; error?: unknown; durationMs?: number }
        | undefined;
      turnState.result.status = turn?.status ?? turnState.result.status;
      turnState.result.error = turn?.error;
      turnState.result.durationMs = turn?.durationMs;

      const finalAnswer = extractCodexFinalAnswer(turnState.result);
      if (finalAnswer) {
        turnState.result.finalAnswer = finalAnswer;
      }

      if (turnState.result.status === 'failed') {
        turnState.reject(
          new Error(
            `Codex App Server turn failed: ${formatUnknownError(turnState.result.error)}`,
          ),
        );
      } else {
        turnState.resolve(turnState.result);
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      pending.reject(error);
    }

    for (const [turnId, pending] of this.pendingTurns) {
      clearTimeout(pending.timeout);
      this.pendingTurns.delete(turnId);
      pending.reject(error);
    }
  }
}

export function createCodexAppServerWebSocketClient(
  options: CodexAppServerWebSocketClientOptions,
): CodexAppServerClient {
  return new CodexAppServerWebSocketClient(options);
}

export interface CodexTurnOptions<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> {
  threadId?: CodexThreadId;
  input?: CodexTurnInput;
  client?: CodexAppServerClient;
  transport?:
    | { kind: 'http'; url: string }
    | { kind: 'websocket'; url: string; timeoutMs?: number }
    | {
        kind: 'stdio';
        command: string;
        args?: string[];
        cwd?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
      }
    | { kind: 'unix'; path: string; timeoutMs?: number };
  cwd?: string;
  model?: string;
  sandboxPolicy?: unknown;
  approvalPolicy?: unknown;
  capabilities?: CapabilitySet;
  retain?: RetainLevel;
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
  onRequest?: CodexInboundRequestHandler;
  approvalHandler?: ApprovalHandler;
  retainMessages?: boolean;
  attrsKey?: string;
  threadStart?: Record<string, unknown>;
  turnStart?: Record<string, unknown>;
  squashWith?: (
    parentSession: Session<TVars, TAttrs>,
    result: CodexTurnResult,
  ) => Session<TVars, TAttrs> | Promise<Session<TVars, TAttrs>>;
}

export function promptTrailToolToCodexDynamicTool(
  tool: PromptTrailTool,
): CodexDynamicToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.inputSchema),
  };
}

export function getPromptTrailTools(
  capabilities: CapabilitySet | undefined,
): PromptTrailTool[] {
  return (capabilities ?? []).filter(isPromptTrailTool);
}

export function getCodexRuntimeSkills(
  capabilities: CapabilitySet | undefined,
): RuntimeSkill[] {
  return (capabilities ?? []).filter(
    (capability): capability is RuntimeSkill => capability.kind === 'skill',
  );
}

export async function resolveCodexRuntimeSkills(
  client: CodexAppServerClient,
  skills: readonly RuntimeSkill[],
): Promise<RuntimeSkill[]> {
  if (skills.length === 0 || !client.listSkills) {
    return [...skills];
  }

  const listedSkills = normalizeCodexSkillListResult(await client.listSkills());
  if (listedSkills.length === 0) {
    return [...skills];
  }

  const skillsByName = new Map(
    listedSkills
      .map((skill) => [getStringProperty(skill, 'name'), skill] as const)
      .filter((entry): entry is readonly [string, CodexRuntimeSkillInfo] =>
        Boolean(entry[0]),
      ),
  );

  return skills.map((skill) => {
    const listedSkill = skillsByName.get(skill.name);
    if (!listedSkill) {
      return skill;
    }

    return {
      ...skill,
      description:
        skill.description ?? getStringProperty(listedSkill, 'description'),
      instructions:
        skill.instructions ?? getStringProperty(listedSkill, 'instructions'),
      skillId:
        skill.skillId ??
        getStringProperty(listedSkill, 'skillId') ??
        getStringProperty(listedSkill, 'id'),
      path: skill.path ?? getStringProperty(listedSkill, 'path'),
      metadata: {
        ...(skill.metadata ?? {}),
        codexSkill: listedSkill,
      },
    };
  });
}

function normalizeCodexSkillListResult(
  result: CodexSkillListResult | unknown[],
): CodexRuntimeSkillInfo[] {
  const rawSkills = Array.isArray(result)
    ? result
    : Array.isArray(result.skills)
      ? result.skills
      : [];
  return rawSkills.filter(isCodexRuntimeSkillInfo);
}

function isCodexRuntimeSkillInfo(value: unknown): value is CodexRuntimeSkillInfo {
  return Boolean(value) && typeof value === 'object';
}

function getStringProperty(
  value: CodexRuntimeSkillInfo,
  key: string,
): string | undefined {
  const property = value[key];
  return typeof property === 'string' ? property : undefined;
}

export function getCodexMcpServers(
  capabilities: CapabilitySet | undefined,
): McpServer[] {
  return (capabilities ?? []).filter(
    (capability): capability is McpServer => capability.kind === 'mcp',
  );
}

export function promptTrailMcpToCodexMcpServer(
  server: McpServer,
): Record<string, unknown> {
  if (server.transport.kind === 'sdk-in-process') {
    return {
      type: 'sdk-in-process',
      server: server.transport.server,
      tools: server.tools,
    };
  }
  if (server.transport.kind === 'http') {
    return {
      type: 'http',
      url: server.transport.url,
      headers: server.transport.headers,
      tools: server.tools,
    };
  }
  return {
    type: 'stdio',
    command: server.transport.command,
    args: server.transport.args,
    env: server.transport.env,
    tools: server.tools,
  };
}

export function getCodexMcpServerConfig(
  capabilities: CapabilitySet | undefined,
): Record<string, unknown> | undefined {
  const servers = Object.fromEntries(
    getCodexMcpServers(capabilities).map((server) => [
      server.name,
      promptTrailMcpToCodexMcpServer(server),
    ]),
  );
  return Object.keys(servers).length > 0 ? servers : undefined;
}

export function promptTrailSkillToCodexInputItem(
  skill: RuntimeSkill,
): Record<string, unknown> {
  return {
    type: 'skill',
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    skillId: skill.skillId,
    path: skill.path,
    materialize: skill.materialize,
  };
}

export function createCodexToolRequestHandler(
  tools: readonly PromptTrailTool[],
  session: Session<any, any>,
  fallback?: CodexInboundRequestHandler,
  approvalHandler?: ApprovalHandler,
): CodexInboundRequestHandler {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  return async (request) => {
    if (request.method !== 'item/tool/call') {
      if (fallback) {
        return fallback(request);
      }
      throw new Error(`No handler for ${request.method}`);
    }

    const toolName = getCodexToolCallName(request.params);
    if (!toolName) {
      throw new Error('Codex tool call request is missing a tool name.');
    }

    const tool = byName.get(toolName);
    if (!tool) {
      throw new Error(`Unknown Codex dynamic tool: ${toolName}`);
    }

    return executePromptTrailTool(tool, getCodexToolCallInput(request.params), {
      session,
      provider: 'codex',
      approvalHandler,
      raw: request.raw,
    });
  };
}

export function createCodexRuntimeRequestHandler(options: {
  tools?: readonly PromptTrailTool[];
  session: Session<any, any>;
  fallback?: CodexInboundRequestHandler;
  approvalHandler?: ApprovalHandler;
}): CodexInboundRequestHandler {
  const toolHandler =
    options.tools && options.tools.length > 0
      ? createCodexToolRequestHandler(
          options.tools,
          options.session,
          undefined,
          options.approvalHandler,
        )
      : undefined;

  return async (request) => {
    if (request.method === 'item/tool/call' && toolHandler) {
      return toolHandler(request);
    }

    const approvalRequest = codexInboundRequestToApprovalRequest(request);
    if (approvalRequest && options.approvalHandler) {
      const decision = await options.approvalHandler(
        approvalRequest,
        options.session,
      );
      if (decision.type === 'approve') {
        return { decision: 'approve', reason: decision.reason };
      }
      if (decision.type === 'deny') {
        return { decision: 'deny', reason: decision.reason };
      }
      return { decision: 'ask-user', question: decision.question };
    }

    if (options.fallback) {
      return options.fallback(request);
    }

    throw new Error(`No handler for ${request.method}`);
  };
}

export function codexInboundRequestToApprovalRequest(
  request: CodexInboundRequest,
): ApprovalRequest | undefined {
  if (request.method === 'item/commandExecution/requestApproval') {
    return {
      provider: 'codex',
      action: 'commandExecution',
      input: request.params,
      risk: 'execute',
      raw: request.raw,
    };
  }
  if (request.method === 'item/fileChange/requestApproval') {
    return {
      provider: 'codex',
      action: 'fileChange',
      input: request.params,
      risk: 'write',
      raw: request.raw,
    };
  }
  if (request.method === 'tool/requestUserInput') {
    return {
      provider: 'codex',
      action: 'userInput',
      input: request.params,
      raw: request.raw,
    };
  }

  return undefined;
}

export function extractCodexFinalAnswer(result: CodexTurnResult): string {
  if (typeof result.finalAnswer === 'string') {
    return result.finalAnswer;
  }

  const directText = ['outputText', 'text', 'message', 'content']
    .map((key) => result[key])
    .find((value) => typeof value === 'string');

  if (typeof directText === 'string') {
    return directText;
  }

  for (const item of result.items ?? []) {
    const text = extractTextFromUnknown(item);
    if (text) {
      return text;
    }
  }

  return '';
}

export async function collectCodexTurnResult(
  turnResult: CodexTurnResult | AsyncIterable<CodexTurnEvent>,
  defaults?: Pick<CodexTurnResult, 'threadId'>,
  onEvent?: (event: RuntimeEvent) => void | Promise<void>,
): Promise<CodexTurnResult> {
  if (!isAsyncIterable(turnResult)) {
    return { ...defaults, ...turnResult };
  }

  const items: unknown[] = [];
  const events: RuntimeEvent[] = [];
  const result: CodexTurnResult = { ...defaults, items, events };

  for await (const event of turnResult) {
    const runtimeEvent = normalizeCodexRuntimeEvent(event);
    if (runtimeEvent) {
      events.push(runtimeEvent);
      await onEvent?.(runtimeEvent);
    }

    const params = event.params ?? {};
    if (typeof params.turnId === 'string') {
      result.turnId = params.turnId;
    }
    if (typeof params.status === 'string') {
      result.status = params.status;
    }
    const turn = params.turn as Record<string, unknown> | undefined;
    if (typeof turn?.id === 'string') {
      result.turnId = turn.id;
    }
    if (typeof turn?.status === 'string') {
      result.status = turn.status;
    }
    if ('error' in (turn ?? {})) {
      result.error = turn?.error;
    }
    if ('plan' in params) {
      result.plan = params.plan;
    }
    if ('diff' in params) {
      result.diff = params.diff;
    }
    if ('item' in params) {
      items.push(params.item);
    } else if ('item' in event) {
      items.push(event.item);
    }
  }

  result.finalAnswer = extractCodexFinalAnswer(result);
  return result;
}

export function normalizeCodexRuntimeEvent(
  event: CodexTurnEvent,
): RuntimeEvent | undefined {
  if (event.error) {
    return {
      type: 'error',
      id: getEventId(event),
      error: event.error,
      raw: event,
    };
  }

  const method = event.method ?? event.type;
  if (!method) {
    return undefined;
  }

  const params = event.params ?? {};
  const item = getRecord(params.item);
  if (method === 'item/started' || method === 'item/completed') {
    const content = item?.content ?? item?.text ?? item?.message;
    return {
      type: method === 'item/started' ? 'item.started' : 'item.completed',
      id: getItemId(item, event),
      itemType: getString(item?.type ?? item?.kind),
      status: getString(item?.status),
      preview: typeof content === 'string' ? content : undefined,
      raw: event,
    };
  }

  if (method === 'item/agentMessage/delta') {
    return {
      type: 'text.delta',
      id: getEventId(event),
      delta: getDeltaText(params) ?? '',
      raw: event,
    };
  }

  if (method === 'turn/completed') {
    const turn = params.turn as Record<string, unknown> | undefined;
    return {
      type: 'turn.completed',
      id: getString(turn?.id) ?? getEventId(event),
      status: getString(turn?.status ?? params.status),
      raw: event,
    };
  }

  const approvalAction = getCodexApprovalAction(method);
  if (approvalAction) {
    const type = method.toLowerCase().includes('request')
      ? 'approval.requested'
      : 'approval.resolved';
    return {
      type,
      id: getEventId(event),
      action: approvalAction,
      status: getString(params.status),
      raw: event,
    };
  }

  if (method.toLowerCase().includes('command')) {
    const commandRecord = getRecord(params.command);
    const commandSource = commandRecord ?? item;
    return {
      type: 'command',
      id: getEventId(event),
      command:
        typeof params.command === 'string'
          ? params.command
          : getString(
              commandSource?.command ??
                commandSource?.cmd ??
                params.commandText,
            ),
      exitCode: getNumber(params.exitCode ?? commandSource?.exitCode),
      status: getString(params.status ?? commandSource?.status),
      outputPreview: getString(
        params.output ??
          params.outputPreview ??
          commandSource?.output ??
          commandSource?.outputPreview ??
          commandSource?.stdout ??
          commandSource?.stderr,
      ),
      raw: event,
    };
  }

  if (
    method.toLowerCase().includes('diff') ||
    method.toLowerCase().includes('filechange')
  ) {
    const diffRecord = getRecord(params.diff);
    const diffSource = diffRecord ?? item;
    return {
      type: 'diff',
      id: getEventId(event),
      path: getString(
        params.path ?? params.filePath ?? diffSource?.path ?? diffSource?.filePath,
      ),
      added: getNumber(params.added ?? diffSource?.added),
      removed: getNumber(params.removed ?? diffSource?.removed),
      status: getString(params.status ?? diffSource?.status),
      raw: event,
    };
  }

  return {
    type: 'raw',
    id: getEventId(event),
    method,
    raw: event,
  };
}

export function codexResultToMessage<TAttrs extends Attrs = Attrs>(
  result: CodexTurnResult,
  attrsKey = 'codex',
): Message<TAttrs> {
  return {
    type: 'assistant',
    content: extractCodexFinalAnswer(result) || ' ',
    attrs: {
      [attrsKey]: result,
    } as TAttrs,
  };
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return (
    typeof value === 'object' && value !== null && Symbol.asyncIterator in value
  );
}

function extractTextFromUnknown(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const itemType = record.type ?? record.kind;
  const content = record.content ?? record.text ?? record.message;

  if (
    (itemType === undefined ||
      itemType === 'agentMessage' ||
      itemType === 'message') &&
    typeof content === 'string'
  ) {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map(extractTextFromUnknown).filter(Boolean).join('');
  }

  return undefined;
}

function getTurnIdFromNotification(
  message: CodexTurnEvent,
): string | undefined {
  const params = message.params ?? {};
  const turn = params.turn as { id?: unknown } | undefined;
  const item = params.item as { turnId?: unknown } | undefined;

  if (typeof params.turnId === 'string') {
    return params.turnId;
  }
  if (typeof turn?.id === 'string') {
    return turn.id;
  }
  if (typeof item?.turnId === 'string') {
    return item.turnId;
  }
  return undefined;
}

function getDeltaText(params: Record<string, unknown>): string | undefined {
  for (const key of ['delta', 'text', 'content']) {
    const value = params[key];
    if (typeof value === 'string') {
      return value;
    }
  }

  const delta = params.delta as Record<string, unknown> | undefined;
  if (delta && typeof delta.text === 'string') {
    return delta.text;
  }

  return undefined;
}

function getEventId(event: CodexTurnEvent): string {
  const params = event.params ?? {};
  const turnId = getTurnIdFromNotification(event);
  const item = getRecord(params.item);
  const id =
    params.id ??
    params.itemId ??
    item?.id ??
    event.id ??
    turnId ??
    event.method ??
    event.type ??
    'codex-event';
  return String(id);
}

function getItemId(
  item: Record<string, unknown> | undefined,
  event: CodexTurnEvent,
): string {
  return getString(item?.id) ?? getEventId(event);
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function getCodexApprovalAction(method: string): string | undefined {
  const normalized = method.toLowerCase();
  if (method === 'tool/requestUserInput') {
    return 'userInput';
  }
  if (!normalized.includes('approval')) {
    return undefined;
  }
  if (normalized.includes('commandexecution')) {
    return 'commandExecution';
  }
  if (normalized.includes('filechange')) {
    return 'fileChange';
  }
  if (normalized.includes('userinput')) {
    return 'userInput';
  }
  return undefined;
}

function getCodexToolCallName(
  params: Record<string, unknown> | undefined,
): string | undefined {
  if (!params) {
    return undefined;
  }
  const tool = params.tool as Record<string, unknown> | undefined;
  return getString(params.name ?? params.toolName ?? tool?.name);
}

function getCodexToolCallInput(
  params: Record<string, unknown> | undefined,
): unknown {
  if (!params) {
    return {};
  }
  return params.input ?? params.arguments ?? params.args ?? {};
}

function formatUnknownError(error: unknown): string {
  if (!error) {
    return 'unknown error';
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message;
    }
  }
  return JSON.stringify(error);
}
