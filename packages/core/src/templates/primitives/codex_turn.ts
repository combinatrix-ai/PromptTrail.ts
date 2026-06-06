import {
  codexResultToMessage,
  collectCodexTurnResult,
  createCodexRuntimeRequestHandler,
  createCodexAppServerHttpClient,
  createCodexAppServerStdioClient,
  createCodexAppServerUnixSocketClient,
  createCodexAppServerWebSocketClient,
  getCodexMcpServerConfig,
  getCodexRuntimeSkills,
  getPromptTrailTools,
  promptTrailSkillToCodexInputItem,
  promptTrailToolToCodexDynamicTool,
  resolveCodexRuntimeSkills,
  type CodexTurnOptions,
} from '../../codex_app_server';
import {
  createConversationHistoryFingerprint,
  deriveConversationBinding,
} from '../../conversation';
import { requireConfiguredCapabilityApprovals } from '../../capabilities';
import { retainRuntimeEvents } from '../../runtime';
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
    const promptTrailTools = getPromptTrailTools(this.options.capabilities);
    const rawRuntimeSkills = getCodexRuntimeSkills(this.options.capabilities);
    await requireConfiguredCapabilityApprovals(
      getCodexConfiguredApprovalCapabilities(this.options.capabilities),
      {
        provider: 'codex',
        session: currentSession,
        approvalHandler: this.options.approvalHandler,
      },
    );
    const mcpServers = getCodexMcpServerConfig(this.options.capabilities);
    const onRequest =
      promptTrailTools.length > 0 || this.options.approvalHandler
        ? createCodexRuntimeRequestHandler({
            tools: promptTrailTools,
            session: currentSession,
            fallback: this.options.onRequest,
            approvalHandler: this.options.approvalHandler,
          })
        : this.options.onRequest;
    const ownsClient = this.options.client === undefined;
    const client =
      this.options.client ??
      (this.options.transport?.kind === 'http'
        ? createCodexAppServerHttpClient({ url: this.options.transport.url })
        : this.options.transport?.kind === 'stdio'
          ? createCodexAppServerStdioClient({
              command: this.options.transport.command,
              args: this.options.transport.args,
              cwd: this.options.transport.cwd,
              env: this.options.transport.env,
              timeoutMs: this.options.transport.timeoutMs,
            })
          : this.options.transport?.kind === 'unix'
            ? createCodexAppServerUnixSocketClient({
                path: this.options.transport.path,
                timeoutMs: this.options.transport.timeoutMs,
              })
            : this.options.transport?.kind === 'websocket'
              ? createCodexAppServerWebSocketClient({
                  url: this.options.transport.url,
                  timeoutMs: this.options.transport.timeoutMs,
                  onEvent: this.options.onEvent,
                  onRequest,
                })
              : undefined);

    if (!client) {
      throw new Error(
        'CodexTurn requires either a Codex App Server client or a transport URL.',
      );
    }

    try {
      const runtimeSkills = await resolveCodexRuntimeSkills(
        client,
        rawRuntimeSkills,
      );
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
            dynamicTools:
              promptTrailTools.length > 0
                ? promptTrailTools.map(promptTrailToolToCodexDynamicTool)
                : undefined,
            mcpServers,
            ...(this.options.threadStart ?? {}),
          })
        ).threadId;

      const rawTurnResult = await client.startTurn({
        threadId,
        input: normalizeCodexInput(input, runtimeSkills),
        cwd: this.options.cwd,
        model: this.options.model,
        sandboxPolicy: this.options.sandboxPolicy,
        approvalPolicy: this.options.approvalPolicy,
        ...(this.options.turnStart ?? {}),
      });
      const result = await collectCodexTurnResult(
        rawTurnResult,
        { threadId },
        this.options.onEvent,
      );
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

      const attrsKey = this.options.attrsKey ?? 'codex';
      const message = codexResultToMessage<TAttrs>(sessionResult, attrsKey);
      const historyFingerprint = createConversationHistoryFingerprint([
        ...currentSession.messages,
        message,
      ]);
      return currentSession.addMessage({
        ...message,
        attrs: {
          ...message.attrs,
          [attrsKey]: {
            ...((message.attrs as Record<string, unknown> | undefined)?.[
              attrsKey
            ] as Record<string, unknown> | undefined),
            historyFingerprint,
          },
        } as TAttrs,
      });
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
    if (this.options.threadId === 'auto') {
      return deriveConversationBinding(session, 'codex')?.id;
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
    const retain = this.options.retain ?? 'summary';
    if (retain === 'full') {
      return result;
    }

    const { items, raw: _raw, events, diff, commands, ...rest } = result;
    if (retain === 'none') {
      return rest;
    }

    return {
      ...rest,
      items: items?.map((item) => summarizeCodexItem(item)),
      events: retainRuntimeEvents(events as never, retain),
      diff: summarizeCodexArtifact(diff),
      commands: Array.isArray(commands)
        ? commands.map((command) => summarizeCodexArtifact(command))
        : undefined,
    };
  }
}

function getCodexConfiguredApprovalCapabilities(
  capabilities: CodexTurnOptions['capabilities'],
): CodexTurnOptions['capabilities'] {
  return (capabilities ?? []).filter(
    (capability) =>
      capability.kind === 'mcp' ||
      (capability.kind === 'builtin' &&
        (!capability.provider || capability.provider === 'codex')),
  );
}

function normalizeCodexInput(
  input: string | unknown[] | undefined,
  skills = [] as ReturnType<typeof getCodexRuntimeSkills>,
): string | unknown[] | undefined {
  const inputItems =
    typeof input === 'string' ? [{ type: 'text', text: input }] : input;
  if (skills.length === 0) {
    return inputItems;
  }
  return [
    ...skills.map(promptTrailSkillToCodexInputItem),
    ...(Array.isArray(inputItems) ? inputItems : []),
  ];
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
    ...summarizeTextPreview(
      typeof record.content === 'string' ? record.content : undefined,
    ),
  };
}

function summarizeCodexArtifact(artifact: unknown): unknown {
  if (artifact === undefined) {
    return undefined;
  }
  if (typeof artifact === 'string') {
    return {
      preview: artifact.slice(0, 500),
      truncated: artifact.length > 500 ? true : undefined,
      fullLength: artifact.length > 500 ? artifact.length : undefined,
    };
  }
  if (!artifact || typeof artifact !== 'object') {
    return artifact;
  }

  const record = artifact as Record<string, unknown>;
  const text =
    typeof record.output === 'string'
      ? record.output
      : typeof record.content === 'string'
        ? record.content
        : undefined;
  return {
    type: record.type ?? record.kind,
    id: record.id,
    status: record.status,
    path: record.path,
    added: record.added,
    removed: record.removed,
    command: record.command,
    exitCode: record.exitCode,
    ...summarizeTextPreview(text),
  };
}

function summarizeTextPreview(text: string | undefined): {
  preview?: string;
  truncated?: true;
  fullLength?: number;
} {
  if (text === undefined) {
    return {};
  }
  if (text.length <= 500) {
    return { preview: text };
  }
  return {
    preview: text.slice(0, 500),
    truncated: true,
    fullLength: text.length,
  };
}
