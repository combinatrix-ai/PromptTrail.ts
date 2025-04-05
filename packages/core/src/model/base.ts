import type { Message, Session, Tool, ModelConfig, SchemaType } from '../types';

/**
 * Abstract base class for all model implementations
 */
export abstract class Model<TConfig extends ModelConfig = ModelConfig> {
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
   * Format a tool for the specific model implementation
   */
  protected abstract formatTool(tool: Tool<SchemaType>): Record<string, unknown>;

  /**
   * Validate the model configuration
   */
  protected abstract validateConfig(): void;
}
