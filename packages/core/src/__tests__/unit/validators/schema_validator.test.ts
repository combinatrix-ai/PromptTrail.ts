import { describe, it, expect } from 'vitest';
import {
  defineSchema,
  createStringProperty,
  createNumberProperty,
  createBooleanProperty,
} from '../../../utils/schema';
import { z } from 'zod';

describe('Schema validation', () => {
  describe('Native schema', () => {
    it('should define a schema with required fields', () => {
      // Define a simple schema
      const personSchema = defineSchema({
        properties: {
          name: createStringProperty("The person's full name"),
          age: createNumberProperty("The person's age in years"),
          isStudent: createBooleanProperty('Whether the person is a student'),
        },
        required: ['name', 'age'],
      });

      // Verify the schema structure
      expect(personSchema).toHaveProperty('properties');
      expect(personSchema.properties).toHaveProperty('name');
      expect(personSchema.properties).toHaveProperty('age');
      expect(personSchema.properties).toHaveProperty('isStudent');
      expect(personSchema.required).toContain('name');
      expect(personSchema.required).toContain('age');
    });

    it('should define a flattened nested schema', () => {
      // Define a schema for company (using a flattened approach)
      const companySchema = defineSchema({
        properties: {
          name: createStringProperty('The company name'),
          founded: createNumberProperty('Year the company was founded'),
          headquartersCity: createStringProperty('City of headquarters'),
          headquartersCountry: createStringProperty('Country of headquarters'),
          isPublic: createBooleanProperty(
            'Whether the company is publicly traded',
          ),
        },
        required: ['name', 'headquartersCity', 'headquartersCountry'],
      });

      // Verify the schema structure
      expect(companySchema).toHaveProperty('properties');
      expect(companySchema.properties).toHaveProperty('name');
      expect(companySchema.properties).toHaveProperty('founded');
      expect(companySchema.properties).toHaveProperty('headquartersCity');
      expect(companySchema.properties).toHaveProperty('headquartersCountry');
      expect(companySchema.properties).toHaveProperty('isPublic');
      expect(companySchema.required).toContain('name');
      expect(companySchema.required).toContain('headquartersCity');
      expect(companySchema.required).toContain('headquartersCountry');
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
