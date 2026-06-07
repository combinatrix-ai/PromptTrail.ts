import {
  applyResolvedExecutionTransition,
  resolveExecutionTransition,
  type ExecutionEvent,
  type ExecutionPatch,
  type ResolvedExecutionCommand,
  type ResolvedExecutionTransition,
} from './execution';
import type { Session, Attrs, Vars } from './session';

export type ExecutionLifecyclePhase =
  | 'beforeAgent'
  | 'afterAgent'
  | 'beforeModel'
  | 'prepareModelInput'
  | 'afterModel'
  | 'beforeTool'
  | 'afterTool';

export type ExecutionWrapperPhase = 'wrapModelCall' | 'wrapToolCall';

export type ExecutionPhase = ExecutionLifecyclePhase | ExecutionWrapperPhase;

export type HandlerDurabilityMode = 'materialized-phase' | 'replayable-handler';

export interface ExecutionPhaseContext<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
  TRequest = unknown,
  TResult = unknown,
> {
  phase: ExecutionPhase;
  session: Session<TVars, TAttrs>;
  request?: TRequest;
  result?: TResult;
  context?: Record<string, unknown>;
  middlewareState: Record<string, unknown>;
  signal?: AbortSignal;
}

export type MiddlewarePhaseHandler<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
  TRequest = unknown,
  TResult = unknown,
> = (
  context: ExecutionPhaseContext<TVars, TAttrs, TRequest, TResult>,
) =>
  | ExecutionPatch<TVars, TAttrs>
  | void
  | Promise<ExecutionPatch<TVars, TAttrs> | void>;

export interface ExecutionWrapperNextInput<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
  TRequest = unknown,
> {
  session?: Session<TVars, TAttrs>;
  request?: TRequest;
}

export type ExecutionWrapperNext<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
  TRequest = unknown,
  TResult = unknown,
> = (
  input?: ExecutionWrapperNextInput<TVars, TAttrs, TRequest>,
) => Promise<TResult>;

export type MiddlewareWrapperHandler<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
  TRequest = unknown,
  TResult = unknown,
> = (
  context: ExecutionPhaseContext<TVars, TAttrs, TRequest, TResult>,
  next: ExecutionWrapperNext<TVars, TAttrs, TRequest, TResult>,
) =>
  | ExecutionPatch<TVars, TAttrs>
  | TResult
  | void
  | Promise<ExecutionPatch<TVars, TAttrs> | TResult | void>;

export type HookPhaseHandler<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
  TRequest = unknown,
  TResult = unknown,
> = (
  context: ExecutionPhaseContext<TVars, TAttrs, TRequest, TResult>,
) =>
  | HookExecutionPatch<TVars, TAttrs>
  | void
  | Promise<HookExecutionPatch<TVars, TAttrs> | void>;

export type HookExecutionPatch<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> = Pick<ExecutionPatch<TVars, TAttrs>, 'session' | 'command'>;

export interface MiddlewareDefinition<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  name?: string;
  /**
   * Reserved for durable phase execution. The standalone runner materializes
   * returned patches but does not yet expose nested durable helpers.
   */
  durability?: HandlerDurabilityMode;
  beforeAgent?: MiddlewarePhaseHandler<TVars, TAttrs>;
  afterAgent?: MiddlewarePhaseHandler<TVars, TAttrs>;
  beforeModel?: MiddlewarePhaseHandler<TVars, TAttrs>;
  prepareModelInput?: MiddlewarePhaseHandler<TVars, TAttrs>;
  wrapModelCall?: MiddlewareWrapperHandler<TVars, TAttrs>;
  afterModel?: MiddlewarePhaseHandler<TVars, TAttrs>;
  beforeTool?: MiddlewarePhaseHandler<TVars, TAttrs>;
  wrapToolCall?: MiddlewareWrapperHandler<TVars, TAttrs>;
  afterTool?: MiddlewarePhaseHandler<TVars, TAttrs>;
}

export interface HookDefinition<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  name?: string;
  /**
   * Reserved for durable phase execution. The standalone runner materializes
   * returned patches but does not yet expose nested durable helpers.
   */
  durability?: HandlerDurabilityMode;
  onBeforeAgent?: HookPhaseHandler<TVars, TAttrs>;
  onAfterAgent?: HookPhaseHandler<TVars, TAttrs>;
  onBeforeModel?: HookPhaseHandler<TVars, TAttrs>;
  onAfterModel?: HookPhaseHandler<TVars, TAttrs>;
  onBeforeTool?: HookPhaseHandler<TVars, TAttrs>;
  onAfterTool?: HookPhaseHandler<TVars, TAttrs>;
}

