import {
  codexResultToMessage,
  collectCodexTurnResult,
  createCodexAppServerHttpClient,
  createCodexAppServerWebSocketClient,
  type CodexTurnOptions,
} from '../../codex_app_server';
import type { Session } from '../../session';
import { Attrs, Vars } from '../../session';
import { TemplateBase } from '../base';

export class CodexTurn<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> extends TemplateBase<TAttrs, TVars> {
  constructor(private readonly options: CodexTurnOptions<TAttrs, TVars>) {
    super();
  }

  async execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const currentSession = this.ensureSession(session);
    const ownsClient = this.options.client === undefined;
    const client =
      this.options.client ??
      (this.options.transport?.kind === 'http'
        ? createCodexAppServerHttpClient({ url: this.options.transport.url })
        : this.options.transport?.kind === 'websocket'
          ? createCodexAppServerWebSocketClient({
              url: this.options.transport.url,
              timeoutMs: this.options.transport.timeoutMs,
            })
          : undefined);

    if (!client) {
      throw new Error(
        'CodexTurn requires either a Codex App Server client or a transport URL.',
      );
    }

    try {
      const resolvedThreadId = await this.resolveThreadId(currentSession);
      const input = await this.resolveInput(currentSession);
      const threadId =
        resolvedThreadId ??
        (
          await client.startThread({
            cwd: this.options.cwd,
            model: this.options.model,
            sandboxPolicy: this.options.sandboxPolicy,
            approvalPolicy: this.options.approvalPolicy,
            ...(this.options.threadStart ?? {}),
          })
        ).threadId;

      const rawTurnResult = await client.startTurn({
        threadId,
        input: normalizeCodexInput(input),
        cwd: this.options.cwd,
        model: this.options.model,
        sandboxPolicy: this.options.sandboxPolicy,
        approvalPolicy: this.options.approvalPolicy,
        ...(this.options.turnStart ?? {}),
      });
      const result = await collectCodexTurnResult(rawTurnResult, { threadId });
      const sessionResult = this.prepareSessionResult(result);

      if (this.options.squashWith) {
        return this.options.squashWith(currentSession, result);
      }

      if (this.options.retainMessages === false) {
        return currentSession.withVar(
          this.options.attrsKey ?? 'codex',
          sessionResult,
        );
      }

      return currentSession.addMessage(
        codexResultToMessage<TAttrs>(sessionResult, this.options.attrsKey),
      );
    } finally {
      if (ownsClient) {
        await client.close?.();
      }
    }
  }

  private async resolveThreadId(
    session: Session<TVars, TAttrs>,
  ): Promise<string | undefined> {
    if (
      this.options.threadId === undefined ||
      this.options.threadId === 'new'
    ) {
      return undefined;
    }

    if (typeof this.options.threadId === 'function') {
      return this.options.threadId(session);
    }

    return this.options.threadId;
  }

  private async resolveInput(
    session: Session<TVars, TAttrs>,
  ): Promise<string | unknown[] | undefined> {
    if (this.options.input === undefined) {
      return session.getLastMessage()?.content;
    }

    if (typeof this.options.input === 'function') {
      return this.options.input(session);
    }

    return this.options.input;
  }

  private prepareSessionResult(
    result: Awaited<ReturnType<typeof collectCodexTurnResult>>,
  ) {
    const includeItems = this.options.includeItems ?? 'summary';
    if (includeItems === 'full') {
      return result;
    }

    const { items, raw: _raw, ...rest } = result;
    if (includeItems === 'none') {
      return rest;
    }

    return {
      ...rest,
      items: items?.map((item) => summarizeCodexItem(item)),
    };
  }
}

function normalizeCodexInput(
  input: string | unknown[] | undefined,
): string | unknown[] | undefined {
  return typeof input === 'string' ? [{ type: 'text', text: input }] : input;
}

function summarizeCodexItem(item: unknown): unknown {
  if (!item || typeof item !== 'object') {
    return item;
  }

  const record = item as Record<string, unknown>;
  return {
    type: record.type ?? record.kind,
    id: record.id,
    status: record.status,
    content:
      typeof record.content === 'string'
        ? record.content.slice(0, 500)
        : undefined,
  };
}
