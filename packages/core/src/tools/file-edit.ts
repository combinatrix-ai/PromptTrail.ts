import { Tool } from '../tool';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

/**
 * File edit tool for making precise changes to files
 * Uses find-and-replace approach for safe editing
 */
export const fileEdit = Tool.create({
  description: 'Edit files by replacing specific text content',
  parameters: z.object({
    file_path: z.string().describe('The absolute path to the file to edit'),
    old_string: z.string().describe('The exact text to replace'),
    new_string: z.string().describe('The text to replace it with'),
  }),
  execute: async ({ file_path, old_string, new_string }) => {
    const fullPath = resolve(file_path);

    // Validate inputs
    if (old_string === new_string) {
      throw new Error('old_string and new_string cannot be identical');
    }

    // Handle file creation (old_string is empty)
    if (old_string === '') {
      if (existsSync(fullPath)) {
        throw new Error('Cannot create file - file already exists');
      }

      // Create directory if it doesn't exist
      const dir = dirname(fullPath);
      mkdirSync(dir, { recursive: true });

      // Write new file
      writeFileSync(fullPath, new_string, 'utf8');

      return {
        file_path,
        operation: 'create',
        lines_added: new_string.split('\n').length,
        success: true,
      };
    }

    // Check if file exists for editing
    if (!existsSync(fullPath)) {
      throw new Error(`File does not exist: ${file_path}`);
    }

    // Read current content
    const currentContent = readFileSync(fullPath, 'utf8');

    // Check if old_string exists in file
    if (!currentContent.includes(old_string)) {
      throw new Error('The specified text to replace was not found in the file');
    }

    // Check for multiple matches (safety check)
    const matches = currentContent.split(old_string).length - 1;
    if (matches > 1) {
      throw new Error(
        `Found ${matches} matches of the text to replace. ` +
          'For safety, only single matches are supported. ' +
          'Please provide more specific context to make the match unique.'
      );
    }

    // Handle file deletion (new_string is empty)
    if (new_string === '') {
      const newContent = currentContent.replace(old_string, '');
      writeFileSync(fullPath, newContent, 'utf8');

      return {
        file_path,
        operation: 'delete',
        lines_removed: old_string.split('\n').length,
        success: true,
      };
    }

    // Perform replacement
    const newContent = currentContent.replace(old_string, new_string);
    writeFileSync(fullPath, newContent, 'utf8');

    // Calculate changes
    const oldLines = old_string.split('\n').length;
    const newLines = new_string.split('\n').length;

    return {
      file_path,
      operation: 'edit',
      lines_removed: oldLines,
      lines_added: newLines,
      net_change: newLines - oldLines,
      success: true,
    };
  },
});