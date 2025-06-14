import { Tool } from '../tool';
import { z } from 'zod';
import { readdirSync, statSync, existsSync } from 'fs';
import { resolve, join } from 'path';

/**
 * LS tool for listing directory contents
 * Provides detailed file and directory information
 */
export const ls = Tool.create({
  description: 'List files and directories with detailed information',
  parameters: z.object({
    path: z
      .string()
      .describe('The absolute path to the directory to list'),
    show_hidden: z
      .boolean()
      .optional()
      .default(false)
      .describe('Whether to show hidden files (starting with .)'),
    recursive: z
      .boolean()
      .optional()
      .default(false)
      .describe('Whether to list subdirectories recursively'),
    ignore: z
      .array(z.string())
      .optional()
      .describe('Glob patterns to ignore'),
  }),
  execute: async ({ path, show_hidden = false, recursive = false, ignore = [] }) => {
    const fullPath = resolve(path);

    if (!existsSync(fullPath)) {
      throw new Error(`Directory does not exist: ${path}`);
    }

    const stats = statSync(fullPath);
    if (!stats.isDirectory()) {
      throw new Error(`Path is not a directory: ${path}`);
    }

    // Default ignore patterns
    const defaultIgnore = ['node_modules', '.git', '.DS_Store'];
    const allIgnorePatterns = [...defaultIgnore, ...ignore];

    const shouldIgnore = (name: string): boolean => {
      if (!show_hidden && name.startsWith('.')) {
        return true;
      }
      return allIgnorePatterns.some(pattern => {
        // Simple pattern matching - replace * with .*
        const regex = new RegExp(pattern.replace(/\*/g, '.*'));
        return regex.test(name);
      });
    };

    interface FileEntry {
      name: string;
      path: string;
      isDirectory: boolean;
      type: 'file' | 'directory';
      size?: number;
      modified?: string;
      depth: number;
      children?: FileEntry[];
    }

    const listDirectory = (dirPath: string, depth: number = 0): FileEntry[] => {
      try {
        const entries = readdirSync(dirPath, { withFileTypes: true });
        const results: FileEntry[] = [];

        for (const entry of entries) {
          if (shouldIgnore(entry.name)) {
            continue;
          }

          const fullEntryPath = join(dirPath, entry.name);
          const entryStats = statSync(fullEntryPath);

          const item: FileEntry = {
            name: entry.name,
            path: fullEntryPath,
            isDirectory: entry.isDirectory(),
            type: entry.isDirectory() ? 'directory' : 'file',
            size: entry.isFile() ? entryStats.size : undefined,
            modified: entryStats.mtime.toISOString(),
            depth,
          };

          results.push(item);

          // Recursively list subdirectories if requested
          if (recursive && entry.isDirectory() && depth < 10) { // Limit depth to prevent infinite recursion
            const subItems = listDirectory(fullEntryPath, depth + 1);
            results.push(...subItems);
          }
        }

        return results;
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to list directory: ${errorMessage}`);
      }
    };

    const items = listDirectory(fullPath);

    // Sort: directories first, then files, alphabetically within each group
    const sortedItems = items.sort((a, b) => {
      // First by depth (for recursive listing)
      if (a.depth !== b.depth) {
        return a.depth - b.depth;
      }
      
      // Then by type (directories first)
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      
      // Finally alphabetically
      return a.name.localeCompare(b.name);
    });

    return {
      directory: fullPath,
      total_items: sortedItems.length,
      directories: sortedItems.filter(item => item.type === 'directory').length,
      files: sortedItems.filter(item => item.type === 'file').length,
      show_hidden,
      recursive,
      ignored_patterns: allIgnorePatterns,
      items: sortedItems,
    };
  },
});