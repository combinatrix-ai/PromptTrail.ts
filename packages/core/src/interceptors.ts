import {
  applyResolvedExecutionTransition,
  resolveExecutionTransition,
  type ExecutionEvent,
  type ExecutionPatch,
  type ResolvedExecutionCommand,
  type ResolvedExecutionTransition,
} from './execution';
import type { ProviderSessionBinding } from './provider_session';
import type { Recorder } from './recording';
import type { Session, Vars } from './session';

export type ExecutionLifecyclePhase =
  | 'beforeAgent'
  | 'afterAgent'
  | 'beforeTemplate'
  | 'afterTemplate'
  | 'beforeModel'
  | 'prepareModelInput'
  | 'afterModel'
  | 'beforeTool'
  | 'afterTool'
  | 'suspend'
  | 'resume';

export type ExecutionWrapperPhase = 'wrapModelCall' | 'wrapToolCall';

export type ExecutionPhase = ExecutionLifecyclePhase | ExecutionWrapperPhase;

export type HandlerDurabilityMode = 'materialized-phase' | 'replayable-handler';

export interface ExecutionDurableRetryPolicy {
  maxAttempts?: number;
}

interface ExecutionEffectDeclarationBaseOptions {
  kind?: string;
  retry?: ExecutionDurableRetryPolicy;
}

export type ExecutionEffectDeclaration =
  | (ExecutionEffectDeclarationBaseOptions & {
      idempotencyKey: string | ((input: unknown) => string);
      repeatable?: never;
    })
  | (ExecutionEffectDeclarationBaseOptions & {
      repeatable: true;
      idempotencyKey?: never;
    });

export interface ExecutionDurableBoundary {
  once<T>(
    name: string,
    dep: unknown,
    fn: () => T | Promise<T>,
    options?: { scope?: 'run' | 'conversation' },
  ): Promise<T>;
}

export interface ExecutionHandlerDescriptor {
  kind: 'middleware' | 'hook';
  name?: string;
  phase: ExecutionPhase;
  durability: HandlerDurabilityMode;
  registrationIndex: number;
}

export type ExecutionDurableBoundaryProvider = (
  handler: ExecutionHandlerDescriptor,
) => ExecutionDurableBoundary;

export interface ExecutionPhaseContext<
  TVars extends Vars = Vars,
  TRequest = unknown,
  TResult = unknown,
