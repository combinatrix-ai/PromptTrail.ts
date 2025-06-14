import { Tool } from '../tool';
import { z } from 'zod';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Bash tool for executing shell commands
 * Provides a safe way to run terminal commands with proper error handling
 */
export const bash = Tool.create({
  description: 'Execute bash commands in the terminal with optional timeout',
  parameters: z.object({
    command: z.string().describe('The bash command to execute'),
    timeout: z
      .number()
      .optional()
      .default(120000)
      .describe('Timeout in milliseconds (default: 2 minutes)'),
  }),
  execute: async ({ command, timeout = 120000 }) => {
    try {
      const result = await execAsync(command, {
        timeout,
        maxBuffer: 1024 * 1024, // 1MB buffer
      });

      return {
        success: true,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: 0,
      };
    } catch (error: unknown) {
      const execError = error as { 
        signal?: string; 
        killed?: boolean; 
        stdout?: string; 
        stderr?: string; 
        code?: number; 
        message?: string; 
      };
      
      // Handle timeout
      if (execError.signal === 'SIGTERM' || execError.killed) {
        return {
          success: false,
          stdout: execError.stdout || '',
          stderr: (execError.stderr || '') + '\n<Command timed out>',
          exitCode: execError.code || 1,
          interrupted: true,
        };
      }

      // Handle command execution errors
      return {
        success: false,
        stdout: execError.stdout || '',
        stderr: execError.stderr || execError.message || String(error),
        exitCode: execError.code || 1,
      };
    }
  },
});