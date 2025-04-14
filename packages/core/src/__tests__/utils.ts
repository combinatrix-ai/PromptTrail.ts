import type {
  TMessage,
  ISystemMessage,
  IUserMessage,
  IAssistantMessage,
  IToolResultMessage,
  IToolResultMetadata,
} from '../types';
import { createMetadata } from '../metadata';

import { tool } from 'ai';
import { expect } from 'vitest';
import { z } from 'zod';
import { Message, MessageRole } from '@core/types';

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
    initial: { toolCallId: 'test-id' },
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



/**
 * Create a weather tool for testing
 */
export function createWeatherTool() {
  return tool({
    description: 'Get weather information',
    parameters: z.object({
      location: z.string().describe('Location to get weather information for'),
    }),
    execute: async (input: { location: string }) => {
      const location = input.location;
      // const _weatherCondition = '72°F and Thunderstorms';
      const forecast = [
        'Today: Thunderstorms',
        'Tomorrow: Cloudy',
        'Monday: Rainy',
      ];
      return {
        location,
        temperature: 72,
        condition: 'Thunderstorms',
        forecast,
      };
    },
  });
}

/**
 * Test function for message types
 */
export function expect_types(
  messages: Message[],
  expectedtypes: MessageRole[],
) {
  expect(messages.length).toBe(expectedtypes.length);
  messages.forEach((message, index) => {
    expect(message.type).toBe(expectedtypes[index]);
  });
}

/**
 * Test function for message content
 */
export function expect_content(messages: Message[], expectedContent: string[]) {
  expect(messages.length).toBe(expectedContent.length);
  messages.forEach((message, index) => {
    expect(message.content).toBe(expectedContent[index]);
  });
}

/**
 * Test function for both types and content
 */
export function expect_messages(
  messages: Message[],
  expectedMessages: Message[],
) {
  expect(messages.length).toBe(expectedMessages.length);
  messages.forEach((message, index) => {
    expect(message.type).toBe(expectedMessages[index].type);
    expect(message.content).toBe(expectedMessages[index].content);
  });
}
