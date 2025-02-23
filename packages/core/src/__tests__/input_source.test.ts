import { describe, expect, it, vi } from 'vitest';
import { DefaultInputSource, CallbackInputSource } from '../input_source';

describe('InputSource', () => {
  describe('DefaultInputSource', () => {
    it('should return default value when provided', async () => {
      const source = new DefaultInputSource();
      const input = await source.getInput({
        description: 'test',
        defaultValue: 'default',
      });
      expect(input).toBe('default');
    });

    it('should return empty string when no default value', async () => {
      const source = new DefaultInputSource();
      const input = await source.getInput({
        description: 'test',
      });
      expect(input).toBe('');
    });
  });

  describe('CallbackInputSource', () => {
    it('should call callback with context', async () => {
      const callback = vi.fn().mockResolvedValue('test input');
      const source = new CallbackInputSource(callback);
      const context = {
        description: 'test',
        defaultValue: 'default',
        metadata: { key: 'value' },
      };

      const input = await source.getInput(context);
      expect(input).toBe('test input');
      expect(callback).toHaveBeenCalledWith(context);
    });
  });
});
