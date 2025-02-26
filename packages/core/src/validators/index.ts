/**
 * Validators for ensuring LLM responses meet quality criteria
 *
 * This module provides validators that can be used with GuardrailTemplate
 * to ensure that LLM responses meet specific quality criteria.
 *
 * @example
 * ```typescript
 * import {
 *   GuardrailTemplate,
 *   RegexMatchValidator,
 *   KeywordValidator,
 *   OnFailAction
 * } from '@prompttrail/core';
 *
 * // Create a guardrail template with validators
 * const guardrailTemplate = new GuardrailTemplate({
 *   template: new AssistantTemplate({ model }),
 *   validators: [
 *     new RegexMatchValidator({
 *       regex: /^[A-Z][a-z]+$/,
 *       description: "Response must be a single capitalized word"
 *     }),
 *     new KeywordValidator({
 *       keywords: ['inappropriate', 'offensive'],
 *       mode: 'exclude'
 *     })
 *   ],
 *   onFail: OnFailAction.RETRY,
 *   maxAttempts: 3
 * });
 * ```
 */

export * from '../templates/guardrail_template';
export * from './base_validators';
export * from './model_validators';
