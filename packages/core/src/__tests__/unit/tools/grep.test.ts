import { describe, expect, it } from 'vitest';
import { grep } from '../../../tools/grep';

describe('grep tool', () => {
  it('should have correct tool configuration', () => {
    expect(grep.description).toContain('Search file contents using regular expressions');
    expect(grep.parameters).toBeDefined();
  });

  it('should have execute function', () => {
    expect(typeof grep.execute).toBe('function');
  });

  it('should handle non-existent paths', async () => {
    await expect(grep.execute({
      pattern: 'test',
      path: '/definitely-does-not-exist-123456',
    })).rejects.toThrow('Search directory does not exist');
  });

  it('should validate regex patterns', async () => {
    await expect(grep.execute({
      pattern: '[invalid',
      path: process.cwd(),
    })).rejects.toThrow('Invalid regex pattern');
  });
});