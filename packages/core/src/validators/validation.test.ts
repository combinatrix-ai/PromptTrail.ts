import { describe, expect, it } from 'vitest';
import { Session } from '../session';
import { Validation } from './validation';

describe('Validation namespace', () => {
  describe('regex', () => {
    it('should create a regex match validator', async () => {
      const validator = Validation.regex(/test/);
      const result = await validator.validate(
        'this is a test',
        Session.create(),
      );
      expect(result.isValid).toBe(true);
    });

    it('should create a regex no-match validator', async () => {
      const validator = Validation.regex(/test/, { noMatch: true });
      const result = await validator.validate(
        'this has no match',
        Session.create(),
      );
      expect(result.isValid).toBe(true);
    });

    it('should accept string patterns', async () => {
      const validator = Validation.regex('\\d+', { flags: 'g' });
      const result = await validator.validate('123', Session.create());
      expect(result.isValid).toBe(true);
    });
  });

  describe('keyword', () => {
    it('should create an include keyword validator', async () => {
      const validator = Validation.keyword(['foo', 'bar']);
      const result = await validator.validate(
        'this has foo in it',
        Session.create(),
      );
      expect(result.isValid).toBe(true);
    });

    it('should create an exclude keyword validator', async () => {
      const validator = Validation.keyword('forbidden', { mode: 'exclude' });
      const result = await validator.validate(
        'this is clean',
        Session.create(),
      );
      expect(result.isValid).toBe(true);
    });

    it('should handle case sensitivity', async () => {
      const validator = Validation.keyword('FOO', { caseSensitive: true });
      const result = await validator.validate('foo', Session.create());
      expect(result.isValid).toBe(false);
    });
  });

  describe('length', () => {
    it('should validate minimum length', async () => {
      const validator = Validation.length({ min: 5 });
      const result = await validator.validate('hello', Session.create());
      expect(result.isValid).toBe(true);
    });

    it('should validate maximum length', async () => {
      const validator = Validation.length({ max: 5 });
      const result = await validator.validate('hi', Session.create());
      expect(result.isValid).toBe(true);
    });

    it('should validate both min and max', async () => {
      const validator = Validation.length({ min: 2, max: 5 });
      const result = await validator.validate('hey', Session.create());
      expect(result.isValid).toBe(true);
    });
  });

  describe('json', () => {
    it('should validate JSON', async () => {
      const validator = Validation.json();
      const result = await validator.validate(
        '{"key": "value"}',
        Session.create(),
      );
      expect(result.isValid).toBe(true);
    });

    it('should validate JSON with schema', async () => {
      const validator = Validation.json({ schema: { name: true } });
      const result = await validator.validate(
        '{"name": "test"}',
        Session.create(),
      );
      expect(result.isValid).toBe(true);
    });
  });

  describe('schema', () => {
    it('should validate against schema', async () => {
      const validator = Validation.schema({
        properties: {
          name: { type: 'string', description: 'Name' },
          age: { type: 'number', description: 'Age' },
        },
        required: ['name'],
      });
      const result = await validator.validate(
        '{"name": "John", "age": 30}',
        Session.create(),
      );
      expect(result.isValid).toBe(true);
    });
  });

  describe('custom', () => {
    it('should accept boolean validators', async () => {
      const validator = Validation.custom((content) => content.length > 5);
      const result = await validator.validate('hello world', Session.create());
      expect(result.isValid).toBe(true);
    });

    it('should accept async validators', async () => {
      const validator = Validation.custom(async (content) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return content === 'valid';
      });
      const result = await validator.validate('valid', Session.create());
      expect(result.isValid).toBe(true);
    });

    it('should accept validators returning TValidationResult', async () => {
      const validator = Validation.custom(() => ({
        isValid: false,
        instruction: 'Custom error',
      }));
      const result = await validator.validate('anything', Session.create());
      expect(result.isValid).toBe(false);
      if (result.isValid) {
        throw new Error('expected invalid result');
      }
      expect(result.instruction).toBe('Custom error');
    });
  });

  describe('all', () => {
    it('should combine validators with AND logic', async () => {
      const validator = Validation.all([
        Validation.length({ min: 5 }),
        Validation.regex(/hello/),
      ]);
      const result = await validator.validate('hello world', Session.create());
      expect(result.isValid).toBe(true);
    });

    it('should fail if any validator fails', async () => {
      const validator = Validation.all([
        Validation.length({ min: 5 }),
        Validation.regex(/goodbye/),
      ]);
      const result = await validator.validate('hello', Session.create());
      expect(result.isValid).toBe(false);
    });
  });

  describe('any', () => {
    it('should combine validators with OR logic', async () => {
      const validator = Validation.any([
        Validation.regex(/hello/),
        Validation.regex(/world/),
      ]);
      const result = await validator.validate('hello there', Session.create());
      expect(result.isValid).toBe(true);
    });

    it('should pass if any validator passes', async () => {
      const validator = Validation.any([
        Validation.length({ max: 3 }),
        Validation.regex(/long/),
      ]);
      const result = await validator.validate(
        'this is a long string',
        Session.create(),
      );
      expect(result.isValid).toBe(true);
    });
  });
});
