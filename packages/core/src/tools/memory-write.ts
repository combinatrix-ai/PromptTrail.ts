import { Tool } from '../tool';
import { z } from 'zod';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
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
 * Memory write tool for storing information in persistent conversation memory
 * Enables LLMs to remember important context across conversations
 */
export const memoryWrite = Tool.create({
  description: 'Write to persistent conversation memory to store important context for future sessions',
  parameters: z.object({
    content: z.string().describe('The information to store in memory'),
    category: z
      .string()
      .describe('Category for organizing this memory (e.g., "user_preferences", "project_context", "learned_facts")'),
    tags: z
      .array(z.string())
      .optional()
      .describe('Optional tags for better searchability'),
    memory_path: z
      .string()
      .optional()
      .describe('Custom path to memory file. Defaults to ~/.prompttrail/memory.json'),
    operation: z
      .enum(['add', 'update', 'delete'])
      .optional()
      .default('add')
      .describe('Operation type: add new entry, update existing, or delete'),
    entry_id: z
      .string()
      .optional()
      .describe('ID of entry to update or delete (required for update/delete operations)'),
    metadata: z
      .record(z.any())
      .optional()
      .describe('Optional metadata to store with the entry'),
    max_entries: z
      .number()
      .optional()
      .default(1000)
      .describe('Maximum number of entries to keep (oldest will be removed)'),
  }),
  execute: async ({ 
    content,
    category,
    tags,
    memory_path,
    operation = 'add',
    entry_id,
    metadata,
    max_entries = 1000
  }) => {
    // Default memory path
    const defaultMemoryPath = resolve(homedir(), '.prompttrail', 'memory.json');
    const memoryFilePath = memory_path ? resolve(memory_path) : defaultMemoryPath;

    // Ensure directory exists
    const memoryDir = dirname(memoryFilePath);
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    // Initialize or load existing memory
    let memoryData: MemoryData;
    
    if (existsSync(memoryFilePath)) {
      try {
        const existingContent = readFileSync(memoryFilePath, 'utf8');
        memoryData = JSON.parse(existingContent);
        
        // Validate structure
        if (!memoryData.entries || !Array.isArray(memoryData.entries)) {
          throw new Error('Invalid memory file format');
        }
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('Unexpected token')) {
          throw new Error(`Invalid JSON in memory file: ${memoryFilePath}`);
        }
        // If file is corrupted, start fresh but keep backup
        const backupPath = `${memoryFilePath}.backup.${Date.now()}`;
        try {
          writeFileSync(backupPath, readFileSync(memoryFilePath));
        } catch {
          // If backup fails, continue anyway
        }
        
        memoryData = {
          entries: [],
          lastUpdated: new Date().toISOString(),
          version: '1.0.0',
        };
      }
    } else {
      // Initialize new memory file
      memoryData = {
        entries: [],
        lastUpdated: new Date().toISOString(),
        version: '1.0.0',
      };
    }

    let operationResult = '';
    let modifiedEntry: MemoryEntry | null = null;

    try {
      if (operation === 'delete') {
        if (!entry_id) {
          throw new Error('entry_id is required for delete operation');
        }

        const entryIndex = memoryData.entries.findIndex(entry => entry.id === entry_id);
        if (entryIndex === -1) {
          throw new Error(`Entry with ID '${entry_id}' not found`);
        }

        const deletedEntry = memoryData.entries.splice(entryIndex, 1)[0];
        operationResult = `Deleted entry: ${deletedEntry.category} - ${deletedEntry.content.substring(0, 50)}...`;
        
      } else if (operation === 'update') {
        if (!entry_id) {
          throw new Error('entry_id is required for update operation');
        }

        const entryIndex = memoryData.entries.findIndex(entry => entry.id === entry_id);
        if (entryIndex === -1) {
          throw new Error(`Entry with ID '${entry_id}' not found`);
        }

        const existingEntry = memoryData.entries[entryIndex];
        modifiedEntry = {
          ...existingEntry,
          content,
          category,
          tags: tags || existingEntry.tags,
          metadata: metadata || existingEntry.metadata,
          timestamp: new Date().toISOString(), // Update timestamp
        };

        memoryData.entries[entryIndex] = modifiedEntry;
        operationResult = `Updated entry: ${category} - ${content.substring(0, 50)}...`;
        
      } else { // add
        // Generate unique ID
        const entryId = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        
        modifiedEntry = {
          id: entryId,
          timestamp: new Date().toISOString(),
          category,
          content,
          tags,
          metadata,
        };

        memoryData.entries.push(modifiedEntry);
        operationResult = `Added new entry: ${category} - ${content.substring(0, 50)}...`;
        
        // Enforce max entries limit by removing oldest
        if (memoryData.entries.length > max_entries) {
          // Sort by timestamp and remove oldest
          memoryData.entries.sort((a, b) => 
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
          );
          
          const removedCount = memoryData.entries.length - max_entries;
          memoryData.entries = memoryData.entries.slice(removedCount);
          
          operationResult += ` (Removed ${removedCount} oldest entries to maintain limit)`;
        }
      }

      // Update metadata
      memoryData.lastUpdated = new Date().toISOString();

      // Write updated memory back to file
      const updatedContent = JSON.stringify(memoryData, null, 2);
      writeFileSync(memoryFilePath, updatedContent, 'utf8');

      // Generate summary statistics
      const categoryCounts = memoryData.entries.reduce((acc, entry) => {
        acc[entry.category] = (acc[entry.category] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

      return {
        success: true,
        memory_path: memoryFilePath,
        operation: operationResult,
        entry_id: modifiedEntry?.id || entry_id,
        total_entries: memoryData.entries.length,
        category_counts: categoryCounts,
        available_categories: Object.keys(categoryCounts),
        last_updated: memoryData.lastUpdated,
      };

    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write to memory: ${errorMessage}`);
    }
  },
});