export const Middleware = {
  create<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    definition: MiddlewareDefinition<TVars, TAttrs>,
  ): MiddlewareDefinition<TVars, TAttrs> {
    return definition;
  },
};

export const Hook = {
  create<TVars extends Vars = Vars, TAttrs extends Attrs = Attrs>(
    definition: HookDefinition<TVars, TAttrs>,
  ): HookDefinition<TVars, TAttrs> {
    return definition;
  },
};

export interface RunExecutionPhaseOptions<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
  TRequest = unknown,
  TResult = unknown,
> {
  phase: ExecutionLifecyclePhase;
  session: Session<TVars, TAttrs>;
  request?: TRequest;
  result?: TResult;
  context?: Record<string, unknown>;
  middlewareState?: Record<string, unknown>;
  middleware?: readonly MiddlewareDefinition<TVars, TAttrs>[];
  hooks?: readonly HookDefinition<TVars, TAttrs>[];
  beforeVersion?: number;
  signal?: AbortSignal;
}

export interface ExecutionPhaseStep<TAttrs extends Attrs = Attrs> {
  kind: 'middleware' | 'hook';
  name?: string;
  phase: ExecutionPhase;
  registrationIndex: number;
  transition: ResolvedExecutionTransition<TAttrs>;
}

export interface RunExecutionPhaseResult<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
  TRequest = unknown,
  TResult = unknown,
> {
  session: Session<TVars, TAttrs>;
  request?: TRequest;
  result?: TResult;
  middlewareState: Record<string, unknown>;
  command: ResolvedExecutionCommand;
  beforeVersion: number;
  afterVersion: number;
  steps: ExecutionPhaseStep<TAttrs>[];
}

export interface RunMiddlewareWrapperOptions<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
  TRequest = unknown,
  TResult = unknown,
> {
  phase: ExecutionWrapperPhase;
  session: Session<TVars, TAttrs>;
  request: TRequest;
  call: (input: {
    session: Session<TVars, TAttrs>;
    request: TRequest;
  }) => Promise<TResult>;
  context?: Record<string, unknown>;
  middlewareState?: Record<string, unknown>;
  middleware?: readonly MiddlewareDefinition<TVars, TAttrs>[];
  beforeVersion?: number;
  signal?: AbortSignal;
}

export interface RunMiddlewareWrapperResult<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
  TRequest = unknown,
  TResult = unknown,
> {
  session: Session<TVars, TAttrs>;
  request: TRequest;
  result: TResult;
  middlewareState: Record<string, unknown>;
  command: ResolvedExecutionCommand;
  beforeVersion: number;
  afterVersion: number;
  steps: ExecutionPhaseStep<TAttrs>[];
}

export interface ExecutionRuntimeState<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  middleware: readonly MiddlewareDefinition<TVars, TAttrs>[];
  hooks: readonly HookDefinition<TVars, TAttrs>[];
  middlewareState: Record<string, unknown>;
  version: number;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  emitEvent?: (event: ExecutionEvent) => Promise<void> | void;
  nextEventSeq?: () => number;
}

export function createExecutionRuntimeState<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
>(options?: {
  middleware?: readonly MiddlewareDefinition<TVars, TAttrs>[];
  hooks?: readonly HookDefinition<TVars, TAttrs>[];
  context?: Record<string, unknown>;
  signal?: AbortSignal;
  emitEvent?: (event: ExecutionEvent) => Promise<void> | void;
  nextEventSeq?: () => number;
}): ExecutionRuntimeState<TVars, TAttrs> {
  return {
    middleware: options?.middleware ?? [],
    hooks: options?.hooks ?? [],
    middlewareState: {},
    version: 0,
    context: options?.context,
    signal: options?.signal,
    emitEvent: options?.emitEvent,
    nextEventSeq: options?.nextEventSeq,
  };
}

export function extendExecutionRuntimeState<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
>(
  parent: ExecutionRuntimeState<TVars, TAttrs> | undefined,
  extension: {
    middleware?: readonly MiddlewareDefinition<TVars, TAttrs>[];
    hooks?: readonly HookDefinition<TVars, TAttrs>[];
  },
): ExecutionRuntimeState<TVars, TAttrs> {
  const base = parent ?? createExecutionRuntimeState<TVars, TAttrs>();
  return {
    ...base,
    middleware: [...base.middleware, ...(extension.middleware ?? [])],
    hooks: [...base.hooks, ...(extension.hooks ?? [])],
  };
}

