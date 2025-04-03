import type {
  TMessage,
  ISystemMessage,
  IUserMessage,
  IAssistantMessage,
  IToolResultMessage,
  IToolResultMetadata,
} from '../types';
import { createMetadata } from '../metadata';

/**
 * Create a system message for testing
 */
export const createSystemMessage = (content: string): ISystemMessage => ({
  type: 'system',
  content,
  metadata: createMetadata(),
});

/**
 * Create a user message for testing
 */
export const createUserMessage = (content: string): IUserMessage => ({
  type: 'user',
  content,
  metadata: createMetadata(),
});

/**
 * Create an assistant message for testing
 */
export const createAssistantMessage = (content: string): IAssistantMessage => ({
  type: 'assistant',
  content,
  metadata: createMetadata(),
});

/**
 * Create a tool result message for testing
 */
export const createToolResultMessage = (
  content: string,
  result: unknown,
): IToolResultMessage => ({
  type: 'tool_result',
  content,
  result,
  metadata: createMetadata<IToolResultMetadata>({
    initial: { toolCallId: 'test-id' }
  }),
});

/**
 * Create a message of any type for testing
 */
export const createMessage = (
  type: TMessage['type'],
  content: string,
): TMessage => {
  switch (type) {
    case 'system':
      return createSystemMessage(content);
    case 'user':
      return createUserMessage(content);
    case 'assistant':
      return createAssistantMessage(content);
    case 'tool_result':
      return createToolResultMessage(content, {});
    default:
      throw new Error(`Unknown message type: ${type}`);
  }
};
