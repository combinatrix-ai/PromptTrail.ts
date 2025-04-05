import type { Metadata } from '../metadata';

/**
 * Type guard for Metadata interface
 */
function isMetadata(value: unknown): value is Metadata<Record<string, unknown>> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'get' in value &&
    typeof (value as Metadata<Record<string, unknown>>).get === 'function'
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
 * @param metadata The metadata containing values for interpolation
 * @returns The interpolated string
 */
export function interpolateTemplate(
  template: string,
  metadata: Metadata<Record<string, unknown>>,
): string {
  return template.replace(/\${([\w.]+)}/g, (match, path: string) => {
    const keys = path.split('.');
    let current: unknown = metadata;

    // Navigate through nested objects
    for (const key of keys) {
      if (current === undefined || current === null) {
        return '';
      }

      if (isMetadata(current)) {
        current = current.get(key);
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
