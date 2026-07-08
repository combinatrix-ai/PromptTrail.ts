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
import {
  DEFAULT_PROVIDER_TURN_RESTART_NOTICE,
  ProviderTurnUnresumableError,
  type ProviderSessionBinding,
} from '../../provider_session';
import {
  REPLAY_GO_LIVE,
  requireConfiguredCapabilityApprovals,
} from '../../capabilities';
import { retainRuntimeEvents } from '../../runtime';
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

export class CodexTurn<TVars extends Vars = Vars> extends TemplateBase<TVars> {
  constructor(private readonly options: CodexTurnOptions<TVars>) {
    super();
  }

  getManifestDescriptor() {
    return {
      kind: 'template',
      templateType: 'CodexTurn',
      options: {
        ...this.options,
        client: objectStandIn(this.options.client),
        // Arbitrary config bags can carry secrets (transport env, raw
        // thread/turn params); the manifest is persisted with the run, so
        // reduce them to edit-detecting digests instead of plaintext.
        transport: manifestConfigDigest(this.options.transport),
        threadStart: manifestConfigDigest(this.options.threadStart),
        turnStart: manifestConfigDigest(this.options.turnStart),
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
   * Execute the Codex turn without routing through the template adapter
   * entrypoint. GraphExecutor uses this to keep codexTurn graph nodes out of
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
      assertTurnCommandSupported(beforeModel.command, 'CodexTurn');
      currentSession = beforeModel.session;
    }
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
            services: runtime?.services,
          })
        : this.options.onRequest;
    // Per-provider request metadata folded into the recorded requestDigest and
    // recomputed identically at replay time for `request-hash` keying (B2).
    const codexRequestMeta = {
      model: this.options.model,
      cwd: this.options.cwd,
      sandboxPolicy: this.options.sandboxPolicy,
      approvalPolicy: this.options.approvalPolicy,
    };
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
      assertTurnCommandSupported(prepared.command, 'CodexTurn');
      assertPrepareModelInputDidNotPersistSession(prepared.steps, 'CodexTurn');
      runtime.middlewareState = prepared.middlewareState;
      runtime.version = prepared.afterVersion;
      modelSession =
        (prepared.request as TurnModelRequest<TVars> | undefined)?.session ??
        modelSession;
    }

    let openModelEvents = 0;
    const executeProviderCall = async ({
      request,
    }: {
      request: TurnModelRequest<TVars>;
    }) => {
      // B1 replay: short-circuit the Codex provider turn with the recorded
      // aggregate output (node-output granularity). Faithful raw replay needs
      // retain: 'full' so the recorded response equals the raw turn result.
      if (runtime?.replay) {
        const served = runtime.replay.model({
          nodePath:
            options.nodePath ??
            runtime.recorder?.currentNodePath ??
            'codexTurn',
          provider: 'codex',
          requestSession: modelSession,
          requestMeta: codexRequestMeta,
        });
        // Acceptance `miss: 'live'` (design §4): fall through to the real Codex
        // turn below when the cassette could not serve this call.
        if (served !== REPLAY_GO_LIVE) {
          return served as Awaited<ReturnType<typeof collectCodexTurnResult>>;
        }
      }
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
        if (await emitTurnModelEvent(runtime, 'model.started', 'codexTurn')) {
          openModelEvents++;
        }
        const runtimeSkills = await resolveCodexRuntimeSkills(
          client,
          rawRuntimeSkills,
        );
        const checkpointBinding = request.ignoreCheckpointBinding
          ? undefined
          : this.resolveCheckpointBinding(runtime, options.nodePath);
        const resolvedThreadId = checkpointBinding
          ? checkpointBinding.id
          : await this.resolveThreadId(request.session, runtime?.services);
        const input = await this.resolveInput(
          request.session,
          runtime?.services,
        );
        const inputWithRestartNotice =
          request.restartNotice === undefined
            ? input
            : prependCodexRestartNotice(input, request.restartNotice);
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
        const restarts = request.restarts ?? checkpointBinding?.restarts ?? 0;
        await this.recordProviderSession(runtime, options.nodePath, {
          provider: 'codex',
          id: threadId,
          restarts,
        });

        const rawTurnResult = await client.startTurn({
          threadId,
          input: normalizeCodexInput(inputWithRestartNotice, runtimeSkills),
          cwd: this.options.cwd,
          model: this.options.model,
          sandboxPolicy: this.options.sandboxPolicy,
          approvalPolicy: this.options.approvalPolicy,
          ...(this.options.turnStart ?? {}),
        });
        return collectCodexTurnResult(
          rawTurnResult,
          { threadId },
          this.options.onEvent,
        );
      } finally {
        if (ownsClient) {
          await client.close?.();
        }
      }
    };
    const closeModelEvents = async (
      type: 'model.completed' | 'model.failed',
      error?: unknown,
    ) => {
      while (openModelEvents > 0) {
        openModelEvents--;
        await emitTurnModelEvent(runtime, type, 'codexTurn', error);
      }
    };

    let result: Awaited<ReturnType<typeof collectCodexTurnResult>>;
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
        assertTurnCommandSupported(wrappedModel.command, 'CodexTurn');
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
      assertTurnCommandSupported(afterModel.command, 'CodexTurn');
      currentSession = afterModel.session;
      result = (afterModel.result ?? result) as typeof result;
    }
    const sessionResult = this.prepareSessionResult(result);

    // B0 model capture (Appendix B0 work item 4). Codex uses its own normalizer:
    // the TurnModelRequest session + provider config digest, provider = 'codex'.
    // One record per wrapModelCall invocation (internal vendor rounds aggregate
    // into `sessionResult`). Faithful raw replay needs retain: 'full'.
    const codexRecorder = runtime?.recorder;
    if (codexRecorder) {
      codexRecorder.model({
        nodePath:
          options.nodePath ?? codexRecorder.currentNodePath ?? 'codexTurn',
        provider: 'codex',
        requestSession: modelSession,
        requestMeta: codexRequestMeta,
        response: sessionResult,
      });
    }

    let nextSession: Session<TVars>;
    if (this.options.squashWith) {
      nextSession = await this.options.squashWith(currentSession, result);
    } else if (this.options.retainMessages === false) {
      nextSession = currentSession.withVar(
        this.options.attrsKey ?? 'codex',
        sessionResult,
      );
    } else {
      const attrsKey = this.options.attrsKey ?? 'codex';
      const message = codexResultToMessage(sessionResult, attrsKey);
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

  private async resolveThreadId(
    session: Session<TVars>,
    services: Record<string, unknown> | undefined,
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
      return this.options.threadId(session, services);
    }

    return this.options.threadId;
  }

  private resolveCheckpointBinding(
    runtime: ExecutionRuntimeState<TVars> | undefined,
    nodePath: string | undefined,
  ): ProviderSessionBinding | undefined {
    if (!runtime?.recordProviderSession || !nodePath) {
      return undefined;
    }
    const binding = runtime.providerSessions?.[nodePath];
    return binding?.provider === 'codex' ? binding : undefined;
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
    }) => Promise<Awaited<ReturnType<typeof collectCodexTurnResult>>>,
    closeFailedAttempt: (error: unknown) => Promise<void>,
  ) {
    const checkpointBinding = this.resolveCheckpointBinding(runtime, nodePath);
    const callWrappedModel = (request: TurnModelRequest<TVars>) =>
      runRuntimeMiddlewareWrapper<
        TVars,
        TurnModelRequest<TVars>,
        Awaited<ReturnType<typeof collectCodexTurnResult>>
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
        'codex',
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
          'codex',
          nodePath ?? '<unknown>',
          checkpointBinding.id,
          `codex turn at ${nodePath ?? '<unknown>'} exceeded maxRestarts (${maxRestarts}) while recovering provider session ${checkpointBinding.id}.`,
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

  private async resolveInput(
    session: Session<TVars>,
    services: Record<string, unknown> | undefined,
  ): Promise<string | unknown[] | undefined> {
    if (this.options.input === undefined) {
      return session.getLastMessage()?.content;
    }

    if (typeof this.options.input === 'function') {
      return this.options.input(session, services);
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

function prependCodexRestartNotice(
  input: string | unknown[] | undefined,
  notice: string,
): string | unknown[] {
  if (Array.isArray(input)) {
    return [{ type: 'text', text: notice }, ...input];
  }
  return input
    ? [
        { type: 'text', text: notice },
        { type: 'text', text: input },
      ]
    : notice;
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