> {
  phase: ExecutionPhase;
  session: Session<TVars>;
  request?: TRequest;
  result?: TResult;
  services?: Record<string, unknown>;
  middlewareState: Record<string, unknown>;
  durable: ExecutionDurableBoundary;
  once: ExecutionDurableBoundary['once'];
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export type MiddlewarePhaseHandler<
  TVars extends Vars = Vars,
  TRequest = unknown,
  TResult = unknown,
> = (
  context: ExecutionPhaseContext<TVars, TRequest, TResult>,
) => ExecutionPatch<TVars> | void;

export interface ExecutionWrapperNextInput<
  TVars extends Vars = Vars,
  TRequest = unknown,
> {
  session?: Session<TVars>;
  request?: TRequest;
}

export type ExecutionWrapperNext<
  TVars extends Vars = Vars,
  TRequest = unknown,
  TResult = unknown,
> = (input?: ExecutionWrapperNextInput<TVars, TRequest>) => Promise<TResult>;

export type MiddlewareWrapperHandler<
  TVars extends Vars = Vars,
  TRequest = unknown,
  TResult = unknown,
> = (
  context: ExecutionPhaseContext<TVars, TRequest, TResult>,
  next: ExecutionWrapperNext<TVars, TRequest, TResult>,
) =>
  | ExecutionPatch<TVars>
  | TResult
  | void
  | Promise<ExecutionPatch<TVars> | TResult | void>;

export type HookPhaseHandler<
  TVars extends Vars = Vars,
  TRequest = unknown,
  TResult = unknown,
> = (
  context: ExecutionPhaseContext<TVars, TRequest, TResult>,
) => HookExecutionPatch<TVars> | void;

export type HookExecutionPatch<TVars extends Vars = Vars> = Pick<
  ExecutionPatch<TVars>,
  'session' | 'command'
>;

export interface MiddlewareDefinition<TVars extends Vars = Vars> {
  name?: string;
  /** Controls whether durable runs materialize the whole phase or replay the handler with durable helpers. */
  durability?: HandlerDurabilityMode;
  /** Required under checkpoint when wrapModelCall or wrapToolCall is defined. */
  effect?: ExecutionEffectDeclaration;
  beforeAgent?: MiddlewarePhaseHandler<TVars>;
  afterAgent?: MiddlewarePhaseHandler<TVars>;
  beforeModel?: MiddlewarePhaseHandler<TVars>;
  prepareModelInput?: MiddlewarePhaseHandler<TVars>;
  wrapModelCall?: MiddlewareWrapperHandler<TVars>;
  afterModel?: MiddlewarePhaseHandler<TVars>;
  beforeTool?: MiddlewarePhaseHandler<TVars>;
  wrapToolCall?: MiddlewareWrapperHandler<TVars>;
  afterTool?: MiddlewarePhaseHandler<TVars>;
}

export interface HookDefinition<TVars extends Vars = Vars> {
  name?: string;
  /** Controls whether durable runs materialize the whole phase or replay the handler with durable helpers. */
  durability?: HandlerDurabilityMode;
  /** Alias for the agent-level run start phase. */
  onRunStart?: HookPhaseHandler<TVars>;
  /** Alias for the agent-level run end phase. */
  onRunEnd?: HookPhaseHandler<TVars>;
  onBeforeAgent?: HookPhaseHandler<TVars>;
  onAfterAgent?: HookPhaseHandler<TVars>;
  onBeforeTemplate?: HookPhaseHandler<TVars>;
  onAfterTemplate?: HookPhaseHandler<TVars>;
  onBeforeModel?: HookPhaseHandler<TVars>;
  onAfterModel?: HookPhaseHandler<TVars>;
  onBeforeTool?: HookPhaseHandler<TVars>;
  onAfterTool?: HookPhaseHandler<TVars>;
  onSuspend?: HookPhaseHandler<TVars>;
  onResume?: HookPhaseHandler<TVars>;
}

export const Middleware = {
  create<TVars extends Vars = Vars>(
    definition: MiddlewareDefinition<TVars>,
  ): MiddlewareDefinition<TVars> {
    return definition;
  },
};

export const Hook = {
  create<TVars extends Vars = Vars>(
    definition: HookDefinition<TVars>,
  ): HookDefinition<TVars> {
    assertHookDefinitionSupported(definition);
    return definition;
  },
};

export function assertHookDefinitionSupported<TVars extends Vars>(
  definition: HookDefinition<TVars>,
): void {
  if (definition.onRunStart && definition.onBeforeAgent) {
    throw new Error(
      `Hook ${definition.name ?? '<anonymous>'} cannot define both onRunStart and onBeforeAgent.`,
    );
  }
  if (definition.onRunEnd && definition.onAfterAgent) {
    throw new Error(
      `Hook ${definition.name ?? '<anonymous>'} cannot define both onRunEnd and onAfterAgent.`,
    );
  }
}

export interface RunExecutionPhaseOptions<
  TVars extends Vars = Vars,
  TRequest = unknown,
  TResult = unknown,
> {
  phase: ExecutionLifecyclePhase;
  session: Session<TVars>;
  request?: TRequest;
  result?: TResult;
  services?: Record<string, unknown>;
  middlewareState?: Record<string, unknown>;
  middleware?: readonly MiddlewareDefinition<TVars>[];
  hooks?: readonly HookDefinition<TVars>[];
  beforeVersion?: number;
  durableBoundary?: ExecutionDurableBoundaryProvider;
  signal?: AbortSignal;
}

export interface ExecutionPhaseStep {
  kind: 'middleware' | 'hook';
  name?: string;
  phase: ExecutionPhase;
  registrationIndex: number;
  transition: ResolvedExecutionTransition;
}

export interface RunExecutionPhaseResult<
  TVars extends Vars = Vars,
  TRequest = unknown,
  TResult = unknown,
> {
  session: Session<TVars>;
  request?: TRequest;
  result?: TResult;
  middlewareState: Record<string, unknown>;
  command: ResolvedExecutionCommand;
  beforeVersion: number;
  afterVersion: number;
  steps: ExecutionPhaseStep[];
}

export interface RunMiddlewareWrapperOptions<
  TVars extends Vars = Vars,
  TRequest = unknown,
  TResult = unknown,
> {
  phase: ExecutionWrapperPhase;
  session: Session<TVars>;
  request: TRequest;
  call: (input: {
    session: Session<TVars>;
    request: TRequest;
  }) => Promise<TResult>;
  services?: Record<string, unknown>;
  middlewareState?: Record<string, unknown>;
  middleware?: readonly MiddlewareDefinition<TVars>[];
  beforeVersion?: number;
  durableBoundary?: ExecutionDurableBoundaryProvider;
  signal?: AbortSignal;
}

export interface RunMiddlewareWrapperResult<
  TVars extends Vars = Vars,
  TRequest = unknown,
  TResult = unknown,
> {
  session: Session<TVars>;
  request: TRequest;
  result: TResult;
  middlewareState: Record<string, unknown>;
  command: ResolvedExecutionCommand;
  beforeVersion: number;
  afterVersion: number;
  steps: ExecutionPhaseStep[];
}

export interface ExecutionRuntimeState<TVars extends Vars = Vars> {
  middleware: readonly MiddlewareDefinition<TVars>[];
  hooks: readonly HookDefinition<TVars>[];
  middlewareState: Record<string, unknown>;
  durableBoundary?: ExecutionDurableBoundaryProvider;
  version: number;
  services?: Record<string, unknown>;
  signal?: AbortSignal;
  emitEvent?: (event: ExecutionEvent) => Promise<void> | void;
  nextEventSeq?: () => number;
  eventScopeId?: string;
  providerSessions?: Record<string, ProviderSessionBinding>;
  recordProviderSession?: (
    nodePath: string,
    binding: ProviderSessionBinding,
  ) => Promise<void>;
  /**
   * B0 recording handle (design-docs replay-and-self-deploy.md, Appendix B0).
   * Present only when the run's `recordLevel !== 'off'`; the model funnel
   * (`executeRuntimeModelCall`, Codex/Claude turns), the tool funnel
   * (`executePromptTrailTool`), and the graph executor's node breadcrumbs all
   * capture through it when set.
   */
  recorder?: Recorder;
}

export function createExecutionRuntimeState<
  TVars extends Vars = Vars,
>(options?: {
  middleware?: readonly MiddlewareDefinition<TVars>[];
  hooks?: readonly HookDefinition<TVars>[];
  services?: Record<string, unknown>;
  durableBoundary?: ExecutionDurableBoundaryProvider;
  signal?: AbortSignal;
  emitEvent?: (event: ExecutionEvent) => Promise<void> | void;
  nextEventSeq?: () => number;
  eventScopeId?: string;
  providerSessions?: Record<string, ProviderSessionBinding>;
  recordProviderSession?: (
    nodePath: string,
    binding: ProviderSessionBinding,
  ) => Promise<void>;
  recorder?: Recorder;
}): ExecutionRuntimeState<TVars> {
  return {
    middleware: options?.middleware ?? [],
    hooks: options?.hooks ?? [],
    middlewareState: {},
    durableBoundary: options?.durableBoundary,
    version: 0,
    services: options?.services,
    signal: options?.signal,
    emitEvent: options?.emitEvent,
    nextEventSeq: options?.nextEventSeq,
    eventScopeId: options?.eventScopeId,
    providerSessions: options?.providerSessions,
    recordProviderSession: options?.recordProviderSession,
    recorder: options?.recorder,
  };
}

export function extendExecutionRuntimeState<TVars extends Vars = Vars>(
  parent: ExecutionRuntimeState<TVars> | undefined,
  extension: {
    middleware?: readonly MiddlewareDefinition<TVars>[];
    hooks?: readonly HookDefinition<TVars>[];
  },
): ExecutionRuntimeState<TVars> {
  const base = parent ?? createExecutionRuntimeState<TVars>();
  return {
    ...base,
    middleware: [...base.middleware, ...(extension.middleware ?? [])],
    hooks: [...base.hooks, ...(extension.hooks ?? [])],
  };
}

export async function runRuntimeExecutionPhase<
  TVars extends Vars = Vars,
  TRequest = unknown,
  TResult = unknown,
>(
  runtime: ExecutionRuntimeState<TVars>,
  options: {
    phase: ExecutionLifecyclePhase;
    session: Session<TVars>;
    request?: TRequest;
    result?: TResult;
    middleware?: readonly MiddlewareDefinition<TVars>[];
    hooks?: readonly HookDefinition<TVars>[];
  },
): Promise<RunExecutionPhaseResult<TVars, TRequest, TResult>> {
  const phaseResult = await runExecutionPhase({
    phase: options.phase,
    session: options.session,
    request: options.request,
    result: options.result,
    services: runtime.services,
    middlewareState: runtime.middlewareState,
    middleware: options.middleware ?? runtime.middleware,
    hooks: options.hooks ?? runtime.hooks,
    beforeVersion: runtime.version,
    durableBoundary: runtime.durableBoundary,
    signal: runtime.signal,
  });
  runtime.middlewareState = phaseResult.middlewareState;
  runtime.version = phaseResult.afterVersion;
  await emitPhaseStepEvents(runtime, phaseResult.steps);
  return phaseResult;
}

export async function runRuntimeMiddlewareWrapper<
  TVars extends Vars = Vars,
  TRequest = unknown,
  TResult = unknown,
>(
  runtime: ExecutionRuntimeState<TVars>,
  options: {
    phase: ExecutionWrapperPhase;
    session: Session<TVars>;
    request: TRequest;
    call: (input: {
      session: Session<TVars>;
      request: TRequest;
    }) => Promise<TResult>;
    middleware?: readonly MiddlewareDefinition<TVars>[];
  },
): Promise<RunMiddlewareWrapperResult<TVars, TRequest, TResult>> {
  const wrapperResult = await runMiddlewareWrapper({
    phase: options.phase,
    session: options.session,
    request: options.request,
    call: options.call,
    services: runtime.services,
    middlewareState: runtime.middlewareState,
    middleware: options.middleware ?? runtime.middleware,
    beforeVersion: runtime.version,
    durableBoundary: runtime.durableBoundary,
    signal: runtime.signal,
  });
  runtime.middlewareState = wrapperResult.middlewareState;
  runtime.version = wrapperResult.afterVersion;
  await emitPhaseStepEvents(runtime, wrapperResult.steps);
  return wrapperResult;
}

async function emitPhaseStepEvents<TVars extends Vars = Vars>(
  runtime: ExecutionRuntimeState<TVars>,
  steps: readonly ExecutionPhaseStep[],
): Promise<void> {
  if (!runtime.emitEvent || !runtime.nextEventSeq) {
    return;
  }
  for (const step of steps) {
    if (step.transition.beforeVersion === step.transition.afterVersion) {
      continue;
    }
    const seq = runtime.nextEventSeq();
    const idempotencyKey = executionPhaseEventIdempotencyKey(
      runtime,
      step,
      seq,
    );
    await runtime.emitEvent({
      id: `phase:${seq}`,
      type: 'session.patched',
      at: new Date().toISOString(),
      seq,
      phase: step.phase,
      idempotencyKey,
      sessionVersion: step.transition.afterVersion,
      source: step.kind,
      raw: {
        kind: step.kind,
        name: step.name,
        registrationIndex: step.registrationIndex,
        beforeVersion: step.transition.beforeVersion,
        afterVersion: step.transition.afterVersion,
        command: step.transition.command,
      },
    });
  }
}

function executionPhaseEventIdempotencyKey<TVars extends Vars = Vars>(
  runtime: ExecutionRuntimeState<TVars>,
  step: ExecutionPhaseStep,
  seq: number,
): string {
  return [
    runtime.eventScopeId ?? 'direct',
    'phase',
    seq,
    'session.patched',
    step.phase,
    step.kind,
    step.registrationIndex,
    step.name ?? '<anonymous>',
  ].join(':');
}

export async function runExecutionPhase<
  TVars extends Vars = Vars,
  TRequest = unknown,
  TResult = unknown,
>(
  options: RunExecutionPhaseOptions<TVars, TRequest, TResult>,
): Promise<RunExecutionPhaseResult<TVars, TRequest, TResult>> {
  throwIfAborted(options.signal);
  let session = options.session;
  let request = options.request;
  let result = options.result;
  let middlewareState = { ...(options.middlewareState ?? {}) };
  let version = options.beforeVersion ?? 0;
  let command: ResolvedExecutionCommand = { type: 'none' };
  const steps: ExecutionPhaseStep[] = [];
  const handlerServices = sanitizeExecutionHandlerServices(options.services);

  for (const [registrationIndex, middleware] of (
    options.middleware ?? []
  ).entries()) {
    throwIfAborted(options.signal);
    const handler = middlewareHandlerForPhase(middleware, options.phase);
    if (!handler) {
      continue;
    }
    const descriptor: ExecutionHandlerDescriptor = {
      kind: 'middleware',
      name: middleware.name,
      phase: options.phase,
      durability: middleware.durability ?? 'materialized-phase',
      registrationIndex,
    };
    const durable = durableBoundaryForHandler(
      descriptor,
      options.durableBoundary,
    );
    const patch = handler({
      phase: options.phase,
      session,
      request,
      result,
      services: handlerServices,
      middlewareState,
      durable,
      once: durable.once.bind(durable),
      signal: options.signal,
    });
    assertSynchronousPhaseResult(patch, descriptor);
    throwIfAborted(options.signal);
    if (!patch) {
      continue;
    }
    const applied = applyPhasePatch(session, middlewareState, patch, version);
    session = applied.session;
    middlewareState = applied.middlewareState;
    if (patch && 'request' in patch) {
      request = patch.request as TRequest | undefined;
    }
    if (patch && 'result' in patch) {
      result = patch.result as TResult | undefined;
    }
    version = applied.transition.afterVersion;
    steps.push({
      kind: 'middleware',
      name: middleware.name,
      phase: options.phase,
      registrationIndex,
      transition: applied.transition,
    });
    if (applied.transition.command.type !== 'none') {
      command = applied.transition.command;
      return {
        session,
        request,
        result,
        middlewareState,
        command,
        beforeVersion: options.beforeVersion ?? 0,
        afterVersion: version,
        steps,
      };
    }
  }

  for (const [registrationIndex, hook] of (options.hooks ?? []).entries()) {
    throwIfAborted(options.signal);
    const handler = hookHandlerForPhase(hook, options.phase);
    if (!handler) {
      continue;
    }
    const descriptor: ExecutionHandlerDescriptor = {
      kind: 'hook',
      name: hook.name,
      phase: options.phase,
      durability: hook.durability ?? 'materialized-phase',
      registrationIndex,
    };
    const durable = durableBoundaryForHandler(
      descriptor,
      options.durableBoundary,
    );
    const patch = handler({
      phase: options.phase,
      session,
      request,
      result,
      services: handlerServices,
      middlewareState,
      durable,
      once: durable.once.bind(durable),
      signal: options.signal,
    });
    assertSynchronousPhaseResult(patch, descriptor);
    throwIfAborted(options.signal);
    assertHookPatchAuthority(hook.name, options.phase, patch);
    if (!patch) {
      continue;
    }
    const applied = applyPhasePatch(session, middlewareState, patch, version);
    session = applied.session;
    middlewareState = applied.middlewareState;
    version = applied.transition.afterVersion;
    steps.push({
      kind: 'hook',
      name: hook.name,
      phase: options.phase,
      registrationIndex,
      transition: applied.transition,
    });
    if (applied.transition.command.type !== 'none') {
      command = applied.transition.command;
      return {
        session,
        request,
        result,
        middlewareState,
        command,
        beforeVersion: options.beforeVersion ?? 0,
        afterVersion: version,
        steps,
      };
    }
  }

  return {
    session,
    request,
    result,
    middlewareState,
    command,
    beforeVersion: options.beforeVersion ?? 0,
    afterVersion: version,
    steps,
  };
}

export async function runMiddlewareWrapper<
  TVars extends Vars = Vars,
  TRequest = unknown,
  TResult = unknown,
>(
  options: RunMiddlewareWrapperOptions<TVars, TRequest, TResult>,
): Promise<RunMiddlewareWrapperResult<TVars, TRequest, TResult>> {
  throwIfAborted(options.signal);
  let middlewareState = { ...(options.middlewareState ?? {}) };
  let version = options.beforeVersion ?? 0;
  let command: ResolvedExecutionCommand = { type: 'none' };
  const steps: ExecutionPhaseStep[] = [];
  const middleware = options.middleware ?? [];
  const handlerServices = sanitizeExecutionHandlerServices(options.services);

  const invoke = async (
    index: number,
    session: Session<TVars>,
    request: TRequest,
  ): Promise<{
    session: Session<TVars>;
    request: TRequest;
    result: TResult;
  }> => {
    throwIfAborted(options.signal);
    if (index >= middleware.length) {
      return {
        session,
        request,
        result: await options.call({ session, request }),
      };
    }

    const definition = middleware[index];
    const handler = definition[options.phase] as
      | MiddlewareWrapperHandler<TVars, TRequest, TResult>
      | undefined;
    if (!handler) {
      return invoke(index + 1, session, request);
    }

    let nextOutcome:
      | {
          session: Session<TVars>;
          request: TRequest;
          result: TResult;
        }
      | undefined;
    const next: ExecutionWrapperNext<TVars, TRequest, TResult> = async (
      input,
    ) => {
      nextOutcome = await invoke(
        index + 1,
        input?.session ?? session,
        input?.request ?? request,
      );
      return nextOutcome.result;
    };

    const descriptor: ExecutionHandlerDescriptor = {
      kind: 'middleware',
      name: definition.name,
      phase: options.phase,
      durability: definition.durability ?? 'materialized-phase',
      registrationIndex: index,
    };
    const durable = durableBoundaryForHandler(
      descriptor,
      options.durableBoundary,
      definition.effect !== undefined,
    );
    const idempotencyKey = resolveExecutionEffectKey(
      definition.effect,
      request,
    );
    const context: ExecutionPhaseContext<TVars, TRequest, TResult> = {
      phase: options.phase,
      session,
      request,
      services: handlerServices,
      middlewareState,
      durable,
      once: durable.once.bind(durable),
      idempotencyKey,
      signal: options.signal,
    };
    const callHandler = () => handler(context, next);
    const returned =
      idempotencyKey === undefined
        ? await callHandler()
        : await durable.once(
            wrapperEffectMemoName(descriptor),
            idempotencyKey,
            callHandler,
          );
    throwIfAborted(options.signal);
    const patch = normalizeWrapperReturn<TVars, TResult>(returned);
    const baseSession = nextOutcome?.session ?? session;
    const applied = applyPhasePatch(
      baseSession,
      middlewareState,
      patch,
      version,
    );
    middlewareState = applied.middlewareState;
    version = applied.transition.afterVersion;
    if (Object.keys(patch).length > 0) {
      steps.push({
        kind: 'middleware',
        name: definition.name,
        phase: options.phase,
        registrationIndex: index,
        transition: applied.transition,
      });
    }
    if (applied.transition.command.type !== 'none') {
      command = applied.transition.command;
      const commandResult =
        'result' in patch ? patch.result : nextOutcome?.result;
      return {
        session: applied.session,
        request: (patch.request as TRequest | undefined) ?? request,
        result: commandResult as TResult,
      };
    }

    const nextRequest =
      (patch.request as TRequest | undefined) ??
      nextOutcome?.request ??
      request;
    if ('result' in patch) {
      return {
        session: applied.session,
        request: nextRequest,
        result: patch.result as TResult,
      };
    }
    if (nextOutcome) {
      return {
        session: applied.session,
        request: nextRequest,
        result: nextOutcome.result,
      };
    }
    return invoke(index + 1, applied.session, nextRequest);
  };

  const outcome = await invoke(0, options.session, options.request);
  return {
    ...outcome,
    middlewareState,
    command,
    beforeVersion: options.beforeVersion ?? 0,
    afterVersion: version,
    steps,
  };
}

function sanitizeExecutionHandlerServices(
  services: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!services || !hasSideEffectingServiceHandle(services)) {
    return services;
  }
  const {
    delivery: _delivery,
    deliveryBindings: _deliveryBindings,
    observerDeliveryBindings: _observerDeliveryBindings,
    platformBinding: _platformBinding,
    platformBindings: _platformBindings,
    ...rest
  } = services;
  return rest;
}

