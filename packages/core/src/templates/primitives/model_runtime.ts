import type { ExecutionEvent, ResolvedExecutionCommand } from '../../execution';
import {
  type ExecutionPhaseStep,
  type ExecutionRuntimeState,
  runExecutionPhase,
  runRuntimeExecutionPhase,
  runRuntimeMiddlewareWrapper,
} from '../../interceptors';
import type { Session } from '../../session';
import type { Attrs, Vars } from '../../session';

export interface ModelRuntimeRequest<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
> {
  session: Session<TVars, TAttrs>;
}

export async function executeRuntimeModelCall<
  TVars extends Vars,
  TAttrs extends Attrs,
  TResult,
>(
  runtime: ExecutionRuntimeState<TVars, TAttrs>,
  session: Session<TVars, TAttrs>,
  call: (session: Session<TVars, TAttrs>) => Promise<TResult>,
  commandScope = 'Model execution',
): Promise<{ session: Session<TVars, TAttrs>; result: TResult }> {
  const beforeModel = await runRuntimeExecutionPhase(runtime, {
    phase: 'beforeModel',
    session,
  });
  assertModelCommandSupported(beforeModel.command, commandScope);
  let validSession = beforeModel.session;

  const request: ModelRuntimeRequest<TVars, TAttrs> = {
    session: validSession,
  };
  const prepared = await runExecutionPhase({
    phase: 'prepareModelInput',
    session: validSession,
    request,
    context: runtime.context,
    middlewareState: runtime.middlewareState,
    middleware: runtime.middleware,
    hooks: runtime.hooks,
    beforeVersion: runtime.version,
    signal: runtime.signal,
  });
  assertModelCommandSupported(prepared.command, commandScope);
  assertPrepareModelInputDidNotPersistSession(prepared.steps);
  runtime.middlewareState = prepared.middlewareState;
  runtime.version = prepared.afterVersion;
  const modelSession =
    (prepared.request as ModelRuntimeRequest<TVars, TAttrs> | undefined)
      ?.session ?? validSession;

  let openModelEvents = 0;
  const closeModelEvents = async (
    type: 'model.completed' | 'model.failed',
    error?: unknown,
  ) => {
    while (openModelEvents > 0) {
      openModelEvents--;
      await emitModelEvent(runtime, type, error);
    }
  };

  const wrappedModel = await (async () => {
    try {
      const result = await runRuntimeMiddlewareWrapper<
        TVars,
        TAttrs,
        ModelRuntimeRequest<TVars, TAttrs>,
        TResult
      >(runtime, {
        phase: 'wrapModelCall',
        session: validSession,
        request: { session: modelSession },
        call: async ({ request }) => {
          if (await emitModelEvent(runtime, 'model.started')) {
            openModelEvents++;
          }
          return call(request.session);
        },
      });
      await closeModelEvents('model.completed');
      return result;
    } catch (error) {
      await closeModelEvents('model.failed', error);
      throw error;
    }
  })();
  assertModelCommandSupported(wrappedModel.command, commandScope);
  validSession = wrappedModel.session;
  let result = wrappedModel.result;

  const afterModel = await runRuntimeExecutionPhase(runtime, {
    phase: 'afterModel',
    session: validSession,
    result,
  });
  assertModelCommandSupported(afterModel.command, commandScope);
  validSession = afterModel.session;
  result = (afterModel.result ?? result) as TResult;

  return { session: validSession, result };
}

export async function emitModelEvent<
  TVars extends Vars = Vars,
  TAttrs extends Attrs = Attrs,
>(
  runtime: ExecutionRuntimeState<TVars, TAttrs> | undefined,
  type: 'model.started' | 'model.completed' | 'model.failed',
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
    stepId: 'model',
    idempotencyKey: `${runtime.eventScopeId ?? 'direct'}:model:${seq}:${type}`,
  };
  if (error !== undefined) {
    event.error = error;
  }
  await runtime.emitEvent(event);
  return true;
}

function assertModelCommandSupported(
  command: ResolvedExecutionCommand,
  commandScope: string,
): void {
  if (command.type === 'none') {
    return;
  }
  throw new Error(
    `${commandScope} does not support execution command ${command.type} yet.`,
  );
}

function assertPrepareModelInputDidNotPersistSession(
  steps: readonly ExecutionPhaseStep[],
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
      'prepareModelInput cannot return persistent session patches. Return a request.session instead.',
    );
  }
}
