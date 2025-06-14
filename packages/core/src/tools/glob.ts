import { Tool } from '../tool';
import { z } from 'zod';
import { readdirSync, statSync, existsSync } from 'fs';
import { resolve, join, sep } from 'path';

/**
 * Glob tool for finding files using glob patterns
 * Supports standard glob patterns like **.js, src/**.ts, etc.
 */
export const globSearch = Tool.create({
  description: 'Find files using glob patterns (e.g., **.js, src/**.ts)',
  parameters: z.object({
    pattern: z.string().describe('The glob pattern to search for'),
    cwd: z
      .string()
      .optional()
      .describe('The directory to search in (defaults to current working directory)'),
    maxResults: z
      .number()
      .optional()
      .default(100)
      .describe('Maximum number of results to return'),
  }),
  execute: async ({ pattern, cwd = process.cwd(), maxResults = 100 }) => {
    try {
      const searchPath = resolve(cwd);
      
      if (!existsSync(searchPath)) {
        return {
          error: `Directory does not exist: ${searchPath}`,
          pattern,
          searchPath,
        };
      }

      const files = simpleGlob(pattern, searchPath, maxResults);

      const results = files.map((file) => {
        try {
          const stats = statSync(file);
          return {
            path: file,
            isDirectory: stats.isDirectory(),
            size: stats.size,
            modified: stats.mtime.toISOString(),
          };
        } catch {
          return {
            path: file,
            isDirectory: false,
            size: 0,
            modified: new Date().toISOString(),
            error: 'Could not read file stats',
          };
        }
      });

      return {
        files: results,
        totalFound: files.length,
        pattern,
        searchPath,
      };
    } catch (error) {
      return {
        error: `Glob search failed: ${error instanceof Error ? error.message : String(error)}`,
        pattern,
        searchPath: cwd,
      };
    }
  },
});

/**
 * Simple glob implementation for basic patterns
 * Supports: *.ext, **.ext, dir/*.ext, dir/**.ext
 */
function simpleGlob(pattern: string, basePath: string, maxResults: number): string[] {
  const results: string[] = [];
  const ignoreDirs = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

  function walkDir(dir: string, depth: number = 0): void {
    if (results.length >= maxResults || depth > 10) return;

    try {
      const entries = readdirSync(dir);
      
      for (const entry of entries) {
        if (results.length >= maxResults) break;
        
        const fullPath = join(dir, entry);
        const stats = statSync(fullPath);
        
        if (stats.isDirectory()) {
          // Skip ignored directories
          if (ignoreDirs.has(entry)) continue;
          
          // Recurse into subdirectories for ** patterns
          if (pattern.includes('**')) {
            walkDir(fullPath, depth + 1);
          }
        } else {
          // Check if file matches pattern
          if (matchesPattern(fullPath, pattern, basePath)) {
            results.push(fullPath);
          }
        }
      }
    } catch {
      // Skip directories that can't be read
    }
  }

  walkDir(basePath);
  return results;
}

/**
 * Check if a file path matches a glob pattern
 */
function matchesPattern(filePath: string, pattern: string, basePath: string): boolean {
  // Make path relative to base
  const relativePath = filePath.replace(basePath + sep, '');
  
  // Convert glob pattern to regex
  let regexPattern = pattern
    .replace(/\*\*/g, '___DOUBLESTAR___')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/___DOUBLESTAR___/g, '.*')
    .replace(/\./g, '\\.')
    .replace(/\?/g, '[^/\\\\]');
  
  // Handle directory separators on different platforms
  regexPattern = regexPattern.replace(/\//g, '[/\\\\]');
  
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(relativePath.replace(/\\/g, '/'));
}