function hasSideEffectingServiceHandle(
  services: Record<string, unknown>,
): boolean {
  return (
    'delivery' in services ||
    'deliveryBindings' in services ||
    'observerDeliveryBindings' in services ||
    'platformBinding' in services ||
    'platformBindings' in services
  );
}

function applyPhasePatch<TVars extends Vars>(
  session: Session<TVars>,
  middlewareState: Record<string, unknown>,
  patch: ExecutionPatch<TVars> | HookExecutionPatch<TVars> | void,
  beforeVersion: number,
): {
  session: Session<TVars>;
  middlewareState: Record<string, unknown>;
  transition: ResolvedExecutionTransition;
} {
  const transition = resolveExecutionTransition(session, patch ?? {}, {
    beforeVersion,
  });
  const applied = applyResolvedExecutionTransition(session, transition, {
    middlewareState,
  });
  return {
    session: applied.session,
    middlewareState: applied.middlewareState,
    transition,
  };
}

function normalizeWrapperReturn<TVars extends Vars, TResult>(
  returned: ExecutionPatch<TVars> | TResult | void,
): ExecutionPatch<TVars> {
  if (returned === undefined) {
    return {};
  }
  if (isExecutionPatch(returned)) {
    return returned as ExecutionPatch<TVars>;
  }
  return { result: returned };
}

