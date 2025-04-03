# Validators in PromptTrail.ts

Validators ensure that content meets specific criteria, such as matching a pattern, containing keywords, or conforming to a schema.

## Using Validators with AssistantTemplate

AssistantTemplate now supports validators directly:

```typescript
import { AssistantTemplate, RegexMatchValidator } from '@prompttrail/core';

// Create a validator that checks for specific content
const validator = new RegexMatchValidator({
  regex: /\d{3}-\d{3}-\d{4}/,
  description: "Phone number in format XXX-XXX-XXXX required"
});

// Create an assistant template with validation
const template = new AssistantTemplate(
  generateOptions,
  {
    validator,
    maxAttempts: 3,  // Retry up to 3 times
    raiseError: true // Throw an error if validation fails after all attempts
  }
);

// Use in a conversation
const session = await template.execute(createSession());
```

You can also use validators with static content:

```typescript
import { AssistantTemplate, LengthValidator } from '@prompttrail/core';

// Create a validator that checks content length
const validator = new LengthValidator({
  min: 10,
  max: 100,
  description: "Content must be between 10 and 100 characters"
});

// Create an assistant template with static content and validation
const template = new AssistantTemplate(
  "This is a static response",
  {
    validator,
    maxAttempts: 1,
    raiseError: true
  }
);

// The static content will be validated before being added to the session
const session = await template.execute(createSession());
```

## Using Validators with InputSource

InputSource classes also support validation:

```typescript
import { CLIInputSource, KeywordValidator } from '@prompttrail/core';

// Create a validator that requires specific keywords
const validator = new KeywordValidator({
  keywords: ['yes', 'no'],
  mode: 'include',
  description: "Answer must include either 'yes' or 'no'"
});

// Create an input source with validation
const input = new CLIInputSource(
  undefined,
  'Do you agree? (yes/no)',
  undefined,
  {
    validator,
    maxAttempts: 2,
    raiseError: false
  }
);

// The input will be validated and retry if invalid
const response = await input.getInput();
```

For callback-based input sources:

```typescript
import { CallbackInputSource, RegexMatchValidator } from '@prompttrail/core';

// Create a validator for email format
const validator = new RegexMatchValidator({
  regex: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
  description: "Must be a valid email address"
});

// Create a callback input source with validation
const input = new CallbackInputSource(
  async () => {
    // Your custom input logic here
    return userInput;
  },
  {
    validator,
    maxAttempts: 3,
    raiseError: true
  }
);

// The callback will be called up to maxAttempts times until validation passes
const email = await input.getInput();
```

## Available Validators

- **RegexMatchValidator**: Ensures content matches a regex pattern
- **RegexNoMatchValidator**: Ensures content does NOT match a regex pattern
- **KeywordValidator**: Checks for included/excluded keywords
- **LengthValidator**: Validates content length
- **JsonValidator**: Ensures content is valid JSON
- **SchemaValidator**: Validates against a schema
- **CustomValidator**: Create your own validation logic

## Combining Validators

Use `AllValidator` to require all conditions to pass:

```typescript
import { AllValidator, KeywordValidator, LengthValidator } from '@prompttrail/core';

const validator = new AllValidator(
  [
    new KeywordValidator({ keywords: ['important'], mode: 'include' }),
    new LengthValidator({ min: 100, max: 500 })
  ],
  { description: "Must include 'important' and be between 100-500 characters" }
);
```

Or use `AnyValidator` to require at least one condition to pass:

```typescript
import { AnyValidator, RegexMatchValidator } from '@prompttrail/core';

const validator = new AnyValidator(
  [
    new RegexMatchValidator({ regex: /yes/i }),
    new RegexMatchValidator({ regex: /affirmative/i }),
    new RegexMatchValidator({ regex: /correct/i })
  ],
  { description: "Must include 'yes', 'affirmative', or 'correct'" }
);
```

## Schema Validation

For validating structured data, use the SchemaValidator:

```typescript
import { SchemaValidator } from '@prompttrail/core';

// Define a schema
const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    age: { type: 'number' },
    isActive: { type: 'boolean' }
  },
  required: ['name', 'age']
};

// Create a schema validator
const validator = new SchemaValidator({
  schema,
  description: "Response must include name and age fields"
});

// Use with AssistantTemplate
const template = new AssistantTemplate(
  generateOptions,
  {
    validator,
    maxAttempts: 3,
    raiseError: true
  }
);
```

## Error Handling

When validation fails:

- If `raiseError` is `true` (default), an error will be thrown after `maxAttempts` is reached
- If `raiseError` is `false`, execution will continue with the last response even if validation fails

```typescript
try {
  const session = await template.execute(createSession());
  // Validation passed or raiseError was false
} catch (error) {
  // Validation failed after maxAttempts and raiseError was true
  console.error('Validation error:', error.message);
}
```
