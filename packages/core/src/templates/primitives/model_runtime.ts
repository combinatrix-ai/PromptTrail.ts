import type { ExecutionEvent, ResolvedExecutionCommand } from '../../execution';
import {
  type ExecutionPhaseStep,
  type ExecutionRuntimeState,
  runExecutionPhase,
  runRuntimeExecutionPhase,
  runRuntimeMiddlewareWrapper,
} from '../../interceptors';
import type { Session } from '../../session';
import type { Vars } from '../../session';

export interface ModelRuntimeRequest<TVars extends Vars = Vars> {
  session: Session<TVars>;
  /**
   * Resolved LLMOptions manifest (system, params, `toolDefsDigest`) threaded in
   * by the assistant node so the B0 recording (and any `wrapModelCall`
   * middleware) can digest the FULL provider request, not just the session
   * (round-3: `ModelRuntimeRequest` is otherwise `{ session }` only, which would
   * make request-hash keying unsound). Absent for callers that do not resolve a
   * source manifest (e.g. structured/parallel model calls).
   */
  requestMeta?: unknown;
}

/**
 * Per-provider recording metadata for the assistant model funnel (Appendix B0).
 * Provider is 'assistant' here; Codex/Claude turns record separately with their
 * own normalizers.
 */
export interface ModelCallRecordOptions {
  nodePath?: string;
  provider?: string;
  requestMeta?: unknown;
}

export async function executeRuntimeModelCall<TVars extends Vars, TResult>(
  runtime: ExecutionRuntimeState<TVars>,
  session: Session<TVars>,
  call: (session: Session<TVars>) => Promise<TResult>,
  commandScope = 'Model execution',
  record?: ModelCallRecordOptions,
): Promise<{ session: Session<TVars>; result: TResult }> {
  const beforeModel = await runRuntimeExecutionPhase(runtime, {
    phase: 'beforeModel',
    session,
  });
  assertModelCommandSupported(beforeModel.command, commandScope);
  let validSession = beforeModel.session;

  const request: ModelRuntimeRequest<TVars> = {
    session: validSession,
    requestMeta: record?.requestMeta,
  };
  const prepared = await runExecutionPhase({
    phase: 'prepareModelInput',
    session: validSession,
    request,
    services: runtime.services,
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
    (prepared.request as ModelRuntimeRequest<TVars> | undefined)?.session ??
    validSession;

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
        ModelRuntimeRequest<TVars>,
        TResult
      >(runtime, {
        phase: 'wrapModelCall',
        session: validSession,
        request: { session: modelSession, requestMeta: record?.requestMeta },
        call: async ({ request }) => {
          if (await emitModelEvent(runtime, 'model.started')) {
            openModelEvents++;
          }
          // B1 replay: short-circuit the provider with the recorded node output
          // (node-output granularity — internal vendor/validator rounds are not
          // re-run). The recorder below still captures the substituted response
          // into the replay's fresh recording stream.
          if (runtime.replay) {
            return runtime.replay.model({
              nodePath:
                record?.nodePath ??
                runtime.recorder?.currentNodePath ??
                commandScope,
              provider: record?.provider ?? 'assistant',
              requestSession: modelSession,
              requestMeta: record?.requestMeta,
            }) as TResult;
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

  // B0 model capture at the wrapModelCall boundary (Appendix B0 work item 4).
  // One ModelCallRecord per invocation (node-output granularity: internal
  // vendor rounds inside the `call` are aggregated into this single response).
  // provider = 'assistant'; Codex/Claude turns record with their own
  // normalizers. `modelSession` is the input sent to the provider; `requestMeta`
  // is the resolved-LLMOptions manifest threaded in by the assistant node.
  runtime.recorder?.model({
    nodePath:
      record?.nodePath ?? runtime.recorder.currentNodePath ?? commandScope,
    provider: record?.provider ?? 'assistant',
    requestSession: modelSession,
    requestMeta: record?.requestMeta,
    response: result,
  });

  return { session: validSession, result };
}

export async function emitModelEvent<TVars extends Vars = Vars>(
  runtime: ExecutionRuntimeState<TVars> | undefined,
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
