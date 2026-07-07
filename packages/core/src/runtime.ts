export type RetainLevel = 'none' | 'summary' | 'full';

export type RuntimeEvent =
  | {
      type: 'item.started' | 'item.completed';
      id: string;
      itemType?: string;
      status?: string;
      preview?: string;
      raw?: unknown;
    }
  | {
      type: 'text.delta';
      id: string;
      delta: string;
      raw?: unknown;
    }
  | {
      type: 'command';
      id: string;
      command?: string;
      exitCode?: number;
      status?: string;
      outputPreview?: string;
      raw?: unknown;
    }
  | {
      type: 'diff';
      id: string;
      path?: string;
      added?: number;
      removed?: number;
      status?: string;
      raw?: unknown;
    }
  | {
      type: 'approval.requested' | 'approval.resolved';
      id: string;
      action?: string;
      status?: string;
      raw?: unknown;
    }
  | {
      type: 'turn.completed';
      id: string;
      status?: string;
      raw?: unknown;
    }
  | {
      type: 'error';
      id: string;
      error: unknown;
      raw?: unknown;
    }
  | {
      type: 'raw';
      id: string;
      method?: string;
      raw: unknown;
    };

export interface RuntimeTurnResult {
  provider: 'codex' | 'claude-agent';
  threadId?: string;
  sessionId?: string;
  turnId?: string;
  status: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  finalAnswer: string;
  events: unknown[];
  raw?: unknown;
}

export interface RuntimeEventSummary {
  type: RuntimeEvent['type'];
  id: string;
  status?: string;
  preview?: string;
  truncated?: boolean;
  fullLength?: number;
  path?: string;
  added?: number;
  removed?: number;
  command?: string;
  exitCode?: number;
  action?: string;
}

export function summarizeRuntimeEvent(
  event: RuntimeEvent,
  maxPreviewLength = 500,
): RuntimeEventSummary {
  const summary: RuntimeEventSummary = {
    type: event.type,
    id: event.id,
  };

  if ('status' in event) {
    summary.status = event.status;
  }
  if ('path' in event) {
    summary.path = event.path;
    summary.added = event.added;
    summary.removed = event.removed;
  }
  if ('command' in event) {
    summary.command = event.command;
    summary.exitCode = event.exitCode;
  }
  if ('action' in event) {
    summary.action = event.action;
  }

  const previewSource =
    'preview' in event
      ? event.preview
      : 'delta' in event
        ? event.delta
        : 'outputPreview' in event
          ? event.outputPreview
          : undefined;

  if (previewSource !== undefined) {
    const { text, truncated, fullLength } = truncatePreview(
      previewSource,
      maxPreviewLength,
    );
    summary.preview = text;
    if (truncated) {
      summary.truncated = true;
      summary.fullLength = fullLength;
    }
  }

  return summary;
}

export function retainRuntimeEvents(
  events: RuntimeEvent[] | undefined,
  retain: RetainLevel,
): RuntimeEvent[] | RuntimeEventSummary[] | undefined {
  if (retain === 'none') {
    return undefined;
  }
  if (!events) {
    return undefined;
  }
  if (retain === 'full') {
    return events;
  }
  return events.map((event) => summarizeRuntimeEvent(event));
}

function truncatePreview(
  text: string,
  maxLength: number,
): { text: string; truncated?: boolean; fullLength?: number } {
  if (text.length <= maxLength) {
    return { text };
  }

  return {
    text: text.slice(0, maxLength),
    truncated: true,
    fullLength: text.length,
  };
}
