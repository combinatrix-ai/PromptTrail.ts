import type { Session } from '../session';
import type { SchemaType } from '../tool';
import { createMetadata } from '../metadata';
import { SchemaValidator } from '../validators/schema_validator';
import { GuardrailTemplate, OnFailAction } from './guardrail_template';
import { z } from 'zod';
import { zodToJsonSchema } from '../utils/schema';

// Import Template class to extend it
import { Template } from '../templates';
import { type GenerateOptions } from '../generate';
import { GenerateTemplate } from './generate_template';

// Type to handle both SchemaType and Zod schemas
type SchemaInput = SchemaType | z.ZodType;

// Helper to check if a schema is a Zod schema
function isZodSchema(schema: SchemaInput): schema is z.ZodType {
  return typeof (schema as z.ZodType)._def !== 'undefined';
}

// Helper to convert a Zod schema to SchemaType
function zodSchemaToSchemaType(schema: z.ZodType): SchemaType {
  const jsonSchema = zodToJsonSchema(schema);
  return {
    properties: jsonSchema.properties || {},
    required: jsonSchema.required || [],
  };
}

/**
 * Template that enforces structured output according to a schema
 *
 * This template uses schema validation to ensure the LLM output matches
 * the expected structure. It can work with function calling or direct JSON output.
 * It supports both PromptTrail's native schema type and Zod schemas.
 */
export class SchemaTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput & {
    structured_output: Record<string, unknown>;
  },
> extends Template<TInput, TOutput> {
  private schema: SchemaInput;
  private nativeSchema: SchemaType;
  private maxAttempts: number;
  private functionName: string;
  private isZodSchema: boolean;

  constructor(options: {
    generateOptions: GenerateOptions;
    schema: SchemaInput;
    maxAttempts?: number;
    functionName?: string;
  }) {
    super({ generateOptions: options.generateOptions });
    this.schema = options.schema;
    this.isZodSchema = isZodSchema(options.schema);

    // Convert Zod schema to native schema if needed
    if (this.isZodSchema) {
      this.nativeSchema = zodSchemaToSchemaType(options.schema as z.ZodType);
    } else {
      this.nativeSchema = options.schema as SchemaType;
    }

    this.maxAttempts = options.maxAttempts || 3;
    this.functionName = options.functionName || 'generate_structured_output';
  }

  async execute(session: Session<TInput>): Promise<Session<TOutput>> {
    if (!this.generateOptions) {
      throw new Error('No generateOptions provided for SchemaTemplate');
    }

    // Create a schema validator
    const schemaValidator = new SchemaValidator({
      schema: this.nativeSchema,
      description: 'Response must match the specified schema',
    });

    // Check if the provider is OpenAI to use function calling
    const isOpenAI = this.generateOptions.provider.type === 'openai';

    // Create a system message to instruct the model about the expected format
    const schemaDescription = Object.entries(this.nativeSchema.properties)
      .map(
        ([key, prop]) =>
          `${key}: ${prop.description} (${prop.type})${this.nativeSchema.required?.includes(key) ? ' (required)' : ''}`,
      )
      .join('\n');

    // Add a system message to instruct the model
    const systemSession = await session.addMessage({
      type: 'system',
      content: `Please provide a response in the following JSON format:\n\n${schemaDescription}\n\nEnsure your response is valid JSON.`,
      metadata: createMetadata(),
    });

    // Create an assistant template
    const assistantTemplate = new GenerateTemplate({
      generateOptions: this.generateOptions,
    });

    // If using OpenAI, add a system message with function calling instructions
    if (isOpenAI) {
      // For OpenAI models, we need to convert our schema to a format that OpenAI understands
      const functionParameters = {
        type: 'object',
        properties: this.nativeSchema.properties,
        required: this.nativeSchema.required || [],
      };

      // Add a system message with function calling instructions
      const functionCallingMessage = `
To provide a structured response, use the following function:

Function Name: ${this.functionName}
Description: Generate structured output according to the schema
Parameters: ${JSON.stringify(functionParameters, null, 2)}

Please call this function with the appropriate parameters to structure your response.
`;

      // Add the function calling instructions to the session
      await systemSession.addMessage({
        type: 'system',
        content: functionCallingMessage,
        metadata: createMetadata(),
      });
    }

    // Create a guardrail template with schema validation
    const guardrailTemplate = new GuardrailTemplate({
      template: assistantTemplate,
      validators: [schemaValidator],
      onFail: OnFailAction.RETRY,
      maxAttempts: this.maxAttempts,
    });

    // Execute the guardrail template
    const resultSession = await guardrailTemplate.execute(
      systemSession as unknown as Session<Record<string, unknown>>,
    );

    // Get the last message
    const lastMessage = resultSession.getLastMessage();
    if (!lastMessage) {
      throw new Error('No message generated');
    }

    let structuredOutput: Record<string, unknown>;

    // Get metadata as a plain object to avoid type issues
    const metadata = lastMessage.metadata?.toJSON() || {};
    const toolCalls = metadata.toolCalls as
      | Array<{
          name: string;
          arguments: Record<string, unknown>;
          id: string;
        }>
      | undefined;

    if (toolCalls && toolCalls.length > 0) {
      // If the model used function calling
      const call = toolCalls[0];
      structuredOutput = call.arguments;
    } else {
      // Try to parse JSON from the response for non-function calling models
      try {
        // Try to extract JSON from the response if it's not already JSON
        const jsonMatch =
          lastMessage.content.match(/```json\s*([\s\S]*?)\s*```/) ||
          lastMessage.content.match(/```\s*([\s\S]*?)\s*```/) ||
          lastMessage.content.match(/\{[\s\S]*\}/);

        const jsonContent = jsonMatch
          ? jsonMatch[1] || jsonMatch[0]
          : lastMessage.content;
        structuredOutput = JSON.parse(jsonContent);
      } catch (error) {
        console.error(
          'Failed to parse JSON from response:',
          lastMessage.content,
        );
        throw new Error(
          `Failed to parse structured output: ${(error as Error).message}`,
        );
      }
    }

    // Add the structured output to the session metadata
    return resultSession.updateMetadata({
      structured_output: structuredOutput,
    }) as unknown as Session<TOutput>;
  }
}
