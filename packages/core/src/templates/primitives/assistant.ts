import type { AssistantMessage } from '../../message';
import type { Session } from '../../session';
import type { Attrs, Vars } from '../../session';
import type { Tool } from '../../tool';
import type { IValidator } from '../../validators/base';
import type { Source, ModelOutput, LlmSource } from '../../source';
import { ValidationError } from '../../errors';
import {
  generateText,
  generateWithSchema,
  SchemaGenerationOptions,
} from '../../generate';
import { interpolateTemplate } from '../../utils/template_interpolation';
import { z } from 'zod';
import { TemplateBase } from '../base';

export interface LLMConfig {
  provider: 'openai' | 'anthropic' | 'google';
  model?: string;
  apiKey?: string;
  baseURL?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  topK?: number;
  tools?: Record<string, Tool>;
  toolChoice?: 'auto' | 'required' | 'none';
  dangerouslyAllowBrowser?: boolean;
  // Schema support
  schema?: z.ZodType;
  mode?: 'tool' | 'structured_output';
  functionName?: string;
}

export type ExtractToVarsConfig =
  | boolean // Extract all schema fields to vars
  | string[] // Extract only specified fields
  | Record<string, string>; // Map schema fields to var names

export interface AssistantTemplateOptions {
  role?: 'user' | 'assistant' | 'system';
  validation?: IValidator;
  maxAttempts?: number;
  // Schema support
  schema?: z.ZodType;
  mode?: 'tool' | 'structured_output';
  functionName?: string;
  extractToVars?: ExtractToVarsConfig;
}

export type AssistantContentInput =
  | LLMConfig
  | string
  | ((session: Session<any, any>) => Promise<ModelOutput>)
  | Source<ModelOutput>
  | Source<string>
  | LlmSource; // Backward compatibility - LlmSource is the main Source type for assistants

export class Assistant<
  TAttrs extends Attrs = Record<string, any>,
  TVars extends Vars = Record<string, any>,
