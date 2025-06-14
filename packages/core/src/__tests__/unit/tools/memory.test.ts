import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { memoryRead } from '../../../tools/memory-read';
import { memoryWrite } from '../../../tools/memory-write';

describe('Memory Tools', () => {
  const testDir = resolve(__dirname, 'test-memory');
  const testMemoryPath = resolve(testDir, 'test-memory.json');

  beforeEach(() => {
    // Create test directory
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    // Clean up test files
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('memoryWrite', () => {
    it('should create new memory file and add entry', async () => {
      const result = await (memoryWrite as any).execute({
        content: 'User prefers dark mode',
        category: 'user_preferences',
        tags: ['ui', 'preferences'],
        memory_path: testMemoryPath
      });

      expect(result.success).toBe(true);
      expect(result.total_entries).toBe(1);
      expect(result.operation).toContain('Added new entry: user_preferences');
      expect(result.entry_id).toBeDefined();

      // Verify file was created
      expect(existsSync(testMemoryPath)).toBe(true);
      const memoryData = JSON.parse(readFileSync(testMemoryPath, 'utf8'));
      expect(memoryData.entries).toHaveLength(1);
      expect(memoryData.entries[0].content).toBe('User prefers dark mode');
      expect(memoryData.entries[0].category).toBe('user_preferences');
      expect(memoryData.entries[0].tags).toEqual(['ui', 'preferences']);
    });

    it('should add multiple entries', async () => {
      // Add first entry
      await (memoryWrite as any).execute({
        content: 'User works on TypeScript projects',
        category: 'project_context',
        memory_path: testMemoryPath
      });

      // Add second entry
      const result = await (memoryWrite as any).execute({
        content: 'User prefers semicolons in code',
        category: 'code_style',
        tags: ['typescript', 'formatting'],
        memory_path: testMemoryPath
      });

      expect(result.total_entries).toBe(2);
      expect(result.category_counts).toEqual({
        project_context: 1,
        code_style: 1
      });
    });

    it('should update existing entry', async () => {
      // Add initial entry
      const addResult = await (memoryWrite as any).execute({
        content: 'Initial content',
        category: 'test_category',
        memory_path: testMemoryPath
      });

      // Update the entry
      const updateResult = await (memoryWrite as any).execute({
        content: 'Updated content',
        category: 'test_category',
        entry_id: addResult.entry_id,
        operation: 'update',
        memory_path: testMemoryPath
      });

      expect(updateResult.success).toBe(true);
      expect(updateResult.operation).toContain('Updated entry');
      expect(updateResult.total_entries).toBe(1);

      // Verify update
      const memoryData = JSON.parse(readFileSync(testMemoryPath, 'utf8'));
      expect(memoryData.entries[0].content).toBe('Updated content');
    });

    it('should delete entry', async () => {
      // Add entry
      const addResult = await (memoryWrite as any).execute({
        content: 'To be deleted',
        category: 'temporary',
        memory_path: testMemoryPath
      });

      // Delete the entry
      const deleteResult = await (memoryWrite as any).execute({
        content: '', // Not used for delete
        entry_id: addResult.entry_id,
        operation: 'delete',
        memory_path: testMemoryPath
      });

      expect(deleteResult.success).toBe(true);
      expect(deleteResult.operation).toContain('Deleted entry');
      expect(deleteResult.total_entries).toBe(0);
    });

    it('should enforce max entries limit', async () => {
      // Add entries beyond limit
      for (let i = 0; i < 5; i++) {
        await (memoryWrite as any).execute({
          content: `Entry ${i}`,
          category: 'test',
          memory_path: testMemoryPath,
          max_entries: 3
        });
      }

      const memoryData = JSON.parse(readFileSync(testMemoryPath, 'utf8'));
      expect(memoryData.entries).toHaveLength(3);
      
      // Should keep the most recent entries
      expect(memoryData.entries[0].content).toBe('Entry 2');
      expect(memoryData.entries[2].content).toBe('Entry 4');
    });
  });

  describe('memoryRead', () => {
    beforeEach(async () => {
      // Add some test data
      await (memoryWrite as any).execute({
        content: 'User prefers dark mode in IDE',
        category: 'user_preferences',
        tags: ['ui', 'ide'],
        memory_path: testMemoryPath
      });

      await (memoryWrite as any).execute({
        content: 'Working on PromptTrail.ts project',
        category: 'project_context',
        tags: ['typescript', 'ai', 'tools'],
        memory_path: testMemoryPath
      });

      await (memoryWrite as any).execute({
        content: 'Learned that semicolons are preferred',
        category: 'learned_facts',
        tags: ['typescript', 'coding'],
        memory_path: testMemoryPath
      });
    });

    it('should read all entries', async () => {
      const result = await (memoryRead as any).execute({
        memory_path: testMemoryPath
      });

      expect(result.total_entries).toBe(3);
      expect(result.entries).toHaveLength(3);
      expect(result.filtered_count).toBe(3);
      expect(result.available_categories).toEqual(
        expect.arrayContaining(['user_preferences', 'project_context', 'learned_facts'])
      );
    });

    it('should filter by category', async () => {
      const result = await (memoryRead as any).execute({
        memory_path: testMemoryPath,
        category: 'user_preferences'
      });

      expect(result.filtered_count).toBe(1);
      expect(result.entries[0].category).toBe('user_preferences');
      expect(result.entries[0].content).toContain('dark mode');
    });

    it('should filter by tags', async () => {
      const result = await (memoryRead as any).execute({
        memory_path: testMemoryPath,
        tags: ['typescript']
      });

      expect(result.filtered_count).toBe(2);
      expect(result.entries.every(entry => 
        entry.tags?.includes('typescript')
      )).toBe(true);
    });

    it('should search content', async () => {
      const result = await (memoryRead as any).execute({
        memory_path: testMemoryPath,
        search_content: 'dark mode'
      });

      expect(result.filtered_count).toBe(1);
      expect(result.entries[0].content).toContain('dark mode');
    });

    it('should apply limit', async () => {
      const result = await (memoryRead as any).execute({
        memory_path: testMemoryPath,
        limit: 2
      });

      expect(result.returned_count).toBe(2);
      expect(result.entries).toHaveLength(2);
      expect(result.filtered_count).toBe(3); // Total matching
    });

    it('should sort by category', async () => {
      const result = await (memoryRead as any).execute({
        memory_path: testMemoryPath,
        sort_by: 'category'
      });

      const categories = result.entries.map((entry: any) => entry.category);
      const sortedCategories = [...categories].sort();
      expect(categories).toEqual(sortedCategories);
    });

    it('should group entries by category', async () => {
      const result = await (memoryRead as any).execute({
        memory_path: testMemoryPath
      });

      expect(result.entries_by_category).toBeDefined();
      expect(result.entries_by_category.user_preferences).toHaveLength(1);
      expect(result.entries_by_category.project_context).toHaveLength(1);
      expect(result.entries_by_category.learned_facts).toHaveLength(1);
    });

    it('should handle non-existent memory file', async () => {
      const nonExistentPath = resolve(testDir, 'non-existent-memory.json');
      const result = await (memoryRead as any).execute({
        memory_path: nonExistentPath
      });

      expect(result.entries).toEqual([]);
      expect(result.total_entries).toBe(0);
      expect(result.filtered_count).toBe(0);
    });

    it('should return available tags', async () => {
      const result = await (memoryRead as any).execute({
        memory_path: testMemoryPath
      });

      expect(result.available_tags).toEqual(
        expect.arrayContaining(['ui', 'ide', 'typescript', 'ai', 'tools', 'coding'])
      );
    });
  });
});