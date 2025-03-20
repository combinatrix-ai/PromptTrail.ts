import type { Message, Session, Tool, ModelConfig, SchemaType } from '../types';

/**
 * Abstract base class for all model implementations
 */
export abstract class Model<
  TConfig extends ModelConfig = ModelConfig,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _TToolFormat = unknown, // Prefix with underscore to indicate intentionally unused
> {
  constructor(protected readonly config: TConfig) {
    this.validateConfig();
  }

  /**
   * Send a message to the model and get a response
   */
  abstract send(session: Session): Promise<Message>;

  /**
   * Send a message to the model and get streaming responses
   */
  abstract sendAsync(session: Session): AsyncGenerator<Message, void, unknown>;

  /**
   * Get the ai-sdk model instance for this model
   */
  abstract getAiSdkModel(): Record<string, unknown>;

  /**
   * Convert Session to ai-sdk compatible messages
   */
  abstract convertSessionToAiSdkMessages(session: Session): Record<string, unknown>[];

  /**
   * Convert ai-sdk response to Message
   */
  abstract convertAiSdkResponseToMessage(response: Record<string, unknown>): Message;

  /**
   * Format a tool for the specific model implementation
   */
  abstract formatTool(tool: Tool<SchemaType>): Record<string, unknown>;

  /**
   * Validate the model configuration
   */
  protected abstract validateConfig(): void;
}
