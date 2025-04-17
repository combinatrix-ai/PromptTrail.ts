import type { ISession, TMessage } from './types';
import { createMetadata } from './metadata';
import { z } from 'zod';

/**
 * Import Template class from templates
 */
import { BaseTemplate } from './templates'; // Import BaseTemplate instead of Template
import { GenerateOptions } from './generate_options';

/**
 * Import AI SDK components for structured data generation
 */
import { generateText, Output } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';

/**
 * Template that enforces structured output according to a Zod schema
 *
 * This template uses AI SDK's schema functionality to ensure the LLM output matches
 * the expected structure using Zod schemas.
 */
export class SchemaTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput & {
    structured_output: Record<string, unknown>;
  },
> extends BaseTemplate<TInput, TOutput> {
  // Extend BaseTemplate
  private generateOptions: GenerateOptions; // Renamed from generateOptionsOrContent
  private schema: z.ZodType;
  private maxAttempts: number;
  private schemaName?: string;
  private schemaDescription?: string;
  private functionName?: string;

  constructor(options: {
    generateOptions: GenerateOptions;
    schema: z.ZodType;
    schemaName?: string;
    schemaDescription?: string;
    maxAttempts?: number;
    functionName?: string;
  }) {
    super(); // Call super constructor only once
    this.generateOptions = options.generateOptions;
    this.schema = options.schema;
    this.maxAttempts = options.maxAttempts || 3; // Default to 3 attempts if not specified
    this.schemaName = options.schemaName;
    this.schemaDescription = options.schemaDescription;
    this.functionName = options.functionName;
  }

  // Remove methods not present in BaseTemplate

  async execute(session: ISession<TInput>): Promise<ISession<TOutput>> {
    // Access the renamed generateOptions property
    if (!this.generateOptions) {
      throw new Error('No generateOptions provided for SchemaTemplate');
    }
    // String check is no longer needed as type is enforced by constructor

    const messages = session.messages;

    const aiMessages =
      messages.length > 0
        ? messages.map((msg: TMessage) => {
            if (msg.type === 'system') {
              return { role: 'system' as const, content: msg.content };
            } else if (msg.type === 'user') {
              return { role: 'user' as const, content: msg.content };
            } else if (msg.type === 'assistant') {
              return { role: 'assistant' as const, content: msg.content };
            }
            return { role: 'user' as const, content: msg.content };
          })
        : [
            {
              role: 'user' as const,
              content: 'Generate structured data according to the schema.',
            },
          ];

    let lastError: Error | null = null;
    let currentAttempt = 0;

    while (currentAttempt < this.maxAttempts) {
      currentAttempt++;
      try {
        const model =
          this.generateOptions.provider.type === 'openai'
            ? openai(this.generateOptions.provider.modelName)
            : anthropic(this.generateOptions.provider.modelName);

        if (this.generateOptions.provider.apiKey) {
          if (this.generateOptions.provider.type === 'openai') {
            process.env.OPENAI_API_KEY = this.generateOptions.provider.apiKey;
          } else if (this.generateOptions.provider.type === 'anthropic') {
            process.env.ANTHROPIC_API_KEY =
              this.generateOptions.provider.apiKey;
          }
        }

        const result = await generateText({
          model,
          messages: aiMessages,
          temperature: this.generateOptions.temperature,
          experimental_output: Output.object({
            schema: this.schema,
          }),
        });

        const { experimental_output } = result;

        if (!experimental_output) {
          throw new Error('No structured output generated');
        }

        const resultSession = await session.addMessage({
          type: 'assistant',
          content: JSON.stringify(experimental_output, null, 2),
          metadata: createMetadata(),
        });

        if (this.functionName && result.response) {
          let toolCalls = session.metadata.get('toolCalls');

          if (!toolCalls && result.response.body) {
            const responseBody = result.response.body as Record<
              string,
              unknown
            >;
            if (
              'tool_calls' in responseBody &&
              Array.isArray(responseBody.tool_calls)
            ) {
              toolCalls =
                responseBody.tool_calls as unknown as TInput['toolCalls'];
            }
          }

          if (toolCalls && Array.isArray(toolCalls)) {
            const matchingToolCall = toolCalls.find(
              (call: Record<string, unknown>) => {
                if (
                  typeof call.name === 'string' &&
                  call.name === this.functionName
                ) {
                  return true;
                }
                if (
                  call.function &&
                  typeof call.function === 'object' &&
                  call.function !== null &&
                  'name' in call.function &&
                  typeof call.function.name === 'string' &&
                  call.function.name === this.functionName
                ) {
                  return true;
                }
                return false;
              },
            );

            if (matchingToolCall) {
              let args;

              if (matchingToolCall.arguments) {
                args = matchingToolCall.arguments;
              } else if (
                matchingToolCall.function &&
                matchingToolCall.function.arguments
              ) {
                try {
                  if (typeof matchingToolCall.function.arguments === 'string') {
                    args = JSON.parse(matchingToolCall.function.arguments);
                  } else {
                    args = matchingToolCall.function.arguments;
                  }
                } catch (error) {
                  console.error('Failed to parse function arguments:', error);
                }
              }

              if (args) {
                return resultSession.updateMetadata({
                  structured_output: args,
                }) as unknown as ISession<TOutput>;
              }
            }
          }
        }

        return resultSession.updateMetadata({
          structured_output: experimental_output,
        }) as unknown as ISession<TOutput>;
      } catch (error) {
        lastError = error as Error;
        console.error(
          `Attempt ${currentAttempt}/${this.maxAttempts} failed to generate structured output:`,
          error,
        );

        if (currentAttempt >= this.maxAttempts) {
          throw new Error(
            `Failed to generate structured output after ${this.maxAttempts} attempts: ${lastError.message}`,
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
