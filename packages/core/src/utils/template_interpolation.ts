import type { Context, Metadata } from '../taggedRecord';
import type { Session } from '../session';

/**
 * Type guard for Session interface
 */
function isSession(value: unknown): value is Session<any, any> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'getContextValue' in value &&
    typeof (value as any).getContextValue === 'function'
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
export function interpolateTemplate<TContext extends Context, TMetadata extends Metadata>(
  template: string,
  session: Session<TContext, TMetadata> | Context | Record<string, unknown>,
): string {
  console.log('Interpolating template:', template);
  console.log('Session/Context:', session);

  if ('context' in session && session.context) {
    // If it's a Session object, use its context
    console.log('Using session.context');
    return template.replace(/\${([\w.]+)}/g, (match, path: string) => {
      const keys = path.split('.');
      let current: unknown = session.context;
      console.log('Initial current:', current);

      // Navigate through nested objects
      for (const key of keys) {
        if (current === undefined || current === null) {
          return '';
        }

        if (isSession(current)) {
          current = current.getContextValue(key);
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
    console.log('Using original approach');
    return template.replace(/\${([\w.]+)}/g, (match, path: string) => {
      const keys = path.split('.');
      let current: unknown = session;

      // Navigate through nested objects
      for (const key of keys) {
        if (current === undefined || current === null) {
          return '';
        }

        if (isSession(current)) {
          current = current.getContextValue(key);
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
