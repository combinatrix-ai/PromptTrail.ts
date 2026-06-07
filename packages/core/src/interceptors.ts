import {
  applyResolvedExecutionTransition,
  resolveExecutionTransition,
  type ExecutionPatch,
  type ResolvedExecutionCommand,
  type ResolvedExecutionTransition,
} from './execution';
import type { Session, Attrs, Vars } from './session';

export type ExecutionPhase =
  | 'beforeAgent'
  | 'afterAgent'
  | 'beforeModel'
  | 'prepareModelInput'
  | 'afterModel'
  | 'beforeTool'
  | 'afterTool';

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
  wrapModelCall?: never;
  afterModel?: MiddlewarePhaseHandler<TVars, TAttrs>;
  beforeTool?: MiddlewarePhaseHandler<TVars, TAttrs>;
  wrapToolCall?: never;
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
  phase: ExecutionPhase;
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

function hookHandlerForPhase<TVars extends Vars, TAttrs extends Attrs>(
  hook: HookDefinition<TVars, TAttrs>,
  phase: ExecutionPhase,
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
  phase: ExecutionPhase,
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
