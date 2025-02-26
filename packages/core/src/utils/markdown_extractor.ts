import type { Session } from '../session';
import type { MessageRole } from '../types';
import {
  createTransformer,
  type SessionTransformer,
} from './session_transformer';

/**
 * Options for extracting markdown sections from messages
 */
export interface MarkdownExtractorOptions<T extends Record<string, unknown>> {
  /**
   * Message types to extract from (default: ['assistant'])
   */
  messageTypes?: MessageRole[];

  /**
   * Map of markdown headings to metadata keys
   * Example: { 'Summary': 'summary', 'Explanation': 'explanation' }
   */
  headingMap?: Record<string, keyof T>;

  /**
   * Map of code block languages to metadata keys
   * Example: { 'typescript': 'code', 'json': 'jsonData' }
   */
  codeBlockMap?: Record<string, keyof T>;
}

/**
 * Create a markdown extractor transformer
 *
 * @example
 * ```typescript
 * const transformer = extractMarkdown({
 *   headingMap: { 'Summary': 'summary', 'Explanation': 'explanation' },
 *   codeBlockMap: { 'typescript': 'code', 'json': 'jsonData' }
 * });
 *
 * // Use with a template
 * const template = new LinearTemplate()
 *   .addAssistant({ model })
 *   .addTransformer(transformer);
 *
 * // Or apply directly to a session
 * const updatedSession = await transformer.transform(session);
 * console.log(updatedSession.metadata.get('code'));
 * ```
 */
export function extractMarkdown<T extends Record<string, unknown>>(
  options: MarkdownExtractorOptions<T>,
): SessionTransformer<Record<string, unknown>, Record<string, unknown> & T> {
  return createTransformer<
    Record<string, unknown>,
    Record<string, unknown> & T
  >((session) => {
    const messageTypes = options.messageTypes || ['assistant'];

    // Create an object to collect all extracted data
    const extractedData: Partial<T> = {};

    // Process each message
    for (const message of session.messages) {
      // Only process messages of the specified types
      if (messageTypes.includes(message.type as MessageRole)) {
        // Extract headings and their content
        if (options.headingMap) {
          const headingPattern =
            /##\s+([^\n]+)\n([\s\S]*?)(?=\n##\s+|\n```|\s*$)/g;
          let match;
          while ((match = headingPattern.exec(message.content)) !== null) {
            const [, heading, content] = match;
            const trimmedHeading = heading.trim();

            if (options.headingMap[trimmedHeading]) {
              const key = options.headingMap[trimmedHeading] as keyof T;
              extractedData[key] = content.trim() as any;
            }
          }
        }

        // Extract code blocks
        if (options.codeBlockMap) {
          const codeBlockPattern = /```(\w+)\n([\s\S]*?)```/g;
          let match;
          while ((match = codeBlockPattern.exec(message.content)) !== null) {
            const [, language, code] = match;

            if (options.codeBlockMap[language]) {
              const key = options.codeBlockMap[language] as keyof T;
              extractedData[key] = code.trim() as any;
            }
          }
        }
      }
    }

    // Update the session with all extracted data at once
    const updatedSession = session.updateMetadata(extractedData as T);

    // Return the updated session
    return updatedSession as Session<Record<string, unknown> & T>;
  });
}
