import { ContentSource, StaticContentSource } from '../content_source';
import type { ModelContentOutput } from '../content_source';
import { createMetadata } from '../metadata';
import { createSession } from '../session';
import type { ISession, TMessage, IToolResultMetadata } from '../types';
import { Template } from './basic';
import { GenerateOptions } from '../generate_options';
import { BasicModelContentSource } from '../content_source';

/**
 * Extended Template class that includes ContentSource
 */
export abstract class ContentSourceTemplate<
  TOutput = unknown,
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TResultOutput extends Record<string, unknown> = TInput,
> extends Template<TInput, TResultOutput> {
  protected contentSource?: ContentSource<TOutput>;

  getContentSource(): ContentSource<TOutput> | undefined {
    return this.contentSource;
  }

  hasOwnContentSource(): boolean {
    return !!this.contentSource;
  }
}

/**
 * Message template for handling any message type
 */
export class MessageTemplate<
  TOutput = unknown,
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends ContentSourceTemplate<TOutput, TMetadata, TMetadata> {
  constructor(
    private messageType: TMessage['type'],
    contentSource: ContentSource<TOutput>,
  ) {
    super();
    this.contentSource = contentSource;
  }

  async execute(session?: ISession<TMetadata>): Promise<ISession<TMetadata>> {
    const validSession = session ? session : createSession<TMetadata>();

    if (!this.contentSource) {
      throw new Error('ContentSource is required for MessageTemplate');
    }

    // Use type assertion to handle type compatibility
    const content = await this.contentSource.getContent(
      validSession as unknown as ISession,
    );

    // Type-specific handling based on the content type
    if (typeof content === 'string') {
      if (this.messageType === 'tool_result') {
        const metadata = createMetadata<IToolResultMetadata>();
        metadata.set('toolCallId', 'default-tool-call-id');

        return validSession.addMessage({
          type: this.messageType,
          content,
          metadata,
          result: content,
        });
      } else {
        return validSession.addMessage({
          type: this.messageType,
          content,
          metadata: createMetadata(),
        });
      }
    } else if (this.isModelContentOutput(content)) {
      // Handle ModelContentOutput
      if (this.messageType === 'assistant') {
        let updatedSession = validSession.addMessage({
          type: this.messageType,
          content: content.content,
          toolCalls: content.toolCalls,
          metadata: createMetadata(),
        });

        // Update session metadata if provided
        if (content.metadata) {
          updatedSession = updatedSession.updateMetadata(
            content.metadata as any,
          );
        }

        // Add structured output to metadata if available
        if (content.structuredOutput) {
          updatedSession = updatedSession.updateMetadata({
            structured_output: content.structuredOutput,
          } as any);
        }

        return updatedSession;
      } else if (this.messageType === 'tool_result') {
        const metadata = createMetadata<IToolResultMetadata>();
        metadata.set('toolCallId', 'default-tool-call-id');

        return validSession.addMessage({
          type: this.messageType,
          content: content.content,
          metadata,
          result: content.content,
        });
      } else {
        return validSession.addMessage({
          type: this.messageType,
          content: content.content,
          metadata: createMetadata(),
        });
      }
    } else {
      // Handle other types of content
      throw new Error(`Unsupported content type: ${typeof content}`);
    }
  }

  // Type guard to check if content is ModelContentOutput
  private isModelContentOutput(content: any): content is ModelContentOutput {
    return (
      content &&
      typeof content === 'object' &&
      typeof content.content === 'string'
    );
  }
}

/**
 * System template for system messages
 */
export class SystemTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends MessageTemplate<string, TMetadata> {
  constructor(contentSource: ContentSource<string> | string) {
    // Convert string to StaticContentSource if needed
    const source =
      typeof contentSource === 'string'
        ? new StaticContentSource(contentSource)
        : contentSource;

    super('system', source);
  }
}

/**
 * User template for user messages
 */
export class UserTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends MessageTemplate<string, TMetadata> {
  constructor(contentSource: ContentSource<string> | string) {
    // Convert string to StaticContentSource if needed
    const source =
      typeof contentSource === 'string'
        ? new StaticContentSource(contentSource)
        : contentSource;

    super('user', source);
  }
}

/**
 * Assistant template for assistant messages
 */
export class AssistantTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TMetadata & {
    structured_output?: Record<string, unknown>;
  },
> extends MessageTemplate<ModelContentOutput, TOutput> {
  constructor(
    contentSource: ContentSource<ModelContentOutput> | GenerateOptions,
  ) {
    // Convert GenerateOptions to BasicModelContentSource if needed
    const source =
      contentSource instanceof ContentSource
        ? contentSource
        : new BasicModelContentSource(contentSource);

    super('assistant', source);
  }
}

/**
 * Tool result template for tool result messages
 */
export class ToolResultTemplate<
  TMetadata extends Record<string, unknown> = Record<string, unknown>,
> extends Template<TMetadata, TMetadata> {
  constructor(
    private options: {
      toolCallId: string;
      content: string;
    },
  ) {
    super();
  }

  async execute(session?: ISession<TMetadata>): Promise<ISession<TMetadata>> {
    const validSession = session ? session : createSession<TMetadata>();

    const metadata = createMetadata<IToolResultMetadata>();
    metadata.set('toolCallId', this.options.toolCallId);

    return validSession.addMessage({
      type: 'tool_result',
      content: this.options.content,
      metadata,
      result: this.options.content, // Add the result property
    }) as ISession<TMetadata>;
  }
}
