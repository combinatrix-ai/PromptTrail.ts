import type { Message } from '../message';
import type { MessageRole } from '../message';

import { tool } from 'ai';
import { createMetadata } from '../metadata';
import { expect } from 'vitest';
import { z } from 'zod';

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

/**
 * Create a message with the given type and content
 */
export function createMessage(
  type: 'system' | 'user' | 'assistant',
  content: string,
): Message {
  return {
    type,
    content,
    metadata: createMetadata(),
  };
}
