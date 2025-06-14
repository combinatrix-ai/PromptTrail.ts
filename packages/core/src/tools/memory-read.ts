import { Tool } from '../tool';
import { z } from 'zod';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { homedir } from 'os';

interface MemoryEntry {
  id: string;
  timestamp: string;
  category: string;
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

interface MemoryData {
  entries: MemoryEntry[];
  lastUpdated: string;
  version: string;
}

/**
 * Memory read tool for accessing persistent conversation memory
 * Enables LLMs to maintain context across conversations
 */
export const memoryRead = Tool.create({
  description: 'Read from persistent conversation memory to maintain context across sessions',
  parameters: z.object({
    memory_path: z
      .string()
      .optional()
      .describe('Custom path to memory file. Defaults to ~/.prompttrail/memory.json'),
    category: z
      .string()
      .optional()
      .describe('Filter entries by category (e.g., "user_preferences", "project_context", "learned_facts")'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Filter entries that contain any of these tags'),
    search_content: z
      .string()
      .optional()
      .describe('Search for entries containing this text in their content'),
    limit: z
      .number()
      .optional()
      .default(50)
      .describe('Maximum number of entries to return (default: 50)'),
    sort_by: z
      .enum(['timestamp', 'category', 'relevance'])
      .optional()
      .default('timestamp')
      .describe('Sort entries by timestamp (newest first), category, or relevance to search'),
  }),
  execute: async ({ 
    memory_path,
    category,
    tags,
    search_content,
    limit = 50,
    sort_by = 'timestamp'
  }) => {
    // Default memory path
    const defaultMemoryPath = resolve(homedir(), '.prompttrail', 'memory.json');
    const memoryFilePath = memory_path ? resolve(memory_path) : defaultMemoryPath;

    // Ensure directory exists
    const memoryDir = dirname(memoryFilePath);
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    // Initialize empty memory if file doesn't exist
    if (!existsSync(memoryFilePath)) {
      return {
        memory_path: memoryFilePath,
        entries: [],
        total_entries: 0,
        filtered_count: 0,
        filters_applied: {
          category,
          tags,
          search_content,
        },
      };
    }

    try {
      const content = readFileSync(memoryFilePath, 'utf8');
      const memoryData: MemoryData = JSON.parse(content);

      if (!memoryData.entries || !Array.isArray(memoryData.entries)) {
        throw new Error('Invalid memory file format: missing or invalid entries array');
      }

      let filteredEntries = [...memoryData.entries];

      // Apply category filter
      if (category) {
        filteredEntries = filteredEntries.filter(entry => 
          entry.category.toLowerCase().includes(category.toLowerCase())
        );
      }

      // Apply tags filter
      if (tags && tags.length > 0) {
        filteredEntries = filteredEntries.filter(entry =>
          entry.tags && entry.tags.some(tag => 
            tags.some(filterTag => 
              tag.toLowerCase().includes(filterTag.toLowerCase())
            )
          )
        );
      }

      // Apply content search filter
      if (search_content) {
        const searchLower = search_content.toLowerCase();
        filteredEntries = filteredEntries.filter(entry =>
          entry.content.toLowerCase().includes(searchLower) ||
          entry.category.toLowerCase().includes(searchLower) ||
          (entry.tags && entry.tags.some(tag => 
            tag.toLowerCase().includes(searchLower)
          ))
        );
      }

      // Sort entries
      if (sort_by === 'timestamp') {
        filteredEntries.sort((a, b) => 
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
        );
      } else if (sort_by === 'category') {
        filteredEntries.sort((a, b) => a.category.localeCompare(b.category));
      } else if (sort_by === 'relevance' && search_content) {
        // Simple relevance scoring based on search term frequency
        const searchLower = search_content.toLowerCase();
        filteredEntries.sort((a, b) => {
          const scoreA = (a.content.toLowerCase().match(new RegExp(searchLower, 'g')) || []).length;
          const scoreB = (b.content.toLowerCase().match(new RegExp(searchLower, 'g')) || []).length;
          return scoreB - scoreA;
        });
      }

      // Apply limit
      const limitedEntries = filteredEntries.slice(0, limit);

      // Group entries by category for better organization
      const entriesByCategory = limitedEntries.reduce((acc, entry) => {
        if (!acc[entry.category]) {
          acc[entry.category] = [];
        }
        acc[entry.category].push(entry);
        return acc;
      }, {} as Record<string, MemoryEntry[]>);

      return {
        memory_path: memoryFilePath,
        entries: limitedEntries,
        entries_by_category: entriesByCategory,
        total_entries: memoryData.entries.length,
        filtered_count: filteredEntries.length,
        returned_count: limitedEntries.length,
        filters_applied: {
          category,
          tags,
          search_content,
          sort_by,
          limit,
        },
        last_updated: memoryData.lastUpdated,
        available_categories: Array.from(new Set(memoryData.entries.map(e => e.category))),
        available_tags: Array.from(new Set(memoryData.entries.flatMap(e => e.tags || []))),
      };

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Unexpected token')) {
        throw new Error(`Invalid JSON in memory file: ${memoryFilePath}`);
      }
      throw new Error(`Failed to read memory: ${errorMessage}`);
    }
  },
});