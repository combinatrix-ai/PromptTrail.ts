import type { Session } from '../session';
import type { MessageRole } from '../types';
import {
  createTransformer,
  type SessionTransformer,
} from './session_transformer';

/**
 * Options for extracting data using patterns
 */
export interface PatternExtractorOptions<T extends Record<string, unknown>> {
  /**
   * Regular expression pattern to match
   */
  pattern: RegExp | string;

  /**
   * Metadata key to store the extracted data
   */
  key: keyof T;

  /**
   * Message types to extract from (default: ['assistant'])
   */
  messageTypes?: MessageRole[];

  /**
   * Optional transformation function to apply to the matched content
   */
  transform?: (match: string) => unknown;

  /**
   * Default value to use if no match is found
   */
  defaultValue?: unknown;
}

/**
 * Create a pattern extractor transformer
 *
 * @example
 * ```typescript
 * // Extract JSON data
 * const jsonExtractor = extractPattern({
 *   pattern: /```json\n([\s\S]*?)\n```/,
 *   key: 'userData',
 *   transform: (json) => JSON.parse(json)
 * });
 *
 * // Extract multiple patterns
 * const dataExtractor = extractPattern([
 *   {
 *     pattern: /API Endpoint: (.+)/,
 *     key: 'apiEndpoint'
 *   },
 *   {
 *     pattern: /Error code: (\d+)/,
 *     key: 'errorCode',
 *     transform: (code) => parseInt(code, 10)
 *   }
 * ]);
 * ```
 */
export function extractPattern<T extends Record<string, unknown>>(
  options: PatternExtractorOptions<T> | PatternExtractorOptions<T>[],
): SessionTransformer<Record<string, unknown>, Record<string, unknown> & T> {
  return createTransformer<
    Record<string, unknown>,
    Record<string, unknown> & T
  >((session) => {
    // Convert single option to array for consistent processing
    const optionsArray = Array.isArray(options) ? options : [options];

    // Create an object to collect all extracted data
    const extractedData: Partial<T> = {};

    for (const option of optionsArray) {
      const messageTypes = option.messageTypes || ['assistant'];
      const pattern =
        option.pattern instanceof RegExp
          ? option.pattern
          : new RegExp(option.pattern);

      // Get relevant messages
      const messages = session.messages.filter((msg) =>
        messageTypes.includes(msg.type as MessageRole),
      );

      let matched = false;

      // Process each message
      for (const message of messages) {
        const match = pattern.exec(message.content);

        if (match) {
          // Use the first capture group if available, otherwise use the full match
          const extractedContent = match[1] !== undefined ? match[1] : match[0];

          // Apply transformation if provided
          const transformedValue = option.transform
            ? option.transform(extractedContent)
            : extractedContent;

          extractedData[option.key] = transformedValue as T[keyof T];
          matched = true;
          break; // Stop after first match unless we want to collect all matches
        }
      }

      // Apply default value if no match found and default is provided
      if (!matched && option.defaultValue !== undefined) {
        extractedData[option.key] = option.defaultValue as T[keyof T];
      }
    }

    // Update the session with all extracted data at once
    const updatedSession = session.updateMetadata(extractedData as T);

    // Return the updated session
    return updatedSession as Session<Record<string, unknown> & T>;
  });
}