export async function runRuntimeExecutionPhase<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
  TRequest = unknown,
  TResult = unknown,
>(
  runtime: ExecutionRuntimeState<TVars, TAttrs>,
  options: {
    phase: ExecutionLifecyclePhase;
    session: Session<TVars, TAttrs>;
    request?: TRequest;
    result?: TResult;
    middleware?: readonly MiddlewareDefinition<TVars, TAttrs>[];
    hooks?: readonly HookDefinition<TVars, TAttrs>[];
  },
): Promise<RunExecutionPhaseResult<TVars, TAttrs, TRequest, TResult>> {
  const phaseResult = await runExecutionPhase({
    phase: options.phase,
    session: options.session,
    request: options.request,
    result: options.result,
    context: runtime.context,
    middlewareState: runtime.middlewareState,
    middleware: options.middleware ?? runtime.middleware,
    hooks: options.hooks ?? runtime.hooks,
    beforeVersion: runtime.version,
    signal: runtime.signal,
  });
  runtime.middlewareState = phaseResult.middlewareState;
  runtime.version = phaseResult.afterVersion;
  await emitPhaseStepEvents(runtime, phaseResult.steps);
  return phaseResult;
}

export async function runRuntimeMiddlewareWrapper<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
  TRequest = unknown,
  TResult = unknown,
>(
  runtime: ExecutionRuntimeState<TVars, TAttrs>,
  options: {
    phase: ExecutionWrapperPhase;
    session: Session<TVars, TAttrs>;
    request: TRequest;
    call: (input: {
      session: Session<TVars, TAttrs>;
      request: TRequest;
    }) => Promise<TResult>;
    middleware?: readonly MiddlewareDefinition<TVars, TAttrs>[];
  },
): Promise<RunMiddlewareWrapperResult<TVars, TAttrs, TRequest, TResult>> {
  const wrapperResult = await runMiddlewareWrapper({
    phase: options.phase,
    session: options.session,
    request: options.request,
    call: options.call,
    context: runtime.context,
    middlewareState: runtime.middlewareState,
    middleware: options.middleware ?? runtime.middleware,
    beforeVersion: runtime.version,
    signal: runtime.signal,
  });
  runtime.middlewareState = wrapperResult.middlewareState;
  runtime.version = wrapperResult.afterVersion;
  await emitPhaseStepEvents(runtime, wrapperResult.steps);
  return wrapperResult;
}

