// structured.ts
import { z } from 'zod';
import type { Session } from '../../session';
import { LlmSource, ModelOutput, Source } from '../../source';
import { Attrs, Vars } from '../../session';
import { TemplateBase } from '../base';

/**
 * Template that enforces structured output according to a Zod schema
 * Now uses the Source abstraction consistently with enhanced LlmSource
 */
export class Structured<
  TAttrs extends Attrs = Attrs,
  TVars extends Vars = Vars,
> extends TemplateBase<TAttrs, TVars> {
  private source: Source<ModelOutput>;

  constructor(options: {
    source?: Source<ModelOutput>;
    schema: z.ZodType;
    mode?: 'tool' | 'structured_output';
    functionName?: string;
    maxAttempts?: number;
  }) {
    super();

    if (options.source) {
      // If source is provided, check if it's an LlmSource and configure schema
      if (options.source instanceof LlmSource) {
        this.source = options.source.withSchema(options.schema, {
          mode: options.mode,
          functionName: options.functionName,
        });
      } else {
        // For other source types, use as-is (assuming they handle schema internally)
        this.source = options.source;
      }
    } else {
      // No source provided, create a schema-configured LlmSource
      const {
        source: _,
        schema,
        mode,
        functionName,
        maxAttempts,
        ...rest
      } = options;

      this.source = Source.schema(schema, {
        mode,
        functionName,
        maxAttempts,
        ...rest,
      });
    }
  }

  /**
   * Static factory method for easier creation with just schema
   */
  static withSchema<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>(
    schema: z.ZodType,
    options?: {
      mode?: 'tool' | 'structured_output';
      functionName?: string;
      maxAttempts?: number;
    },
  ): Structured<TAttrs, TVars> {
    return new Structured<TAttrs, TVars>({
      schema,
      ...options,
    });
  }

  /**
   * Static factory method for creation with custom source
   */
  static withSource<TAttrs extends Attrs = Attrs, TVars extends Vars = Vars>(
    source: Source<ModelOutput>,
    schema: z.ZodType,
    options?: {
      mode?: 'tool' | 'structured_output';
      functionName?: string;
    },
  ): Structured<TAttrs, TVars> {
    return new Structured<TAttrs, TVars>({
      source,
      schema,
      ...options,
    });
  }

  async execute(
    session?: Session<TVars, TAttrs>,
  ): Promise<Session<TVars, TAttrs>> {
    const validSession = this.ensureSession(session);

    if (!this.source) {
      throw new Error('No source provided for Structured template');
    }

    try {
      const output = await this.source.getContent(validSession);

      return validSession.addMessage({
        type: 'assistant',
        content: output.content,
        toolCalls: output.toolCalls,
        structuredContent: output.structuredOutput,
        attrs: (output.metadata as TAttrs) ?? ({} as TAttrs),
      });
    } catch (error) {
      const err = error as Error;
      throw new Error(`Structured template execution failed: ${err.message}`);
    }
  }
}

/**
 * Schema and Validation Types
 * --------------------------------------------------------------------
 */

/**
 * Schema type interface for defining JSON schema structures
 * @deprecated Use Zod schemas directly instead
 */
export interface SchemaType {
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
}
