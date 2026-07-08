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
import {
  DEFAULT_PROVIDER_TURN_RESTART_NOTICE,
  ProviderTurnUnresumableError,
  type ProviderSessionBinding,
} from '../../provider_session';
import { requireConfiguredCapabilityApprovals } from '../../capabilities';
import type { Session, Vars } from '../../session';
import {
  runExecutionPhase,
  runRuntimeMiddlewareWrapper,
  runRuntimeExecutionPhase,
  type ExecutionPhaseStep,
  type ExecutionRuntimeState,
} from '../../interceptors';
import type { ExecutionEvent } from '../../execution';
import type { ResolvedExecutionCommand } from '../../execution';
import { manifestConfigDigest } from '../../graph';
import { TemplateBase } from '../base';

export class ClaudeTurn<TVars extends Vars = Vars> extends TemplateBase<TVars> {
  constructor(private readonly options: ClaudeTurnOptions<TVars>) {
    super();
  }

  getManifestDescriptor() {
    return {
      kind: 'template',
      templateType: 'ClaudeTurn',
      options: {
        ...this.options,
        client: objectStandIn(this.options.client),
        // sdkOptions is an arbitrary config bag that can carry secrets (env,
        // MCP server credentials); the manifest is persisted with the run, so
        // reduce it to an edit-detecting digest instead of plaintext.
        sdkOptions: manifestConfigDigest(this.options.sdkOptions),
      },
    };
  }

