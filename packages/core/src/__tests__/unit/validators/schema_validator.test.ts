import { describe, expect, it } from 'vitest';
import { z } from 'zod';

describe('Schema validation', () => {
  describe('Native schema', () => {
    it('should define a schema with required fields', () => {
      const personSchema = z.object({
        name: z.string().describe("The person's full name"),
        age: z.number().describe("The person's age in years"),
        isStudent: z.boolean().describe('Whether the person is a student'),
      });

      expect(personSchema).toBeDefined();
      expect(personSchema._def.shape()).toHaveProperty('name');
      expect(personSchema._def.shape()).toHaveProperty('age');
      expect(personSchema._def.shape()).toHaveProperty('isStudent');

      const validPerson = {
        name: 'John Doe',
        age: 30,
        isStudent: false,
      };
      const result = personSchema.safeParse(validPerson);
      expect(result.success).toBe(true);
    });

    it('should define a schema with nested properties', () => {
      const companySchema = z.object({
        name: z.string().describe('The company name'),
        founded: z.number().describe('Year the company was founded'),
        headquarters: z.object({
          city: z.string().describe('City of headquarters'),
          country: z.string().describe('Country of headquarters'),
        }),
        isPublic: z
          .boolean()
          .describe('Whether the company is publicly traded'),
      });

      expect(companySchema).toBeDefined();
      expect(companySchema._def.shape()).toHaveProperty('name');
      expect(companySchema._def.shape()).toHaveProperty('founded');
      expect(companySchema._def.shape()).toHaveProperty('headquarters');
      expect(companySchema._def.shape()).toHaveProperty('isPublic');

      const validCompany = {
        name: 'Acme Corp',
        founded: 1999,
        headquarters: {
          city: 'San Francisco',
          country: 'USA',
        },
        isPublic: true,
      };
      const result = companySchema.safeParse(validCompany);
      expect(result.success).toBe(true);
    });
  });

  describe('Zod schema', () => {
    it('should define a Zod schema with validations', () => {
      // Define a Zod schema with validations
      const userSchema = z.object({
        username: z
          .string()
          .min(3)
          .max(20)
          .describe('Username (3-20 characters)'),
        email: z.string().email().describe('Valid email address'),
        age: z
          .number()
          .int()
          .min(18)
          .max(120)
          .describe('Age (must be 18 or older)'),
        roles: z
          .array(z.enum(['admin', 'user', 'moderator']))
          .describe('User roles'),
        settings: z
          .object({
            darkMode: z.boolean().describe('Dark mode preference'),
            notifications: z.boolean().describe('Notification preference'),
          })
          .describe('User settings'),
      });

      // Verify the schema structure
      expect(userSchema).toBeDefined();

      // Create a valid object
      const validUser = {
        username: 'johndoe',
        email: 'john.doe@example.com',
        age: 35,
        roles: ['admin', 'moderator'],
        settings: {
          darkMode: true,
          notifications: true,
        },
      };

      // Validate the object
      const result = userSchema.safeParse(validUser);
      expect(result.success).toBe(true);
    });
  });
});
