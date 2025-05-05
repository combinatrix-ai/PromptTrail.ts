import type { Message } from '../message';
import type { MessageRole } from '../message';

import { tool } from 'ai';
import { Context, createMetadata, Metadata } from '../tagged_record';
import { expect } from 'vitest';
import { z } from 'zod';
import { Composite } from '@core/templates';

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
  messages: Message<Metadata>[],
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
export function expect_content(
  messages: Message<Metadata>[],
  expectedContent: string[],
) {
  expect(messages.length).toBe(expectedContent.length);
  messages.forEach((message, index) => {
    expect(message.content).toBe(expectedContent[index]);
  });
}

/**
 * Test function for both types and content
 */
export function expect_messages(
  messages: Message<Metadata>[],
  expectedMessages: Message<Metadata>[],
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
): Message<Metadata> {
  return {
    type,
    content,
    metadata: createMetadata<Metadata>(),
  };
}

export function limitLoopIterations<
  TMetadata extends Metadata,
  TContext extends Context,
>(
  template: Composite<TMetadata, TContext>,
  maxIterations: number = 5,
): Composite<TMetadata, TContext> {
  template.setMaxIterations(maxIterations);
  return template;
}