  async execute(
    session?: Session<TVars>,
    runtime?: ExecutionRuntimeState<TVars>,
  ): Promise<Session<TVars>> {
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
    session?: Session<TVars>,
    runtime?: ExecutionRuntimeState<TVars>,
    options: { nodePath?: string } = {},
  ): Promise<Session<TVars>> {
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
        services: runtime.services,
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
        (prepared.request as TurnModelRequest<TVars> | undefined)?.session ??
        modelSession;
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
      request: TurnModelRequest<TVars>;
    }) => {
      const client =
        this.options.client ?? (await createDefaultClaudeAgentClient());
      const prompt = prependClaudeRestartNotice(
        await this.resolveInput(request.session, runtime?.services),
        request.restartNotice,
      );
      const checkpointBinding = request.ignoreCheckpointBinding
        ? undefined
        : this.resolveCheckpointBinding(runtime, options.nodePath);
      const sessionId = checkpointBinding
        ? checkpointBinding.id
        : await this.resolveSessionId(request.session, runtime?.services);
      const restarts = request.restarts ?? checkpointBinding?.restarts ?? 0;
      if (sessionId) {
        await this.recordProviderSession(runtime, options.nodePath, {
          provider: 'claude',
          id: sessionId,
          restarts,
        });
      }
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
        services: runtime?.services,
      });
      if (await emitTurnModelEvent(runtime, 'model.started', 'claudeTurn')) {
        openModelEvents++;
      }
      return collectClaudeAgentTurnResult(
        client.query(params),
        this.options.onEvent,
        (id) =>
          this.recordProviderSession(runtime, options.nodePath, {
            provider: 'claude',
            id,
            restarts,
          }),
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
        const wrappedModel = await this.executeWithUnresumablePolicy(
          runtime,
          options.nodePath,
          currentSession,
          modelSession,
          executeProviderCall,
          (error) => closeModelEvents('model.failed', error),
        );
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

    let nextSession: Session<TVars>;
    if (this.options.squashWith) {
      nextSession = await this.options.squashWith(currentSession, result);
    } else if (this.options.retainMessages === false) {
      nextSession = currentSession.withVar(
        this.options.attrsKey ?? 'claudeAgent',
        sessionResult,
      );
    } else {
      const attrsKey = this.options.attrsKey ?? 'claudeAgent';
      const message = claudeAgentResultToMessage(sessionResult, attrsKey);
      const historyFingerprint = createConversationHistoryFingerprint([
        ...currentSession.messages,
        message,
      ]);
      nextSession = currentSession.addMessage({
        ...message,
        attrs: {
          ...message.attrs,
          [attrsKey]: {
            ...(message.attrs?.[attrsKey] as unknown as
              | Record<string, unknown>
              | undefined),
            historyFingerprint,
          },
        },
      });
    }

    return nextSession;
  }

  private async resolveInput(
    session: Session<TVars>,
    services: Record<string, unknown> | undefined,
  ): Promise<string> {
    if (this.options.input === undefined) {
      return session.getLastMessage()?.content ?? '';
    }

    if (typeof this.options.input === 'function') {
      return this.options.input(session, services);
    }

    return this.options.input;
  }

  private async resolveSessionId(
    session: Session<TVars>,
    services: Record<string, unknown> | undefined,
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
      return this.options.sessionId(session, services);
    }

    return this.options.sessionId;
  }

  private resolveCheckpointBinding(
    runtime: ExecutionRuntimeState<TVars> | undefined,
    nodePath: string | undefined,
  ): ProviderSessionBinding | undefined {
    if (!runtime?.recordProviderSession || !nodePath) {
      return undefined;
    }
    const binding = runtime.providerSessions?.[nodePath];
    return binding?.provider === 'claude' ? binding : undefined;
  }

  private async recordProviderSession(
    runtime: ExecutionRuntimeState<TVars> | undefined,
    nodePath: string | undefined,
    binding: ProviderSessionBinding,
  ): Promise<void> {
    if (!runtime?.recordProviderSession || !nodePath) {
      return;
    }
    runtime.providerSessions = {
      ...(runtime.providerSessions ?? {}),
      [nodePath]: binding,
    };
    await runtime.recordProviderSession(nodePath, binding);
  }

  private async executeWithUnresumablePolicy(
    runtime: ExecutionRuntimeState<TVars>,
    nodePath: string | undefined,
    currentSession: Session<TVars>,
    modelSession: Session<TVars>,
    executeProviderCall: (input: {
      request: TurnModelRequest<TVars>;
    }) => Promise<Awaited<ReturnType<typeof collectClaudeAgentTurnResult>>>,
    closeFailedAttempt: (error: unknown) => Promise<void>,
  ) {
    const checkpointBinding = this.resolveCheckpointBinding(runtime, nodePath);
    const callWrappedModel = (request: TurnModelRequest<TVars>) =>
      runRuntimeMiddlewareWrapper<
        TVars,
        TurnModelRequest<TVars>,
        Awaited<ReturnType<typeof collectClaudeAgentTurnResult>>
      >(runtime, {
        phase: 'wrapModelCall',
        session: currentSession,
        request,
        call: executeProviderCall,
      });

    try {
      return await callWrappedModel({ session: modelSession });
    } catch (error) {
      if (!checkpointBinding || error instanceof ProviderTurnUnresumableError) {
        throw error;
      }
      await closeFailedAttempt(error);
      const unresumable = new ProviderTurnUnresumableError(
        'claude',
        nodePath ?? '<unknown>',
        checkpointBinding.id,
        undefined,
        error,
      );
      if ((this.options.onUnresumable ?? 'fail') !== 'restart') {
        throw unresumable;
      }
      const restarts = checkpointBinding.restarts + 1;
      const maxRestarts = this.options.maxRestarts ?? 1;
      if (restarts > maxRestarts) {
        throw new ProviderTurnUnresumableError(
          'claude',
          nodePath ?? '<unknown>',
          checkpointBinding.id,
          `claude turn at ${nodePath ?? '<unknown>'} exceeded maxRestarts (${maxRestarts}) while recovering provider session ${checkpointBinding.id}.`,
          error,
        );
      }
      await this.recordProviderSession(runtime, nodePath, {
        ...checkpointBinding,
        restarts,
      });
      return callWrappedModel({
        session: modelSession,
        restartNotice:
          this.options.restartNotice ?? DEFAULT_PROVIDER_TURN_RESTART_NOTICE,
        restarts,
        ignoreCheckpointBinding: true,
      });
    }
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

interface TurnModelRequest<TVars extends Vars = Vars> {
  session: Session<TVars>;
  restartNotice?: string;
  restarts?: number;
  ignoreCheckpointBinding?: boolean;
}

async function emitTurnModelEvent<TVars extends Vars = Vars>(
  runtime: ExecutionRuntimeState<TVars> | undefined,
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

function prependClaudeRestartNotice(prompt: string, notice?: string): string {
  return notice ? `${notice}\n\n${prompt}` : prompt;
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

function objectStandIn(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }
  return {
    kind: 'object',
    ctor:
      typeof value === 'object'
        ? value.constructor?.name || undefined
        : undefined,
  };
}
