import { describe, expect, it } from 'vitest';
import { ls } from '../../../tools/ls';

describe('ls tool', () => {
  it('should have correct tool configuration', () => {
    expect(ls.description).toContain('List files and directories');
    expect(ls.parameters).toBeDefined();
  });

  it('should have execute function', () => {
    expect(typeof ls.execute).toBe('function');
  });

  it('should handle non-existent directory', async () => {
    await expect(ls.execute({
      path: '/definitely-does-not-exist-123456',
    })).rejects.toThrow('Directory does not exist');
  });

  it('should list current directory', async () => {
    const result = await ls.execute({
      path: process.cwd(),
    });

    expect(result).toHaveProperty('items');
    expect(result).toHaveProperty('directory');
    expect(result).toHaveProperty('files');
    expect(result).toHaveProperty('directories');
    expect(Array.isArray(result.items)).toBe(true);
  });
});