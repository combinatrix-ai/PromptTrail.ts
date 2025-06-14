import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { JsonSchemaToZod, jsonSchemaToZod, type JsonSchema } from '../../../mcp/schema-converter.js';

describe('JSON Schema to Zod Converter', () => {
  const converter = new JsonSchemaToZod();

  describe('Basic types', () => {
    it('should convert string schema', () => {
      const schema: JsonSchema = { type: 'string' };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse('hello')).toBe('hello');
      expect(() => zodSchema.parse(123)).toThrow();
    });

    it('should convert number schema', () => {
      const schema: JsonSchema = { type: 'number' };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse(42)).toBe(42);
      expect(zodSchema.parse(3.14)).toBe(3.14);
      expect(() => zodSchema.parse('not a number')).toThrow();
    });

    it('should convert integer schema', () => {
      const schema: JsonSchema = { type: 'integer' };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse(42)).toBe(42);
      expect(() => zodSchema.parse(3.14)).toThrow();
      expect(() => zodSchema.parse('not a number')).toThrow();
    });

    it('should convert boolean schema', () => {
      const schema: JsonSchema = { type: 'boolean' };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse(true)).toBe(true);
      expect(zodSchema.parse(false)).toBe(false);
      expect(() => zodSchema.parse('not a boolean')).toThrow();
    });

    it('should convert null schema', () => {
      const schema: JsonSchema = { type: 'null' };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse(null)).toBe(null);
      expect(() => zodSchema.parse('not null')).toThrow();
    });
  });

  describe('String validations', () => {
    it('should handle string length constraints', () => {
      const schema: JsonSchema = {
        type: 'string',
        minLength: 2,
        maxLength: 10
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse('hello')).toBe('hello');
      expect(() => zodSchema.parse('a')).toThrow(); // too short
      expect(() => zodSchema.parse('this is way too long')).toThrow(); // too long
    });

    it('should handle string pattern constraints', () => {
      const schema: JsonSchema = {
        type: 'string',
        pattern: '^[a-zA-Z]+$'
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse('hello')).toBe('hello');
      expect(() => zodSchema.parse('hello123')).toThrow();
    });

    it('should handle string format constraints', () => {
      const emailSchema: JsonSchema = {
        type: 'string',
        format: 'email'
      };
      const zodSchema = converter.convert(emailSchema);
      
      expect(zodSchema.parse('test@example.com')).toBe('test@example.com');
      expect(() => zodSchema.parse('not-an-email')).toThrow();
    });
  });

  describe('Number validations', () => {
    it('should handle number range constraints', () => {
      const schema: JsonSchema = {
        type: 'number',
        minimum: 0,
        maximum: 100
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse(50)).toBe(50);
      expect(() => zodSchema.parse(-1)).toThrow();
      expect(() => zodSchema.parse(101)).toThrow();
    });

    it('should handle exclusive constraints', () => {
      const schema: JsonSchema = {
        type: 'number',
        exclusiveMinimum: 0,
        exclusiveMaximum: 100
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse(50)).toBe(50);
      expect(zodSchema.parse(0.1)).toBe(0.1); // Just above 0
      expect(zodSchema.parse(99.9)).toBe(99.9); // Just below 100
      expect(() => zodSchema.parse(0)).toThrow();
      expect(() => zodSchema.parse(100)).toThrow();
    });

    it('should handle multipleOf constraint', () => {
      const schema: JsonSchema = {
        type: 'number',
        multipleOf: 5
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse(10)).toBe(10);
      expect(zodSchema.parse(15)).toBe(15);
      expect(() => zodSchema.parse(7)).toThrow();
    });
  });

  describe('Array schemas', () => {
    it('should convert basic array schema', () => {
      const schema: JsonSchema = {
        type: 'array',
        items: { type: 'string' }
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
      expect(() => zodSchema.parse(['a', 123, 'c'])).toThrow();
    });

    it('should handle array length constraints', () => {
      const schema: JsonSchema = {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 5
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse(['a', 'b'])).toEqual(['a', 'b']);
      expect(() => zodSchema.parse(['a'])).toThrow(); // too short
      expect(() => zodSchema.parse(['a', 'b', 'c', 'd', 'e', 'f'])).toThrow(); // too long
    });
  });

  describe('Object schemas', () => {
    it('should convert basic object schema', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' }
        },
        required: ['name']
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse({ name: 'John', age: 30 })).toEqual({ name: 'John', age: 30 });
      expect(zodSchema.parse({ name: 'John' })).toEqual({ name: 'John' }); // age is optional
      expect(() => zodSchema.parse({ age: 30 })).toThrow(); // name is required
    });

    it('should handle nested objects', () => {
      const schema: JsonSchema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string', format: 'email' }
            },
            required: ['name']
          }
        }
      };
      const zodSchema = converter.convert(schema);
      
      const validData = {
        user: {
          name: 'John',
          email: 'john@example.com'
        }
      };
      
      expect(zodSchema.parse(validData)).toEqual(validData);
      expect(() => zodSchema.parse({ user: { email: 'john@example.com' } })).toThrow();
    });
  });

  describe('Enum schemas', () => {
    it('should convert enum schema', () => {
      const schema: JsonSchema = {
        enum: ['red', 'green', 'blue']
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse('red')).toBe('red');
      expect(zodSchema.parse('green')).toBe('green');
      expect(() => zodSchema.parse('yellow')).toThrow();
    });

    it('should handle const schema', () => {
      const schema: JsonSchema = {
        const: 'constant-value'
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse('constant-value')).toBe('constant-value');
      expect(() => zodSchema.parse('different-value')).toThrow();
    });
  });

  describe('Composite schemas', () => {
    it('should handle anyOf schemas', () => {
      const schema: JsonSchema = {
        anyOf: [
          { type: 'string' },
          { type: 'number' }
        ]
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse('hello')).toBe('hello');
      expect(zodSchema.parse(42)).toBe(42);
      expect(() => zodSchema.parse(true)).toThrow();
    });

    it('should handle oneOf schemas', () => {
      const schema: JsonSchema = {
        oneOf: [
          { type: 'string', minLength: 10 },
          { type: 'number', minimum: 100 }
        ]
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse('this is long enough')).toBe('this is long enough');
      expect(zodSchema.parse(150)).toBe(150);
      expect(() => zodSchema.parse('short')).toThrow();
      expect(() => zodSchema.parse(50)).toThrow();
    });

    it('should handle allOf schemas', () => {
      const schema: JsonSchema = {
        allOf: [
          { type: 'string' },
          { minLength: 5 },
          { maxLength: 10 }
        ]
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse('hello')).toBe('hello');
      expect(zodSchema.parse('world!')).toBe('world!'); // 6 chars
      expect(() => zodSchema.parse('hi')).toThrow(); // too short
      expect(() => zodSchema.parse('this is way too long')).toThrow(); // too long
    });
  });

  describe('Default values and descriptions', () => {
    it('should handle default values', () => {
      const schema: JsonSchema = {
        type: 'string',
        default: 'default-value'
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.parse(undefined)).toBe('default-value');
      expect(zodSchema.parse('custom-value')).toBe('custom-value');
    });

    it('should preserve descriptions when enabled', () => {
      const schema: JsonSchema = {
        type: 'string',
        description: 'A test string'
      };
      const zodSchema = converter.convert(schema);
      
      expect(zodSchema.description).toBe('A test string');
    });
  });

  describe('MCP tool schema conversion', () => {
    it('should convert typical MCP tool schema', () => {
      const mcpSchema: JsonSchema = {
        type: 'object',
        properties: {
          operation: {
            type: 'string',
            enum: ['add', 'subtract', 'multiply', 'divide'],
            description: 'The operation to perform'
          },
          a: {
            type: 'number',
            description: 'First operand'
          },
          b: {
            type: 'number',
            description: 'Second operand'
          }
        },
        required: ['operation', 'a', 'b']
      };

      const zodSchema = converter.convert(mcpSchema);
      
      const validInput = {
        operation: 'add',
        a: 5,
        b: 3
      };
      
      expect(zodSchema.parse(validInput)).toEqual(validInput);
      expect(() => zodSchema.parse({ operation: 'invalid', a: 5, b: 3 })).toThrow();
      expect(() => zodSchema.parse({ operation: 'add', a: 5 })).toThrow(); // missing b
    });

    it('should handle complex nested MCP schemas', () => {
      const complexSchema: JsonSchema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              preferences: {
                type: 'object',
                properties: {
                  theme: { type: 'string', enum: ['light', 'dark'] },
                  notifications: { type: 'boolean' }
                }
              }
            },
            required: ['id']
          },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                data: { type: 'object' }
              },
              required: ['type']
            }
          }
        },
        required: ['user']
      };

      const zodSchema = converter.convert(complexSchema);
      
      const validData = {
        user: {
          id: 'user123',
          preferences: {
            theme: 'dark' as const,
            notifications: true
          }
        },
        actions: [
          { type: 'click', data: { x: 100, y: 200 } },
          { type: 'scroll' }
        ]
      };
      
      const result = zodSchema.parse(validData);
      
      // Check the structure is correct (data property might be empty object due to passthrough)
      expect(result.user.id).toBe('user123');
      expect(result.user.preferences?.theme).toBe('dark');
      expect(result.user.preferences?.notifications).toBe(true);
      expect(result.actions).toHaveLength(2);
      expect(result.actions[0].type).toBe('click');
      expect(result.actions[1].type).toBe('scroll');
    });
  });

  describe('Error handling', () => {
    it('should handle empty enum gracefully', () => {
      const schema: JsonSchema = {
        enum: []
      };
      
      expect(() => converter.convert(schema)).toThrow('Empty enum is not supported');
    });

    it('should handle unknown types in strict mode', () => {
      const strictConverter = new JsonSchemaToZod({ strictMode: true });
      const schema: JsonSchema = {
        type: 'unknown-type' as any
      };
      
      expect(() => strictConverter.convert(schema)).toThrow('Unsupported type: unknown-type');
    });

    it('should fallback to unknown for unsupported types in non-strict mode', () => {
      const lenientConverter = new JsonSchemaToZod({ strictMode: false });
      const schema: JsonSchema = {
        type: 'unknown-type' as any
      };
      
      const zodSchema = lenientConverter.convert(schema);
      expect(zodSchema.parse('anything')).toBe('anything');
    });
  });

  describe('Convenience functions', () => {
    it('should work with jsonSchemaToZod function', () => {
      const schema: JsonSchema = {
        type: 'string',
        minLength: 3
      };
      
      const zodSchema = jsonSchemaToZod(schema);
      expect(zodSchema.parse('hello')).toBe('hello');
      expect(() => zodSchema.parse('hi')).toThrow();
    });
  });
});