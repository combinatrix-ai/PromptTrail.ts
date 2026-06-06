import type { Message } from './message';
import type { Session, Attrs, Vars } from './session';
import {
  retainRuntimeEvents,
  type RetainLevel,
  type RuntimeEvent,
  type RuntimeEventSummary,
} from './runtime';
import type { CapabilitySet, PromptTrailTool } from './capabilities';
import { zodToJsonSchema, type JsonSchema } from './json_schema';
import { executePromptTrailTool, isPromptTrailTool } from './tool';

export type CodexThreadId =
  | string
  | 'new'
  | ((
      session: Session<any, any>,
    ) => string | undefined | Promise<string | undefined>);

export type CodexTurnInput =
  | string
  | unknown[]
  | ((
      session: Session<any, any>,
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

export interface CodexAppServerClient {
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

  private async request<T>(method: string, params: unknown): Promise<T> {
    const response = await this.fetchImpl(this.options.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.nextId++,
        method,
        params,
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
    | { kind: 'websocket'; url: string; timeoutMs?: number };
  cwd?: string;
  model?: string;
  sandboxPolicy?: unknown;
  approvalPolicy?: unknown;
  capabilities?: CapabilitySet;
  includeItems?: 'none' | 'summary' | 'full';
  retain?: RetainLevel;
  onEvent?: (event: RuntimeEvent) => void | Promise<void>;
  onRequest?: CodexInboundRequestHandler;
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

export function createCodexToolRequestHandler(
  tools: readonly PromptTrailTool[],
  session: Session<any, any>,
  fallback?: CodexInboundRequestHandler,
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
      raw: request.raw,
    });
  };
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
  if (method === 'item/started' || method === 'item/completed') {
    const item = params.item as Record<string, unknown> | undefined;
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

  if (method === 'item/commandExecution/requestApproval') {
    return {
      type: 'approval.requested',
      id: getEventId(event),
      action: 'commandExecution',
      status: getString(params.status),
      raw: event,
    };
  }

  if (method === 'item/fileChange/requestApproval') {
    return {
      type: 'approval.requested',
      id: getEventId(event),
      action: 'fileChange',
      status: getString(params.status),
      raw: event,
    };
  }

  if (method === 'tool/requestUserInput') {
    return {
      type: 'approval.requested',
      id: getEventId(event),
      action: 'userInput',
      status: getString(params.status),
      raw: event,
    };
  }

  if (method.includes('command')) {
    const command = params.command as
      | Record<string, unknown>
      | string
      | undefined;
    return {
      type: 'command',
      id: getEventId(event),
      command:
        typeof command === 'string'
          ? command
          : getString(command?.command ?? params.commandText),
      exitCode: getNumber(params.exitCode),
      status: getString(params.status),
      outputPreview: getString(params.output ?? params.outputPreview),
      raw: event,
    };
  }

  if (method.includes('diff') || method.includes('fileChange')) {
    return {
      type: 'diff',
      id: getEventId(event),
      path: getString(params.path),
      added: getNumber(params.added),
      removed: getNumber(params.removed),
      status: getString(params.status),
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
  const id =
    params.id ??
    params.itemId ??
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
