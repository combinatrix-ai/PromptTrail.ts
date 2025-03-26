import type {
  Message,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolResultMessage,
} from '../types';

/**
 * Create a system message for testing
 */
export const createSystemMessage = (content: string): SystemMessage => ({
  type: 'system',
  content,
  metadata: {},
});

/**
 * Create a user message for testing
 */
export const createUserMessage = (content: string): UserMessage => ({
  type: 'user',
  content,
  metadata: {},
});

/**
 * Create an assistant message for testing
 */
export const createAssistantMessage = (content: string): AssistantMessage => ({
  type: 'assistant',
  content,
  metadata: {},
});

/**
 * Create a tool result message for testing
 */
export const createToolResultMessage = (
  content: string,
  result: unknown,
): ToolResultMessage => ({
  type: 'tool_result',
  content,
  result,
  metadata: {},
});

/**
 * Create a message of any type for testing
 */
export const createMessage = (
  type: Message['type'],
  content: string,
): Message => {
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