> extends TemplateBase<TAttrs, TVars> {
  private content: AssistantContentInput;
  private options: AssistantTemplateOptions;
  private schemaConfig?: SchemaGenerationOptions;
  private extractToVarsConfig?: ExtractToVarsConfig;
  private isSourceBased = false;

  constructor(
    content?: AssistantContentInput,
    options: AssistantTemplateOptions = {},
  ) {
    super();
    this.content = content || {
      provider: 'openai',
      model: 'gpt-4o-mini',
    };
    this.options = options;

    // Set up schema configuration from content or options
    const schema =
      (content &&
        typeof content === 'object' &&
        'schema' in content &&
        content.schema) ||
      options.schema;

    if (schema) {
      this.schemaConfig = {
        schema,
        mode:
          (content &&
            typeof content === 'object' &&
            'mode' in content &&
            content.mode) ||
          options.mode ||
          'structured_output',
        functionName:
          (content &&
            typeof content === 'object' &&
            'functionName' in content &&
            content.functionName) ||
          options.functionName ||
          'generateStructuredOutput',
      };
    }

    // Set up variable extraction
    this.extractToVarsConfig = options.extractToVars;

    // Check if this is a Source instance for backward compatibility
    this.isSourceBased = !!(
      content &&
      typeof content === 'object' &&
      'getContent' in content
    );
  }

  /**
   * Get the content source for this template
   * Used by composite templates to manage default sources
   */
  getContentSource(): Source<ModelOutput> | null {
    if (this.isSourceBased) {
      return this.content as Source<ModelOutput>;
    }
    return null;
  }

  /**
   * Set the content source for this template
   * Used by composite templates to set default sources
   */
  set contentSource(source: Source<ModelOutput> | undefined) {
    if (source) {
      this.content = source;
      this.isSourceBased = true;
    }
  }

  withSchema<T>(
    schema: z.ZodType<T>,
    options?: {
      mode?: 'tool' | 'structured_output';
      functionName?: string;
    },
  ): this {
    this.schemaConfig = {
      schema,
      mode: options?.mode || 'structured_output',
      functionName: options?.functionName || 'generateStructuredOutput',
    };
    return this;
  }

  private async getModelOutput(
    session: Session<TVars, TAttrs>,
  ): Promise<ModelOutput> {
    // Backward compatibility: Use Source if provided
    if (this.isSourceBased) {
      const source = this.content as Source<ModelOutput | string>;
      const result = await source.getContent(session);

      if (typeof result === 'string') {
        return { content: result };
      } else if (result && typeof result === 'object' && 'content' in result) {
        return result as ModelOutput;
      } else {
        throw new Error('Invalid content from Assistant template Source');
      }
    }

    // Direct API implementation
    if (typeof this.content === 'string') {
      const interpolatedContent = interpolateTemplate(this.content, session);
      return { content: interpolatedContent };
    }

    if (typeof this.content === 'function') {
      return await this.content(session);
    }

    if (typeof this.content === 'object' && 'provider' in this.content) {
      const llmOptions = {
        provider: {
          type: this.content.provider,
          apiKey:
            this.content.apiKey ||
            (this.content.provider === 'openai'
              ? process.env.OPENAI_API_KEY
              : this.content.provider === 'anthropic'
                ? process.env.ANTHROPIC_API_KEY
                : process.env.GOOGLE_API_KEY) ||
            '',
          modelName:
            this.content.model ||
            (this.content.provider === 'openai'
              ? 'gpt-4o-mini'
              : this.content.provider === 'anthropic'
                ? 'claude-3-5-haiku-latest'
                : 'gemini-pro'),
          baseURL: this.content.baseURL,
          dangerouslyAllowBrowser: this.content.dangerouslyAllowBrowser,
        },
        temperature: this.content.temperature,
        maxTokens: this.content.maxTokens,
        topP: this.content.topP,
        topK: this.content.topK,
        tools: this.content.tools,
        toolChoice: this.content.toolChoice,
        dangerouslyAllowBrowser: this.content.dangerouslyAllowBrowser,
      };

      let response: any;

      if (this.schemaConfig) {
        response = await generateWithSchema(
          session,
          llmOptions,
          this.schemaConfig,
        );
      } else {
        response = await generateText(session, llmOptions);
      }

      return {
        content: response.content ?? '',
        toolCalls: response.toolCalls,
        toolResults: response.toolResults,
        metadata: response.attrs,
        structuredOutput: response.structuredOutput,
      };
    }

    throw new Error('Invalid Assistant template content type');
  }

  private async validateContent(
    content: string,
    session: Session<TVars, TAttrs>,
  ): Promise<void> {
    // Skip validation for Source-based content (Sources handle their own validation)
    if (this.isSourceBased) return;

    if (!this.options.validation) return;

    const result = await this.options.validation.validate(content, session);
    if (!result.isValid) {
      throw new ValidationError(
        `Assistant content validation failed: ${result.instruction || ''}`,
      );
    }
  }

  async execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const validSession = this.ensureSession(session);

    // For Source-based content, use simpler execution (Sources handle retries)
    if (this.isSourceBased) {
      const output = await this.getModelOutput(validSession);

      const message: AssistantMessage<TAttrs> = {
        type: 'assistant',
        content: output.content,
        toolCalls: output.toolCalls,
        attrs: (output.metadata as TAttrs) ?? ({} as TAttrs),
        structuredContent: output.structuredOutput,
      };

      let updatedSession = validSession.addMessage(message);

      // Add tool results as separate messages if available
      if (output.toolResults && output.toolResults.length > 0) {
        for (const toolResult of output.toolResults) {
          updatedSession = updatedSession.addMessage({
            type: 'tool_result',
            content: JSON.stringify(toolResult.result),
            attrs: {
              toolCallId: toolResult.toolCallId,
            } as unknown as TAttrs,
          });
        }
      }

      // Extract structured data to session variables if configured
      if (this.extractToVarsConfig && output.structuredOutput) {
        updatedSession = this.extractVariables(
          updatedSession,
          output.structuredOutput,
        );
      }

      return updatedSession;
    }

    // Direct API execution with retry logic
    const maxAttempts = this.options.maxAttempts || 1;
    let attempts = 0;
    let lastOutput: ModelOutput | undefined;

    while (attempts < maxAttempts) {
      attempts++;

      try {
        const output = await this.getModelOutput(validSession);
        await this.validateContent(output.content, validSession);

        lastOutput = output;

        const message: AssistantMessage<TAttrs> = {
          type: 'assistant',
          content: output.content,
          toolCalls: output.toolCalls,
          attrs: (output.metadata as TAttrs) ?? ({} as TAttrs),
          structuredContent: output.structuredOutput,
        };

        let updatedSession = validSession.addMessage(message);

        // Add tool results as separate messages if available
        if (output.toolResults && output.toolResults.length > 0) {
          for (const toolResult of output.toolResults) {
            updatedSession = updatedSession.addMessage({
              type: 'tool_result',
              content: JSON.stringify(toolResult.result),
              attrs: {
                toolCallId: toolResult.toolCallId,
              } as unknown as TAttrs,
            });
          }
        }

        // Extract structured data to session variables if configured
        if (this.extractToVarsConfig && output.structuredOutput) {
          updatedSession = this.extractVariables(
            updatedSession,
            output.structuredOutput,
          );
        }

        return updatedSession;
      } catch (error) {
        if (attempts >= maxAttempts) {
          throw error;
        }

        console.warn(
          `Assistant template attempt ${attempts} failed: ${(error as Error).message}. Retrying...`,
        );
      }
    }

    throw new Error('Assistant template execution failed unexpectedly');
  }

  /**
   * Extract structured data to session variables based on extractToVars configuration
   */
  private extractVariables(
    session: Session<TVars, TAttrs>,
    structuredOutput: any,
  ): Session<TVars, TAttrs> {
    if (!this.extractToVarsConfig || !structuredOutput) {
      return session;
    }

    const newVars: Partial<TVars> = {};

    if (this.extractToVarsConfig === true) {
      // Extract all fields directly
      Object.assign(newVars, structuredOutput);
    } else if (Array.isArray(this.extractToVarsConfig)) {
      // Extract only specified fields
      for (const field of this.extractToVarsConfig) {
        if (field in structuredOutput) {
          (newVars as any)[field] = structuredOutput[field];
        }
      }
    } else if (typeof this.extractToVarsConfig === 'object') {
      // Map schema fields to var names
      for (const [schemaField, varName] of Object.entries(
        this.extractToVarsConfig,
      )) {
        if (schemaField in structuredOutput) {
          (newVars as any)[varName] = structuredOutput[schemaField];
        }
      }
    }

    return session.withVars(newVars);
  }
}
