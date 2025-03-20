import { z } from 'zod';
import type { Message, Tool, SchemaType } from '../types';
import type { Session } from '../session';
import { Template } from '../templates';
import { createMetadata } from '../metadata';
import type { AssistantMetadata } from '../types';
import { generateText, generateTextStream, type GenerateOptions } from '../generate';

/**
 * Template for assistant messages using the generateText function
 */
export class GenerateTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> extends Template<TInput, TOutput> {
  constructor(
    private options?: {
      content?: string;
      generateOptions?: GenerateOptions;
    },
  ) {
    super();
  }

  async execute(session: Session<TInput>): Promise<Session<TOutput>> {
    if (this.options?.content) {
      // For fixed content responses
      const interpolatedContent = this.interpolateContent(
        this.options.content,
        session,
      );
      return session.addMessage({
        type: 'assistant',
        content: interpolatedContent,
        metadata: createMetadata(),
      }) as unknown as Session<TOutput>;
    }

    if (!this.options?.generateOptions) {
      throw new Error('generateOptions is required for GenerateTemplate');
    }

    // Use the generateText function
    // Cast session to any to avoid type issues with the generateText function
    const response = await generateText(session as any, this.options.generateOptions);
    return session.addMessage(response) as unknown as Session<TOutput>;
  }
}

/**
 * Template for tool results
 */
export class ToolResultTemplate<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> extends Template<TInput, TOutput> {
  constructor(
    private options: {
      toolCallId: string;
      content: string;
    },
  ) {
    super();
  }

  async execute(session: Session<TInput>): Promise<Session<TOutput>> {
    const metadata = createMetadata<{ toolCallId: string }>();
    metadata.set('toolCallId', this.options.toolCallId);
    
    return session.addMessage({
      type: 'tool_result',
      content: this.options.content,
      metadata,
      result: this.options.content, // Add the result property
    }) as unknown as Session<TOutput>;
  }
}
