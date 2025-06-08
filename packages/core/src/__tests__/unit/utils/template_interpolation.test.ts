import { describe, expect, it } from 'vitest';
import {
  interpolateTemplate,
  registerHelper,
} from '../../../utils/template_interpolation';
import { Session } from '../../../session';

describe('Template Interpolation with Handlebars', () => {
  describe('Basic Variable Interpolation', () => {
    it('should interpolate simple variables', () => {
      const session = Session.create({ context: { name: 'Alice' } });
      const result = interpolateTemplate('Hello {{name}}!', session);
      expect(result).toBe('Hello Alice!');
    });

    it('should interpolate nested object properties', () => {
      const session = Session.create({
        context: { user: { name: 'Bob', age: 30 } },
      });
      const result = interpolateTemplate(
        'User: {{user.name}} ({{user.age}})',
        session,
      );
      expect(result).toBe('User: Bob (30)');
    });

    it('should handle missing variables gracefully', () => {
      const session = Session.create({ context: {} });
      const result = interpolateTemplate('Hello {{missing}}!', session);
      expect(result).toBe('Hello !');
    });
  });

  describe('Array Iteration', () => {
    it('should iterate over arrays with each helper', () => {
      const session = Session.create({
        context: {
          items: [
            { title: 'Item 1', description: 'First item' },
            { title: 'Item 2', description: 'Second item' },
          ],
        },
      });
      const template = `{{#each items}}
- {{title}}: {{description}}
{{/each}}`;
      const result = interpolateTemplate(template, session);
      expect(result.trim()).toBe('- Item 1: First item\n- Item 2: Second item');
    });

    it('should provide index access in loops', () => {
      const session = Session.create({
        context: { names: ['Alice', 'Bob', 'Charlie'] },
      });
      const template = `{{#each names}}
{{@index}}. {{.}}
{{/each}}`;
      const result = interpolateTemplate(template, session);
      expect(result.trim()).toBe('0. Alice\n1. Bob\n2. Charlie');
    });
  });

  describe('Conditionals', () => {
    it('should support if/else conditions', () => {
      const session = Session.create({
        context: { isLoggedIn: true, username: 'Alice' },
      });
      const template = `{{#if isLoggedIn}}Welcome back, {{username}}!{{else}}Please log in.{{/if}}`;
      const result = interpolateTemplate(template, session);
      expect(result).toBe('Welcome back, Alice!');
    });

    it('should support unless conditions', () => {
      const session = Session.create({
        context: { isEmpty: false, content: 'Hello World' },
      });
      const template = `{{#unless isEmpty}}{{content}}{{/unless}}`;
      const result = interpolateTemplate(template, session);
      expect(result).toBe('Hello World');
    });
  });

  describe('Built-in Helpers', () => {
    it('should use length helper for arrays', () => {
      const session = Session.create({
        context: { items: ['a', 'b', 'c'] },
      });
      const result = interpolateTemplate('Count: {{length items}}', session);
      expect(result).toBe('Count: 3');
    });

    it('should use length helper for strings', () => {
      const session = Session.create({
        context: { text: 'hello' },
      });
      const result = interpolateTemplate('Length: {{length text}}', session);
      expect(result).toBe('Length: 5');
    });

    it('should use join helper for arrays', () => {
      const session = Session.create({
        context: { tags: ['javascript', 'typescript', 'node'] },
      });
      const result = interpolateTemplate('Tags: {{join tags ", "}}', session);
      expect(result).toBe('Tags: javascript, typescript, node');
    });

    it('should use truncate helper', () => {
      const session = Session.create({
        context: {
          longText: 'This is a very long text that should be truncated',
        },
      });
      const result = interpolateTemplate('{{truncate longText 20}}', session);
      expect(result).toBe('This is a very long ...');
    });

    it('should use numberedList helper', () => {
      const session = Session.create({
        context: { items: ['First', 'Second', 'Third'] },
      });
      const result = interpolateTemplate('{{numberedList items}}', session);
      expect(result).toBe('1. First\n2. Second\n3. Third');
    });

    it('should use bulletList helper', () => {
      const session = Session.create({
        context: { items: ['Apple', 'Banana', 'Cherry'] },
      });
      const result = interpolateTemplate('{{bulletList items}}', session);
      expect(result).toBe('- Apple\n- Banana\n- Cherry');
    });

    it('should use isEmpty helper', () => {
      const session = Session.create({
        context: {
          emptyArray: [],
          nonEmptyArray: [1, 2, 3],
          emptyString: '',
          nonEmptyString: 'hello',
        },
      });
      const template = `{{#if (isEmpty emptyArray)}}Empty array{{/if}}
{{#if (isEmpty nonEmptyArray)}}Non-empty array{{else}}Array has items{{/if}}
{{#if (isEmpty emptyString)}}Empty string{{/if}}
{{#if (isEmpty nonEmptyString)}}Empty string{{else}}String has content{{/if}}`;
      const result = interpolateTemplate(template, session);
      expect(result.trim()).toBe(
        'Empty array\nArray has items\nEmpty string\nString has content',
      );
    });

    it('should use comparison helpers', () => {
      const session = Session.create({
        context: { score: 85, passingScore: 80, name: 'Alice' },
      });
      const template = `{{#if (gt score passingScore)}}{{name}} passed!{{else}}{{name}} failed.{{/if}}`;
      const result = interpolateTemplate(template, session);
      expect(result).toBe('Alice passed!');
    });
  });

  describe('Complex Templates', () => {
    it('should handle complex nested structures', () => {
      const session = Session.create({
        context: {
          user: { name: 'Alice', role: 'admin' },
          projects: [
            {
              name: 'Project A',
              status: 'active',
              tasks: ['Task 1', 'Task 2'],
            },
            { name: 'Project B', status: 'completed', tasks: ['Task 3'] },
          ],
        },
      });
      const template = `Welcome {{user.name}} ({{user.role}})!

Your projects:
{{#each projects}}
{{@index}}. {{name}} - {{status}} ({{length tasks}} tasks)
{{#each tasks}}
   - {{.}}
{{/each}}
{{/each}}`;
      const result = interpolateTemplate(template, session);
      expect(result).toContain('Welcome Alice (admin)!');
      expect(result).toContain('0. Project A - active (2 tasks)');
      expect(result).toContain('1. Project B - completed (1 tasks)');
      expect(result).toContain('- Task 1');
      expect(result).toContain('- Task 3');
    });
  });

  describe('Custom Helpers', () => {
    it('should allow registering custom helpers', () => {
      // Register a custom helper
      registerHelper('uppercase', (text: string) => text.toUpperCase());

      const session = Session.create({
        context: { message: 'hello world' },
      });
      const result = interpolateTemplate('{{uppercase message}}', session);
      expect(result).toBe('HELLO WORLD');
    });
  });

  describe('Error Handling', () => {
    it('should handle template errors gracefully', () => {
      const session = Session.create({ context: {} });
      const result = interpolateTemplate('{{#each}}{{/each}}', session); // Invalid syntax
      expect(result).toContain('[TEMPLATE ERROR:');
      expect(result).toContain('{{#each}}{{/each}}');
    });
  });

  describe('Backward Compatibility Context', () => {
    it('should work with plain objects', () => {
      const context = { name: 'Bob', age: 25 };
      const result = interpolateTemplate(
        '{{name}} is {{age}} years old',
        context,
      );
      expect(result).toBe('Bob is 25 years old');
    });
  });
});
