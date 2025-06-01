import type { Message, MessageRole } from '../message';

import { tool } from 'ai';
import { expect } from 'vitest';
import { z } from 'zod';
import { Attrs } from '../session';

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
  messages: Message<Attrs>[],
  expectedtypes: MessageRole[],
) {
  expect(messages.length).toBe(expectedtypes.length);
  messages.forEach((message, index) => {
    expect(message.type).toBe(expectedtypes[index]);
  });
}

/**
 * Test function for both types and content
 */
export function expect_messages(
  messages: Message<Attrs>[],
  expectedMessages: Message<Attrs>[],
) {
  expect(messages.length).toBe(expectedMessages.length);
  messages.forEach((message, index) => {
    expect(message.type).toBe(expectedMessages[index].type);
    expect(message.content).toBe(expectedMessages[index].content);
  });
}
