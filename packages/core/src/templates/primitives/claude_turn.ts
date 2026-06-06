import {
  buildClaudeAgentQueryParams,
  claudeAgentResultToMessage,
  collectClaudeAgentTurnResult,
  createDefaultClaudeAgentClient,
  materializeClaudeAgentSkills,
  type ClaudeTurnOptions,
} from '../../claude_agent';
import {
  createConversationHistoryFingerprint,
  deriveConversationBinding,
} from '../../conversation';
import { requireConfiguredCapabilityApprovals } from '../../capabilities';
import type { Session } from '../../session';
import { Attrs, Vars } from '../../session';
import { TemplateBase } from '../base';

export class ClaudeTurn<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> extends TemplateBase<TAttrs, TVars> {
  constructor(private readonly options: ClaudeTurnOptions<TAttrs, TVars>) {
    super();
  }

  async execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const currentSession = this.ensureSession(session);
    const client =
      this.options.client ?? (await createDefaultClaudeAgentClient());
    const prompt = await this.resolveInput(currentSession);
    const sessionId = await this.resolveSessionId(currentSession);
    await materializeClaudeAgentSkills({
      capabilities: this.options.capabilities,
      cwd: this.options.cwd,
      approvalHandler: this.options.approvalHandler,
      session: currentSession,
    });
    await requireConfiguredCapabilityApprovals(
      getClaudeConfiguredApprovalCapabilities(this.options.capabilities),
      {
        provider: 'claude-agent',
        session: currentSession,
        approvalHandler: this.options.approvalHandler,
      },
    );
    const params = buildClaudeAgentQueryParams(prompt, currentSession, {
      cwd: this.options.cwd,
      model: this.options.model,
      allowedTools: this.options.allowedTools,
      disallowedTools: this.options.disallowedTools,
      sessionId,
      permissionMode: this.options.permissionMode,
      settingSources: this.options.settingSources,
      skills: this.options.skills,
      capabilities: this.options.capabilities,
      approvalHandler: this.options.approvalHandler,
      retain: this.options.retain,
      retainMessages: this.options.retainMessages,
      attrsKey: this.options.attrsKey,
      sdkOptions: this.options.sdkOptions,
    });
    const result = this.prepareSessionResult(
      await collectClaudeAgentTurnResult(
        client.query(params),
        this.options.onEvent,
      ),
    );

    if (this.options.squashWith) {
      return this.options.squashWith(currentSession, result);
    }

    if (this.options.retainMessages === false) {
      return currentSession.withVar(
        this.options.attrsKey ?? 'claudeAgent',
        result,
      );
    }

    const attrsKey = this.options.attrsKey ?? 'claudeAgent';
    const message = claudeAgentResultToMessage<TAttrs>(result, attrsKey);
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
  }

  private async resolveInput(session: Session<TVars, TAttrs>): Promise<string> {
    if (this.options.input === undefined) {
      return session.getLastMessage()?.content ?? '';
    }

    if (typeof this.options.input === 'function') {
      return this.options.input(session);
    }

    return this.options.input;
  }

  private async resolveSessionId(
    session: Session<TVars, TAttrs>,
  ): Promise<string | undefined> {
    if (
      this.options.sessionId === undefined ||
      this.options.sessionId === 'new'
    ) {
      return undefined;
    }
    if (this.options.sessionId === 'auto') {
      return deriveConversationBinding(session, 'claude-agent')?.id;
    }
    if (typeof this.options.sessionId === 'function') {
      return this.options.sessionId(session);
    }

    return this.options.sessionId;
  }

  private prepareSessionResult(
    result: Awaited<ReturnType<typeof collectClaudeAgentTurnResult>>,
  ) {
    const retain = this.options.retain ?? 'summary';
    if (retain === 'full') {
      return result;
    }

    const { raw: _raw, events, ...rest } = result;
    if (retain === 'none') {
      return { ...rest, events: [] };
    }

    return {
      ...rest,
      events: summarizeClaudeAgentEvents(events),
    };
  }
}

function getClaudeConfiguredApprovalCapabilities(
  capabilities: ClaudeTurnOptions['capabilities'],
): ClaudeTurnOptions['capabilities'] {
  return (capabilities ?? []).filter(
    (capability) => capability.kind === 'mcp' || capability.kind === 'builtin',
  );
}

function summarizeClaudeAgentEvents(events: readonly unknown[]) {
  return events.map((event, index) => {
    const record =
      typeof event === 'object' && event !== null
        ? (event as Record<string, unknown>)
        : {};
    const previewSource =
      typeof record.result === 'string'
        ? record.result
        : typeof record.text === 'string'
          ? record.text
          : undefined;
    return {
      type: record.type ?? 'raw',
      id: record.id ?? String(index),
      status: record.status,
      preview: previewSource?.slice(0, 500),
      truncated: previewSource && previewSource.length > 500 ? true : undefined,
      fullLength:
        previewSource && previewSource.length > 500
          ? previewSource.length
          : undefined,
    };
  });
}