function isExecutionPatch<TVars extends Vars>(
  value: ExecutionPatch<TVars> | unknown,
): value is ExecutionPatch<TVars> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return (
    'session' in value ||
    'request' in value ||
    'result' in value ||
    'command' in value
  );
}

function hookHandlerForPhase<TVars extends Vars>(
  hook: HookDefinition<TVars>,
  phase: ExecutionLifecyclePhase,
): HookPhaseHandler<TVars> | undefined {
  assertHookDefinitionSupported(hook);
  switch (phase) {
    case 'beforeAgent':
      return hook.onRunStart ?? hook.onBeforeAgent;
    case 'afterAgent':
      return hook.onRunEnd ?? hook.onAfterAgent;
    case 'beforeTemplate':
      return hook.onBeforeTemplate;
    case 'afterTemplate':
      return hook.onAfterTemplate;
    case 'beforeModel':
      return hook.onBeforeModel;
    case 'afterModel':
      return hook.onAfterModel;
    case 'beforeTool':
      return hook.onBeforeTool;
    case 'afterTool':
      return hook.onAfterTool;
    case 'suspend':
      return hook.onSuspend;
    case 'resume':
      return hook.onResume;
    case 'prepareModelInput':
      return undefined;
  }
}

function middlewareHandlerForPhase<TVars extends Vars>(
  middleware: MiddlewareDefinition<TVars>,
  phase: ExecutionLifecyclePhase,
): MiddlewarePhaseHandler<TVars> | undefined {
  switch (phase) {
    case 'beforeAgent':
      return middleware.beforeAgent;
    case 'afterAgent':
      return middleware.afterAgent;
    case 'beforeTemplate':
    case 'afterTemplate':
      return undefined;
    case 'beforeModel':
      return middleware.beforeModel;
    case 'prepareModelInput':
      return middleware.prepareModelInput;
    case 'afterModel':
      return middleware.afterModel;
    case 'beforeTool':
      return middleware.beforeTool;
    case 'afterTool':
      return middleware.afterTool;
    case 'suspend':
    case 'resume':
      return undefined;
  }
}

