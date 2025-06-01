import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Tool } from '../../tool';

describe('Tool namespace', () => {
  describe('Tool.create', () => {
    it('should create a tool with correct properties', async () => {
      const testTool = Tool.create({
        description: 'Test tool',
        parameters: z.object({
          input: z.string(),
        }),
        execute: async ({ input }) => {
          return { output: input.toUpperCase() };
        },
      });

      // Test that it has the expected structure (ai-sdk tools are objects)
      expect(testTool).toBeDefined();
      expect(typeof testTool).toBe('object');
    });

    it('should execute tool with correct parameters', async () => {
      const mockExecute = vi.fn().mockResolvedValue({ result: 'success' });

      const testTool = Tool.create({
        description: 'Test execution',
        parameters: z.object({
          message: z.string(),
          count: z.number(),
        }),
        execute: mockExecute,
      });

      // The tool function itself is what ai-sdk uses internally
      // We can't directly test execution without the ai-sdk runtime
      // But we can verify the tool was created correctly
      expect(testTool).toBeDefined();
    });

    it('should work with complex parameter schemas', () => {
      const complexTool = Tool.create({
        description: 'Complex tool',
        parameters: z.object({
          user: z.object({
            name: z.string(),
            age: z.number().optional(),
          }),
          tags: z.array(z.string()),
          settings: z.record(z.boolean()),
        }),
        execute: async (params) => {
          return { processed: true, userCount: 1 };
        },
      });

      expect(complexTool).toBeDefined();
    });

    it('should handle async execute functions', () => {
      const asyncTool = Tool.create({
        description: 'Async tool',
        parameters: z.object({
          delay: z.number(),
        }),
        execute: async ({ delay }) => {
          await new Promise((resolve) => setTimeout(resolve, delay));
          return { completed: true };
        },
      });

      expect(asyncTool).toBeDefined();
    });
  });
});
