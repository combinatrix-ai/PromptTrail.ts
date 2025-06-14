import { Tool } from '../tool';
import { z } from 'zod';
import { readFileSync, existsSync, statSync } from 'fs';
import { resolve } from 'path';

/**
 * File read tool for reading file contents
 * Supports text files with optional line range specification
 */
export const fileRead = Tool.create({
  description: 'Read file contents with optional line range',
  parameters: z.object({
    file_path: z.string().describe('The absolute path to the file to read'),
    offset: z
      .number()
      .optional()
      .describe('Starting line number (1-based) for partial reading'),
    limit: z
      .number()
      .optional()
      .describe('Number of lines to read from the offset'),
  }),
  execute: async ({ file_path, offset, limit }) => {
    const fullPath = resolve(file_path);

    // Check if file exists
    if (!existsSync(fullPath)) {
      throw new Error(`File does not exist: ${file_path}`);
    }

    // Get file stats
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      throw new Error(`Path is a directory, not a file: ${file_path}`);
    }

    try {
      const content = readFileSync(fullPath, 'utf8');
      const lines = content.split('\n');

      // If no offset/limit specified, return full content
      if (offset === undefined && limit === undefined) {
        return {
          file_path,
          content,
          total_lines: lines.length,
          lines_returned: lines.length,
          start_line: 1,
        };
      }

      // Calculate line range
      const startLine = Math.max(1, offset || 1);
      const startIndex = startLine - 1;
      const endIndex = limit
        ? Math.min(lines.length, startIndex + limit)
        : lines.length;

      const selectedLines = lines.slice(startIndex, endIndex);
      const selectedContent = selectedLines.join('\n');

      return {
        file_path,
        content: selectedContent,
        total_lines: lines.length,
        lines_returned: selectedLines.length,
        start_line: startLine,
        end_line: startLine + selectedLines.length - 1,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read file: ${errorMessage}`);
    }
  },
});