function assertHookPatchAuthority<TVars extends Vars>(
  hookName: string | undefined,
  phase: ExecutionLifecyclePhase,
  patch: HookExecutionPatch<TVars> | void,
): void {
  if (!patch) {
    return;
  }
  const escaped = patch as ExecutionPatch<TVars>;
  if ('request' in escaped || 'result' in escaped) {
    throw new Error(
      `Hook ${hookName ?? '<anonymous>'} cannot return request/result patches in ${phase}. Use middleware for request/result transformations.`,
    );
  }
}

function durableBoundaryForHandler(
  handler: ExecutionHandlerDescriptor,
  provider: ExecutionDurableBoundaryProvider | undefined,
  forceReplayable = false,
): ExecutionDurableBoundary {
  const label = `${handler.kind} ${handler.name ?? '<anonymous>'} ${handler.phase}`;
  if (forceReplayable || handler.durability === 'replayable-handler') {
    return provider?.(handler) ?? unavailableDurableBoundary(label);
  }
  return materializedDurableBoundary(label);
}

function materializedDurableBoundary(label: string): ExecutionDurableBoundary {
  return rejectingDurableBoundary(label, 'materialized-phase');
}

function unavailableDurableBoundary(label: string): ExecutionDurableBoundary {
  return rejectingDurableBoundary(label, 'unavailable');
}

