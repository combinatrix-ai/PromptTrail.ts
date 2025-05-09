import type { Session } from '../session';
import type { Attrs, Vars } from '../tagged_record';

/**
 * Type guard for Session interface
 */
function isSession(value: unknown): value is Session<any, any> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'geTVarsValue' in value &&
    typeof (value as any).geTVarsValue === 'function'
  );
}

/**
 * Type guard for Record<string, unknown>
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
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
  if ('context' in session && session.context) {
    // If it's a Session object, use its context
    return template.replace(/\${([\w.]+)}/g, (match, path: string) => {
      const keys = path.split('.');
      let current: unknown = session.context;

      // Navigate through nested objects
      for (const key of keys) {
        if (current === undefined || current === null) {
          return '';
        }

        if (isSession(current)) {
          current = current.getVar(key);
        } else if (isRecord(current)) {
          current = current[key];
        } else {
          return '';
        }
      }

      // Convert value to string or empty string if undefined/null
      return current !== undefined && current !== null ? String(current) : '';
    });
  } else {
    // If it's a Context object or something else, use the original approach
    return template.replace(/\${([\w.]+)}/g, (match, path: string) => {
      const keys = path.split('.');
      let current: unknown = session;

      // Navigate through nested objects
      for (const key of keys) {
        if (current === undefined || current === null) {
          return '';
        }

        if (isSession(current)) {
          current = current.getVar(key);
        } else if (isRecord(current)) {
          current = current[key];
        } else {
          return '';
        }
      }

      // Convert value to string or empty string if undefined/null
      return current !== undefined && current !== null ? String(current) : '';
    });
  }
}
