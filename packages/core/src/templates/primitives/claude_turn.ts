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
import {
  runExecutionPhase,
  runRuntimeMiddlewareWrapper,
  runRuntimeExecutionPhase,
  type ExecutionPhaseStep,
  type ExecutionRuntimeState,
} from '../../interceptors';
import type { ExecutionEvent } from '../../execution';
import type { ResolvedExecutionCommand } from '../../execution';
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
    runtime?: ExecutionRuntimeState<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    return this.executeTurn(session, runtime);
  }

  /**
   * Execute the Claude turn without routing through the template adapter
   * entrypoint. GraphExecutor uses this to keep claudeTurn graph nodes out of
   * the generic template fallback while sharing the same provider semantics.
   *
   * @internal
   */
  async executeTurn(
    session?: Session<TVars, TAttrs>,
    runtime?: ExecutionRuntimeState<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    let currentSession = this.ensureSession(session);
    if (runtime) {
      const beforeModel = await runRuntimeExecutionPhase(runtime, {
        phase: 'beforeModel',
        session: currentSession,
      });
      assertTurnCommandSupported(beforeModel.command, 'ClaudeTurn');
      currentSession = beforeModel.session;
    }
    let modelSession = currentSession;
    if (runtime) {
      const prepared = await runExecutionPhase({
        phase: 'prepareModelInput',
        session: currentSession,
        request: { session: modelSession },
        context: runtime.context,
        middlewareState: runtime.middlewareState,
        middleware: runtime.middleware,
        hooks: runtime.hooks,
        beforeVersion: runtime.version,
        signal: runtime.signal,
      });
      assertTurnCommandSupported(prepared.command, 'ClaudeTurn');
      assertPrepareModelInputDidNotPersistSession(prepared.steps, 'ClaudeTurn');
      runtime.middlewareState = prepared.middlewareState;
      runtime.version = prepared.afterVersion;
      modelSession =
        (prepared.request as TurnModelRequest<TVars, TAttrs> | undefined)
          ?.session ?? modelSession;
    }
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
    let openModelEvents = 0;
    const executeProviderCall = async ({
      request,
    }: {
      request: TurnModelRequest<TVars, TAttrs>;
    }) => {
      const client =
        this.options.client ?? (await createDefaultClaudeAgentClient());
      const prompt = await this.resolveInput(request.session, runtime?.context);
      const sessionId = await this.resolveSessionId(
        request.session,
        runtime?.context,
      );
      const params = buildClaudeAgentQueryParams(prompt, request.session, {
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
        context: runtime?.context,
      });
      if (await emitTurnModelEvent(runtime, 'model.started', 'claudeTurn')) {
        openModelEvents++;
      }
      return collectClaudeAgentTurnResult(
        client.query(params),
        this.options.onEvent,
      );
    };
    const closeModelEvents = async (
      type: 'model.completed' | 'model.failed',
      error?: unknown,
    ) => {
      while (openModelEvents > 0) {
        openModelEvents--;
        await emitTurnModelEvent(runtime, type, 'claudeTurn', error);
      }
    };

    let result: Awaited<ReturnType<typeof collectClaudeAgentTurnResult>>;
    if (runtime) {
      try {
        const wrappedModel = await runRuntimeMiddlewareWrapper<
          TVars,
          TAttrs,
          TurnModelRequest<TVars, TAttrs>,
          Awaited<ReturnType<typeof collectClaudeAgentTurnResult>>
        >(runtime, {
          phase: 'wrapModelCall',
          session: currentSession,
          request: { session: modelSession },
          call: executeProviderCall,
        });
        await closeModelEvents('model.completed');
        assertTurnCommandSupported(wrappedModel.command, 'ClaudeTurn');
        currentSession = wrappedModel.session;
        result = wrappedModel.result;
      } catch (error) {
        await closeModelEvents('model.failed', error);
        throw error;
      }
    } else {
      result = await executeProviderCall({
        request: { session: modelSession },
      });
    }
    if (runtime) {
      const afterModel = await runRuntimeExecutionPhase(runtime, {
        phase: 'afterModel',
        session: currentSession,
        result,
      });
      assertTurnCommandSupported(afterModel.command, 'ClaudeTurn');
      currentSession = afterModel.session;
      result = (afterModel.result ?? result) as typeof result;
    }
    const sessionResult = this.prepareSessionResult(result);

    let nextSession: Session<TVars, TAttrs>;
    if (this.options.squashWith) {
      nextSession = await this.options.squashWith(currentSession, result);
    } else if (this.options.retainMessages === false) {
      nextSession = currentSession.withVar(
        this.options.attrsKey ?? 'claudeAgent',
        sessionResult,
      );
    } else {
      const attrsKey = this.options.attrsKey ?? 'claudeAgent';
      const message = claudeAgentResultToMessage<TAttrs>(
        sessionResult,
        attrsKey,
      );
      const historyFingerprint = createConversationHistoryFingerprint([
        ...currentSession.messages,
        message,
      ]);
      nextSession = currentSession.addMessage({
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

    return nextSession;
  }

  private async resolveInput(
    session: Session<TVars, TAttrs>,
    context: Record<string, unknown> | undefined,
  ): Promise<string> {
    if (this.options.input === undefined) {
      return session.getLastMessage()?.content ?? '';
    }

    if (typeof this.options.input === 'function') {
      return this.options.input(session, context);
    }

    return this.options.input;
  }

  private async resolveSessionId(
    session: Session<TVars, TAttrs>,
    context: Record<string, unknown> | undefined,
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
      return this.options.sessionId(session, context);
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

interface TurnModelRequest<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  session: Session<TVars, TAttrs>;
}

async function emitTurnModelEvent<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
>(
  runtime: ExecutionRuntimeState<TVars, TAttrs> | undefined,
  type: 'model.started' | 'model.completed' | 'model.failed',
  stepId: string,
  error?: unknown,
): Promise<boolean> {
  if (!runtime?.emitEvent || !runtime.nextEventSeq) {
    return false;
  }
  const seq = runtime.nextEventSeq();
  const event: ExecutionEvent = {
    id: `model:${seq}`,
    type,
    at: new Date().toISOString(),
    seq,
    replay: 'live',
    source: 'model',
    phase: 'model',
    stepId,
    idempotencyKey: `${runtime.eventScopeId ?? 'direct'}:model:${seq}:${type}`,
  };
  if (error !== undefined) {
    event.error = error;
  }
  await runtime.emitEvent(event);
  return true;
}

function assertTurnCommandSupported(
  command: ResolvedExecutionCommand,
  label: string,
): void {
  if (command.type === 'none') {
    return;
  }
  throw new Error(
    `${label}.execute does not support execution command ${command.type} yet.`,
  );
}

function assertPrepareModelInputDidNotPersistSession(
  steps: readonly ExecutionPhaseStep[],
  label: string,
): void {
  const hasSessionDelta = steps.some(({ transition }) => {
    const delta = transition.session;
    return (
      delta.messageOp.type !== 'none' ||
      Object.keys(delta.varsSet).length > 0 ||
      delta.varsDelete.length > 0
    );
  });
  if (hasSessionDelta) {
    throw new Error(
      `${label} prepareModelInput cannot return persistent session patches. Return request.session instead.`,
    );
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
