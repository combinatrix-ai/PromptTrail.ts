import { describe, expect, it } from 'vitest';
import { globSearch } from '../../../tools/glob';

describe('globSearch tool', () => {
  it('should have correct tool configuration', () => {
    expect(globSearch.description).toBe('Find files using glob patterns (e.g., **.js, src/**.ts)');
    expect(globSearch.parameters).toBeDefined();
  });

  it('should have execute function', () => {
    expect(typeof globSearch.execute).toBe('function');
  });

  it('should handle basic pattern matching', async () => {
    // Test with current directory which should exist
    const result = await globSearch.execute({
      pattern: '*.json',
      cwd: process.cwd(),
      maxResults: 5,
    });

    expect(result).toHaveProperty('files');
    expect(result).toHaveProperty('totalFound');
    expect(result).toHaveProperty('pattern');
    expect(result).toHaveProperty('searchPath');
  });

  it('should handle non-existent directory gracefully', async () => {
    const result = await globSearch.execute({
      pattern: '*.js',
      cwd: '/definitely-does-not-exist-123456',
    });

    expect(result.error).toContain('Directory does not exist');
  });
});