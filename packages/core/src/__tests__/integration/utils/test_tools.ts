import { tool } from 'ai';
import { z } from 'zod';

/**
 * Create a calculator tool for testing
 */
export function createCalculatorTool() {
  return tool({
    description: 'A simple calculator that can perform basic operations',
    parameters: z.object({
      a: z.number().describe('First number'),
      b: z.number().describe('Second number'),
      operation: z
        .enum(['add', 'subtract', 'multiply', 'divide'])
        .describe('Operation to perform'),
    }),
    execute: async ({
      a,
      b,
      operation,
    }: {
      a: number;
      b: number;
      operation: 'add' | 'subtract' | 'multiply' | 'divide';
    }) => {
      switch (operation) {
        case 'add':
          return a + b;
        case 'subtract':
          return a - b;
        case 'multiply':
          return a * b;
        case 'divide':
          if (b === 0) throw new Error('Cannot divide by zero');
          return a / b;
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    },
  });
}

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
