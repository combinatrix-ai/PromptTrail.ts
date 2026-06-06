import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from '../../json_schema';

describe('zodToJsonSchema', () => {
  it('converts common Zod object schemas to JSON Schema', () => {
    const schema = z.object({
      name: z.string().describe('Display name'),
      age: z.number().optional(),
      tags: z.array(z.string()),
      active: z.boolean(),
      role: z.enum(['admin', 'user']),
      metadata: z.record(z.string()),
    });

    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name' },
        age: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
        active: { type: 'boolean' },
        role: { type: 'string', enum: ['admin', 'user'] },
        metadata: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['name', 'tags', 'active', 'role', 'metadata'],
      additionalProperties: false,
    });
  });

  it('normalizes optional properties for OpenAI strict schemas', () => {
    const schema = z.object({
      requiredText: z.string(),
      optionalText: z.string().optional(),
      optionalObject: z
        .object({
          nested: z.boolean().optional(),
        })
        .optional(),
    });

    expect(zodToJsonSchema(schema, { openAiStrict: true })).toEqual({
      type: 'object',
      properties: {
        requiredText: { type: 'string' },
        optionalText: { type: ['string', 'null'] },
        optionalObject: {
          type: ['object', 'null'],
          properties: {
            nested: { type: ['boolean', 'null'] },
          },
          required: ['nested'],
          additionalProperties: false,
        },
      },
      required: ['requiredText', 'optionalText', 'optionalObject'],
      additionalProperties: false,
    });
  });

  it('strips unsupported schemas when requested', () => {
    expect(zodToJsonSchema(z.function(), { unsupported: 'strip' })).toEqual({});
  });

  it('errors on unsupported schemas by default', () => {
    expect(() => zodToJsonSchema(z.function())).toThrow(
      'Unsupported Zod schema type',
    );
  });
});
