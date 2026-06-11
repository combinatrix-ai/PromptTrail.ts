export type ProviderSessionProvider = 'codex' | 'claude';

export interface ProviderSessionBinding {
  provider: ProviderSessionProvider;
  id: string;
  restarts: number;
}

export type ProviderTurnUnresumablePolicy = 'fail' | 'restart';

export const DEFAULT_PROVIDER_TURN_RESTART_NOTICE =
  'This turn was interrupted and restarted; earlier partial work in this turn may have been lost.';

export class ProviderTurnUnresumableError extends Error {
  constructor(
    readonly provider: ProviderSessionProvider,
    readonly nodePath: string,
    readonly sessionId: string | undefined,
    message?: string,
    readonly cause?: unknown,
  ) {
    super(
      message ??
        `${provider} turn at ${nodePath} could not resume provider session${sessionId ? ` ${sessionId}` : ''}.`,
    );
    this.name = 'ProviderTurnUnresumableError';
  }
}
