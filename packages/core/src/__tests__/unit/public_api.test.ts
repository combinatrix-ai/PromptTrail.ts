import { describe, expect, it } from 'vitest';
import * as prompttrail from '../../index';

describe('public API surface', () => {
  it('does not re-export ai-sdk tool helpers from core', () => {
    expect(prompttrail).not.toHaveProperty('tool');
    expect(prompttrail).toHaveProperty('Tool');
  });
});
