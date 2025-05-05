import type { Session } from '../../session';
import { Context, Metadata } from '../../tagged_record';
import { TemplateBase } from '../base';
import { GenerateOptions } from '../../generate_options';
import { convertSessionToAiSdkMessages, createProvider } from '../../generate';

/**
 * Import zod for schema building and validation
 */
import { z } from 'zod';

/**
 * Import AI SDK components for structured data generation
 */
import { generateText, Output } from 'ai';

/**
 * Template that enforces structured output according to a Zod schema
 *
 * This template uses AI SDK's schema functionality to ensure the LLM output matches
 * the expected structure using Zod schemas.
 */
export class Structured<
  TMetadata extends Metadata = Metadata,
  TContext extends Context = Context,
> extends TemplateBase<TMetadata, TContext> {
  private generateOptions: GenerateOptions;
  private schema: z.ZodType;
  private maxAttempts: number;

  constructor(options: {
    generateOptions: GenerateOptions;
    schema: z.ZodType;
    maxAttempts?: number;
    functionName?: string;
  }) {
    super();
    this.generateOptions = options.generateOptions;
    this.schema = options.schema;
    this.maxAttempts = options.maxAttempts || 3; // Default to 3 attempts if not specified
  }

  async execute(
    session: Session<TContext, TMetadata>,
  ): Promise<Session<TContext, TMetadata>> {
    if (!this.generateOptions) {
      throw new Error('No generateOptions provided for SchemaTemplate');
    }

    const aiMessages = convertSessionToAiSdkMessages(session);
    // TODO: Check this is enough to force use call

    let currentAttempt = 0;

    while (currentAttempt < this.maxAttempts) {
      currentAttempt++;
      try {
        const model = createProvider(this.generateOptions);
        const result = await generateText({
          model,
          // TODO: Fix this type
          messages: aiMessages as any,
          temperature: this.generateOptions.temperature,
          experimental_output: Output.object({
            schema: this.schema,
          }),
        });
        const structuredOutput = result.experimental_output;
        // Check compliance with the schema
        const parsedOutput = this.schema.safeParse(structuredOutput);
        if (!parsedOutput.success) {
          throw new Error('Generated output does not comply with the schema');
        }

        return session.addMessage({
          type: 'assistant',
          content: JSON.stringify(parsedOutput.data, null, 2),
          structuredContent: parsedOutput.data,
          metadata: undefined,
        });
      } catch (error) {
        console.error(
          `Attempt ${currentAttempt}/${this.maxAttempts} failed to generate structured output:`,
          error,
        );

        if (currentAttempt >= this.maxAttempts) {
          const err = error as Error;
          throw new Error(
            `Failed to generate structured output after ${this.maxAttempts} attempts: ${err.message}`,
          );
        }

        console.log(`Retrying... (${currentAttempt}/${this.maxAttempts})`);
      }
    }

    throw new Error(
      `Failed to generate structured output after ${this.maxAttempts} attempts`,
    );
  }
}

/**
 * Schema and Validation Types
 * --------------------------------------------------------------------
 */
/**
 * Schema type interface for defining JSON schema structures
 */

export interface SchemaType {
  properties: Record<string, { type: string; description: string }>;
  required?: string[];
}