async function emitPhaseStepEvents<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
>(
  runtime: ExecutionRuntimeState<TVars, TAttrs>,
  steps: readonly ExecutionPhaseStep<TAttrs>[],
): Promise<void> {
  if (!runtime.emitEvent || !runtime.nextEventSeq) {
    return;
  }
  for (const step of steps) {
    if (step.transition.beforeVersion === step.transition.afterVersion) {
      continue;
    }
    const seq = runtime.nextEventSeq();
    await runtime.emitEvent({
      id: `phase:${seq}`,
      type: 'session.patched',
      at: new Date().toISOString(),
      seq,
      phase: step.phase,
      replay: 'live',
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

export async function runExecutionPhase<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
  TRequest = unknown,
  TResult = unknown,
>(
  options: RunExecutionPhaseOptions<TVars, TAttrs, TRequest, TResult>,
): Promise<RunExecutionPhaseResult<TVars, TAttrs, TRequest, TResult>> {
  throwIfAborted(options.signal);
  let session = options.session;
  let request = options.request;
  let result = options.result;
  let middlewareState = { ...(options.middlewareState ?? {}) };
  let version = options.beforeVersion ?? 0;
  let command: ResolvedExecutionCommand = { type: 'none' };
  const steps: ExecutionPhaseStep<TAttrs>[] = [];

  for (const [registrationIndex, middleware] of (
    options.middleware ?? []
  ).entries()) {
    throwIfAborted(options.signal);
    const handler = middleware[options.phase];
    if (!handler) {
      continue;
    }
    const patch = await handler({
      phase: options.phase,
      session,
      request,
      result,
      context: options.context,
      middlewareState,
      signal: options.signal,
    });
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
    const patch = await handler({
      phase: options.phase,
      session,
      request,
      result,
      context: options.context,
      middlewareState,
      signal: options.signal,
    });
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
  TAttrs extends Attrs = Attrs,
  TRequest = unknown,
  TResult = unknown,
>(
  options: RunMiddlewareWrapperOptions<TVars, TAttrs, TRequest, TResult>,
): Promise<RunMiddlewareWrapperResult<TVars, TAttrs, TRequest, TResult>> {
  throwIfAborted(options.signal);
  let middlewareState = { ...(options.middlewareState ?? {}) };
  let version = options.beforeVersion ?? 0;
  let command: ResolvedExecutionCommand = { type: 'none' };
  const steps: ExecutionPhaseStep<TAttrs>[] = [];
  const middleware = options.middleware ?? [];

  const invoke = async (
    index: number,
    session: Session<TVars, TAttrs>,
    request: TRequest,
  ): Promise<{
    session: Session<TVars, TAttrs>;
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
      | MiddlewareWrapperHandler<TVars, TAttrs, TRequest, TResult>
      | undefined;
    if (!handler) {
      return invoke(index + 1, session, request);
    }

    let nextOutcome:
      | {
          session: Session<TVars, TAttrs>;
          request: TRequest;
          result: TResult;
        }
      | undefined;
    const next: ExecutionWrapperNext<TVars, TAttrs, TRequest, TResult> = async (
      input,
    ) => {
      nextOutcome = await invoke(
        index + 1,
        input?.session ?? session,
        input?.request ?? request,
      );
      return nextOutcome.result;
    };

    const returned = await handler(
      {
        phase: options.phase,
        session,
        request,
        context: options.context,
        middlewareState,
        signal: options.signal,
      },
      next,
    );
    throwIfAborted(options.signal);
    const patch = normalizeWrapperReturn<TVars, TAttrs, TResult>(returned);
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

function applyPhasePatch<TVars extends Vars, TAttrs extends Attrs>(
  session: Session<TVars, TAttrs>,
  middlewareState: Record<string, unknown>,
  patch:
    | ExecutionPatch<TVars, TAttrs>
    | HookExecutionPatch<TVars, TAttrs>
    | void,
  beforeVersion: number,
): {
  session: Session<TVars, TAttrs>;
  middlewareState: Record<string, unknown>;
  transition: ResolvedExecutionTransition<TAttrs>;
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

function normalizeWrapperReturn<
  TVars extends Vars,
  TAttrs extends Attrs,
  TResult,
>(
  returned: ExecutionPatch<TVars, TAttrs> | TResult | void,
): ExecutionPatch<TVars, TAttrs> {
  if (returned === undefined) {
    return {};
  }
  if (isExecutionPatch(returned)) {
    return returned as ExecutionPatch<TVars, TAttrs>;
  }
  return { result: returned };
}

function isExecutionPatch<TVars extends Vars, TAttrs extends Attrs>(
  value: ExecutionPatch<TVars, TAttrs> | unknown,
): value is ExecutionPatch<TVars, TAttrs> {
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

function hookHandlerForPhase<TVars extends Vars, TAttrs extends Attrs>(
  hook: HookDefinition<TVars, TAttrs>,
  phase: ExecutionLifecyclePhase,
): HookPhaseHandler<TVars, TAttrs> | undefined {
  switch (phase) {
    case 'beforeAgent':
      return hook.onBeforeAgent;
    case 'afterAgent':
      return hook.onAfterAgent;
    case 'beforeModel':
      return hook.onBeforeModel;
    case 'afterModel':
      return hook.onAfterModel;
    case 'beforeTool':
      return hook.onBeforeTool;
    case 'afterTool':
      return hook.onAfterTool;
    case 'prepareModelInput':
      return undefined;
  }
}

function assertHookPatchAuthority<TVars extends Vars, TAttrs extends Attrs>(
  hookName: string | undefined,
  phase: ExecutionLifecyclePhase,
  patch: HookExecutionPatch<TVars, TAttrs> | void,
): void {
  if (!patch) {
    return;
  }
  const escaped = patch as ExecutionPatch<TVars, TAttrs>;
  if ('request' in escaped || 'result' in escaped) {
    throw new Error(
      `Hook ${hookName ?? '<anonymous>'} cannot return request/result patches in ${phase}. Use middleware for request/result transformations.`,
    );
  }
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
