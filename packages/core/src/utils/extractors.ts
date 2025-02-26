/**
 * Extractors for converting Session to Metadata
 *
 * This module provides utilities for extracting structured data from LLM outputs
 * and storing it in session metadata.
 *
 * @example
 * ```typescript
 * import { extractMarkdown, extractPattern } from '@prompttrail/core';
 *
 * // Create a template with transformers
 * const template = new LinearTemplate()
 *   .addSystem("Generate code with explanation")
 *   .addUser("Write a function to calculate factorial")
 *   .addAssistant({ model })
 *   .addTransformer(extractMarkdown({
 *     headingMap: { 'Explanation': 'explanation' },
 *     codeBlockMap: { 'typescript': 'code' }
 *   }));
 *
 * // Execute the template
 * const session = await template.execute(createSession());
 *
 * // Access the extracted data
 * console.log("Code:", session.metadata.get('code'));
 * console.log("Explanation:", session.metadata.get('explanation'));
 * ```
 */

export * from './session_transformer';
export * from './markdown_extractor';
export * from './pattern_extractor';
