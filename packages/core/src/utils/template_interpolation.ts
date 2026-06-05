import type { Session } from '../session';
import type { Attrs, Vars } from '../session';

type SessionLike = {
  vars?: Record<string, unknown>;
  getVar?: (key: string) => unknown;
};

/**
 * Type guard for Record<string, unknown>
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function hasVars(value: unknown): value is { vars: Record<string, unknown> } {
  return isRecord(value) && isRecord(value.vars);
}

function hasGetVar(
  value: unknown,
): value is { getVar: (key: string) => unknown } {
  return isRecord(value) && typeof (value as SessionLike).getVar === 'function';
}

function resolvePath(root: unknown, path: string): unknown {
  let current = root;
  for (const key of path.split('.')) {
    if (current === undefined || current === null) {
      return undefined;
    }

    if (hasGetVar(current)) {
      current = current.getVar(key);
    } else if (isRecord(current)) {
      current = current[key];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Interpolates template strings with metadata values
 * @param template The template string with ${variable} syntax
 * @param session The session containing context values for interpolation
 * @returns The interpolated string
 */
export function interpolateTemplate<TVars extends Vars, TAttrs extends Attrs>(
  template: string,
  session: Session<TVars, TAttrs> | Vars | Record<string, unknown>,
): string {
  const root = hasVars(session) ? session.vars : session;
  return template.replace(/\${([\w.]+)}/g, (_match, path: string) => {
    const value = resolvePath(root, path);
    return value !== undefined && value !== null ? String(value) : '';
  });
}