function rejectingDurableBoundary(
  label: string,
  reason: 'materialized-phase' | 'unavailable',
): ExecutionDurableBoundary {
  return {
    async once() {
      throw new Error(durableEffectError(label, reason));
    },
  };
}

function durableEffectError(
  label: string,
  reason: 'materialized-phase' | 'unavailable',
): string {
  if (reason === 'materialized-phase') {
    return `ctx.once() is not allowed in ${label}; declare durability: 'replayable-handler' to use nested durable effects.`;
  }
  return `ctx.once() is only available when ${label} runs in durable replayable-handler mode.`;
}

function assertSynchronousPhaseResult(
  value: unknown,
  handler: ExecutionHandlerDescriptor,
): void {
  if (!isThenable(value)) {
    return;
  }
  throw new Error(
    `${handler.kind} ${handler.name ?? '<anonymous>'} ${handler.phase} returned a Promise; ${handler.phase} handlers must be synchronous.`,
  );
}

function resolveExecutionEffectKey(
  effect: ExecutionEffectDeclaration | undefined,
  input: unknown,
): string | undefined {
  if (!effect || !('idempotencyKey' in effect)) {
    return undefined;
  }
  return typeof effect.idempotencyKey === 'function'
    ? effect.idempotencyKey(input)
    : effect.idempotencyKey;
}

function wrapperEffectMemoName(handler: ExecutionHandlerDescriptor): string {
  return [
    handler.kind,
    handler.name ?? '<anonymous>',
    handler.phase,
    handler.registrationIndex,
  ].join(':');
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  const error = new Error('Execution phase aborted.');
  error.name = 'AbortError';
  throw error;
}
