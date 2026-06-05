import type { Message } from './message';
import type { Session, Attrs, Vars } from './session';

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
  [key: string]: unknown;
}

export interface CodexTurnEvent {
  method?: string;
  type?: string;
  item?: unknown;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CodexTurnResult {
  threadId?: string;
  turnId?: string;
  status?: string;
  finalAnswer?: string;
  items?: unknown[];
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

export interface CodexTurnOptions<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> {
  threadId?: CodexThreadId;
  input?: CodexTurnInput;
  client?: CodexAppServerClient;
  transport?: { kind: 'http'; url: string };
  cwd?: string;
  model?: string;
  sandboxPolicy?: unknown;
  approvalPolicy?: unknown;
  includeItems?: 'none' | 'summary' | 'full';
  retainMessages?: boolean;
  attrsKey?: string;
  threadStart?: Record<string, unknown>;
  turnStart?: Record<string, unknown>;
  squashWith?: (
    parentSession: Session<TVars, TAttrs>,
    result: CodexTurnResult,
  ) => Session<TVars, TAttrs> | Promise<Session<TVars, TAttrs>>;
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
): Promise<CodexTurnResult> {
  if (!isAsyncIterable(turnResult)) {
    return { ...defaults, ...turnResult };
  }

  const items: unknown[] = [];
  const result: CodexTurnResult = { ...defaults, items };

  for await (const event of turnResult) {
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
