import { Tool } from '../tool';
import { z } from 'zod';
import { readFileSync, existsSync, statSync, readdirSync } from 'fs';
import { resolve, join, extname } from 'path';

/**
 * Grep tool for searching file contents using regular expressions
 * Fast content search that works with any codebase size
 */
export const grep = Tool.create({
  description: 'Search file contents using regular expressions',
  parameters: z.object({
    pattern: z.string().describe('The regular expression pattern to search for'),
    path: z
      .string()
      .optional()
      .describe('The directory to search in (defaults to current working directory)'),
    include: z
      .string()
      .optional()
      .describe('File pattern to include (e.g., "*.js", "*.{ts,tsx}")'),
    exclude: z
      .array(z.string())
      .optional()
      .describe('Patterns to exclude from search'),
  }),
  execute: async ({ pattern, path = process.cwd(), include, exclude = [] }) => {
    const searchDir = resolve(path);

    if (!existsSync(searchDir)) {
      throw new Error(`Search directory does not exist: ${path}`);
    }

    try {
      const regex = new RegExp(pattern, 'gi');
      const results: Array<{
        file: string;
        matches: Array<{
          line_number: number;
          line_content: string;
          match_start: number;
          match_end: number;
        }>;
      }> = [];

      // Default exclude patterns
      const defaultExclude = [
        'node_modules',
        '.git',
        '.next',
        'dist',
        'build',
        '*.log',
        '.DS_Store',
      ];
      const allExcludePatterns = [...defaultExclude, ...exclude];

      const searchFiles = (dir: string): void => {
        const entries = readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = join(dir, entry.name);

          // Skip excluded patterns
          if (
            allExcludePatterns.some((pattern) =>
              entry.name.includes(pattern.replace('*', ''))
            )
          ) {
            continue;
          }

          if (entry.isDirectory()) {
            searchFiles(fullPath);
          } else if (entry.isFile()) {
            // Apply include filter if specified
            if (include) {
              const includePattern = include.replace(/\*/g, '.*').replace(/\{|\}/g, '');
              const includeRegex = new RegExp(includePattern);
              if (!includeRegex.test(entry.name)) {
                continue;
              }
            }

            // Skip binary files
            const ext = extname(entry.name).toLowerCase();
            const textExtensions = [
              '.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.cpp',
              '.h', '.css', '.html', '.xml', '.json', '.yaml', '.yml',
              '.md', '.txt', '.sh', '.sql', '.go', '.rs', '.php', '.rb',
            ];
            
            if (ext && !textExtensions.includes(ext)) {
              continue;
            }

            try {
              const content = readFileSync(fullPath, 'utf8');
              const lines = content.split('\n');
              const fileMatches: Array<{
                line_number: number;
                line_content: string;
                match_start: number;
                match_end: number;
              }> = [];

              lines.forEach((line, index) => {
                let match;
                while ((match = regex.exec(line)) !== null) {
                  fileMatches.push({
                    line_number: index + 1,
                    line_content: line,
                    match_start: match.index,
                    match_end: match.index + match[0].length,
                  });
                  
                  // Prevent infinite loop on zero-length matches
                  if (match.index === regex.lastIndex) {
                    regex.lastIndex++;
                  }
                }
                // Reset regex lastIndex for next line
                regex.lastIndex = 0;
              });

              if (fileMatches.length > 0) {
                results.push({
                  file: fullPath,
                  matches: fileMatches,
                });
              }
            } catch {
              // Skip files that can't be read (binary, permissions, etc.)
              continue;
            }
          }
        }
      };

      searchFiles(searchDir);

      // Sort results by modification time (most recent first)
      const sortedResults = results
        .map((result) => {
          try {
            const stats = statSync(result.file);
            return { ...result, mtime: stats.mtime };
          } catch {
            return { ...result, mtime: new Date(0) };
          }
        })
        .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
        .map(({ mtime: _, ...result }) => result); // eslint-disable-line @typescript-eslint/no-unused-vars

      return {
        pattern,
        search_directory: searchDir,
        include_pattern: include,
        exclude_patterns: allExcludePatterns,
        results: sortedResults,
        total_files_with_matches: sortedResults.length,
        total_matches: sortedResults.reduce(
          (sum, result) => sum + result.matches.length,
          0
        ),
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Invalid regular expression')) {
        throw new Error(`Invalid regex pattern: ${pattern}`);
      }
      throw new Error(`Grep search failed: ${errorMessage}`);
    }
  },
});