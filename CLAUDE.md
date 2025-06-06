# CLAUDE.md - PromptTrail.ts Project Guidelines

## Project Overview

PromptTrail.ts is a TypeScript-first framework for building structured LLM conversations with type safety and composability. Built on top of Vercel's ai-sdk, it provides a fluent API for creating complex conversation flows with immutable state management.

PromptTrail.ts is in beta. No backward compatibility is guaranteed - breaking changes may occur as we improve the framework.
Always suggest best practices.

PromptTrail comes with a set of sensible defaults. And also allows users to override them for advanced use cases.

**Key Features:**

- Type-safe, composable conversation templates
- Immutable session state management
- Multi-provider LLM support (OpenAI, Anthropic, Google)
- Tool integration via ai-sdk
- Streaming support
- Validation and structured output capabilities

## Repository Structure

```
/Volumes/Shared/PromptTrail.ts/
├── packages/
│   ├── core/               # Main library package
│   │   ├── src/
│   │   │   ├── templates/  # Template components (Agent, Assistant, User, etc.)
│   │   │   ├── validators/ # Input/output validation
│   │   │   └── ...
│   │   └── package.json
│   └── react/             # React integration (coming soon)
├── examples/              # Usage examples
├── design-docs/          # Architecture decisions and TODOs
├── scripts/              # Build and test scripts
└── package.json          # Root workspace config
```

## Important Commands

### Testing

```bash
# Run all tests
pnpm test

# Run tests in the core package
cd packages/core && pnpm test

# Run tests with coverage
cd packages/core && pnpm test:coverage

# Special test command for Cline compatibility
pnpm test:cline
```

### Code Quality

```bash
# Check linting
pnpm lint:check

# Fix linting issues
pnpm lint

# Check formatting
pnpm format:check

# Fix formatting
pnpm format

# Type checking
pnpm -C packages/core typecheck

# Run all checks
pnpm check
```

### Building

```bash
# Build all packages
pnpm -r build

# Build core package
cd packages/core && pnpm build
```

### Running Examples

```bash
# Run examples using bun
bun run examples/[example_name].ts

# Example: Run the autonomous researcher
bun run examples/autonomous_researcher.ts
```

### Installing Dependencies

```bash
# Install dependencies in workspace root (for pnpm workspaces)
pnpm install -w

# Install dev dependencies in workspace root
pnpm install -w -D <package-name>
```

## Code Style and Conventions

### TypeScript

- **Target:** ES2022
- **Module:** ESNext
- **Strict mode:** Enabled
- Use type-safe patterns with proper generics
- Prefer interfaces over type aliases for object shapes
- Export all public APIs from index.ts files

### Formatting (Prettier)

- Single quotes for strings
- Semicolons required
- Trailing commas everywhere
- 80 character line width

### Code Patterns

1. **Immutable State**: All session operations return new instances

   ```typescript
   const newSession = session.addMessage(message); // Returns new Session
   ```

2. **Fluent API**: Classes provide chainable methods

   ```typescript
   const agent = Agent.create().system('...').user('...').assistant('...');
   ```

3. **Factory Methods**: Use `.create()` pattern for object creation

   ```typescript
   const session = Session.create();
   const vars = Vars.create({ key: 'value' });
   ```

4. **Source Pattern**: Content sources define where data comes from
   ```typescript
   Source.llm(); // LLM generation
   Source.cli(); // CLI input
   Source.literal(); // Fixed content
   Source.callback(); // Custom logic
   Source.random(); // Random from list
   Source.list(); // Sequential from list
   ```

## Architecture Principles

### 1. Immutability

- Session, Vars, and Attrs are immutable
- All modifications return new instances
- No side effects in template execution

### 2. Type Safety

- Full TypeScript support with generics
- Type inference for session vars and attrs
- Compile-time validation where possible

### 3. Composability

- Templates can be nested and combined
- Agent builder for sequential composition
- Subroutines for isolated execution

### 4. Extensibility

- Custom validators
- Custom sources
- Provider-agnostic design

## Key Classes and Their Roles

### Core Components

- **Session**: Immutable conversation state (messages + vars)
- **Agent**: Fluent builder for template composition
- **Template**: Base interface for all conversation components
- **Source**: Defines content generation strategy

### Template Types

- **System/User/Assistant**: Message templates
- **Loop**: Repeating template execution
- **Conditional**: Branching logic
- **Subroutine**: Isolated sub-conversations
- **Transform**: Session state modification

### Content Configuration

**User Templates:**

- **String**: `"Fixed content"` - Static text with interpolation
- **Array**: `["A", "B", "C"]` - Sequential content with optional looping
- **CLI Options**: `{ cli: "Enter name:" }` - User input from terminal
- **Callback**: `async (session) => "..."` - Custom async logic

**Assistant Templates:**

- **LLM Config**: `{ provider: 'openai', model: 'gpt-4' }` - Direct LLM configuration
- **String**: `"Static response"` - Fixed assistant content
- **Callback**: `async (session) => ({ content: "...", toolCalls: [...] })` - Custom logic

Under the hood, these templates are built using the `Source` API for maximum flexibility.

## Common Tasks

### Adding a New Feature

1. Design the API following existing patterns
2. Implement with proper TypeScript types
3. Add comprehensive tests
4. Update exports in index.ts
5. Document in code with JSDoc

### Fixing Bugs

1. Write a failing test first
2. Fix the issue
3. Ensure all tests pass
4. Run lint and format checks

### Testing Patterns

- Unit tests for individual components
- Integration tests for template execution
- Use mock sources for deterministic tests
- Test type inference with type assertions

## Development Workflow

1. **Before starting work**: Read relevant existing code
2. **Follow conventions**: Match existing code style
3. **Test thoroughly**: Add tests for new functionality
4. **Type safety**: Ensure proper TypeScript types
5. **Documentation**: Add JSDoc comments for public APIs

## Dependencies

### Core Dependencies

- `ai`: Vercel's AI SDK for LLM interactions
- `zod`: Schema validation
- `@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`: Provider implementations

### Development

- `vitest`: Testing framework
- `tsup`: Build tool
- `eslint` & `prettier`: Code quality
- `typescript`: Type checking

## Integration Points

### With ai-sdk

- Tool integration via `tool()` function
- Provider configurations
- Streaming support

## Performance Considerations

- Sessions are immutable - consider memory usage for long conversations
- Use streaming for real-time responses
- Batch tool calls when possible
- Consider subroutines for memory isolation

## Security Notes

- Never expose API keys in browser environments without proper backend
- Use `dangerouslyAllowBrowser` flag consciously
- Validate all user inputs
- Sanitize LLM outputs when displaying in UI

## Debugging Tips

1. Enable `print: true` in session creation for console output
2. Use `session.toJSON()` to inspect state
3. Check message types and content with getters
4. Validate template composition with type checking

## Template Interpolation

PromptTrail.ts uses **Handlebars** for powerful template interpolation with dynamic content insertion:

### Basic Variable Interpolation

```typescript
// Simple variables
'Hello {{name}}';
'User: {{user.name}}'; // Nested object access
'Count: {{length items}}'; // Built-in helpers

// Transform example: Recipe recommendation system
const session = Session.create({
  vars: {
    dietaryRestrictions: ['vegetarian', 'gluten-free'],
    availableTime: 30,
    ingredients: ['tomatoes', 'pasta', 'cheese', 'herbs'],
  },
});

const agent = Agent.create()
  .system('You are a cooking assistant. Suggest recipes based on constraints.')
  .user(
    'I have {{availableTime}} minutes and these ingredients: {{join ingredients ", "}}. I follow these diets: {{join dietaryRestrictions " and "}}.',
  )
  .assistant()
  .transform((session) => {
    // Extract recipe info from LLM response
    const response = session.getLastMessage()?.content || '';
    const recipeMatch = response.match(/Recipe:\s*([^\n]+)/i);
    const cookingTimeMatch = response.match(/(\d+)\s*minutes?/);

    return session.withVars({
      suggestedRecipe: recipeMatch?.[1] || 'Unknown Recipe',
      estimatedTime: cookingTimeMatch?.[1] ? parseInt(cookingTimeMatch[1]) : 30,
      recipeCount: session.getVar('recipeCount', 0) + 1,
    });
  })
  .user(
    'Great! For {{suggestedRecipe}}, what cooking tips do you have? (This is recipe #{{recipeCount}})',
  )
  .assistant();

const result = await agent.execute(session);
console.log('Suggested recipe:', result.getVar('suggestedRecipe'));
console.log('Estimated time:', result.getVar('estimatedTime'), 'minutes');
```

### Array Iteration

```typescript
// Loop through arrays in templates
const session = Session.create({
  vars: {
    tasks: [
      { title: 'Learn TypeScript', status: 'complete' },
      { title: 'Build app', status: 'pending' }
    ]
  }
});

const agent = Agent.create()
  .system(`Current tasks:
{{#each tasks}}
- {{title}}: {{status}}
{{/each}}`)
  .user('Help me with the next task')
  .assistant();

// Loop with index
"{{#each users}}
{{@index}}. {{name}} ({{email}})
{{/each}}"
```

### Conditionals

```typescript
// If/else logic in templates
const agent = Agent.create()
  .system(`{{#if user.isPremium}}
You have premium access to advanced features.
{{else}}
You have basic access. Upgrade for more features.
{{/if}}`)
  .user('What can I do?')
  .assistant();

// Unless (inverse if)
"{{#unless isEmpty}}
Content: {{content}}
{{/unless}}"
```

### Built-in PromptTrail Helpers

```typescript
// PromptTrail includes useful helpers:
'Items: {{length items}}'; // Get array length
'List: {{join tags ", "}}'; // Join array with separator
'Text: {{truncate description 100}}'; // Truncate to length
'Number: {{formatNumber price}}'; // Format numbers
'{{#unless isEmpty results}}Found {{length results}} items{{/unless}}';

// List formatting helpers
'{{numberedList items}}'; // 1. Item A\n2. Item B
'{{bulletList items}}'; // • Item A\n• Item B

// Comparison helpers
'{{#if (eq status "complete")}}Done!{{/if}}';
'{{#if (gt score 80)}}Great job!{{/if}}';
'{{debug value "label"}}'; // Debug helper for development
```

### Custom Helpers

```typescript
// Register your own helpers
import { registerHelper } from '@prompttrail/core';

registerHelper('uppercase', (text: string) => text.toUpperCase());
registerHelper('currency', (amount: number) => `$${amount.toFixed(2)}`);

// Use in templates
('Welcome {{uppercase name}}!');
('Total: {{currency total}}');
```

**Key Features:**

- **Dynamic content insertion** - Variables, objects, arrays
- **Control flow** - Conditionals and loops
- **Built-in helpers** - Length, join, format, comparison functions
- **Custom helpers** - Extend with your own template functions
- **Nested access** - Deep object property access with dot notation

## Structured Output & Variable Extraction

PromptTrail.ts provides powerful structured output capabilities with automatic variable extraction:

### Basic Structured Output

```typescript
import { z } from 'zod';

const userSchema = z.object({
  name: z.string(),
  age: z.number(),
  interests: z.array(z.string()),
});

const agent = Agent.create()
  .system('Extract user info from text.')
  .user("Hi, I'm Alice, 25, love coding and music.")
  .assistant({
    provider: 'openai',
    schema: userSchema,
  });

const session = await agent.execute();
const userData = session.getLastMessage()?.structuredContent;
// userData is typed as { name: string, age: number, interests: string[] }
```

### Auto-Extract to Session Variables

```typescript
// Extract all schema fields to vars (Agent convenience method)
const agentWithExtraction = Agent.create()
  .system('Extract user info from text.')
  .user("Hi, I'm Alice, 25, love coding and music.")
  .extract({
    provider: 'openai',
    schema: userSchema,
  }) // Agent.extract() - creates Assistant with schema + auto-extraction
  .user(
    'Hi {{name}}, you are {{age}} years old and like {{join interests ", "}}',
  )
  .assistant();

// Custom field mapping (Agent convenience method)
const agentWithMapping = Agent.create()
  .system('Extract recipe details.')
  .user('I want to make pasta with tomatoes in 30 minutes')
  .extract(
    {
      provider: 'openai',
      schema: z.object({
        recipeName: z.string(),
        cookingTime: z.number(),
        difficulty: z.enum(['easy', 'medium', 'hard']),
      }),
    },
    {
      recipeName: 'suggestedRecipe',
      cookingTime: 'estimatedTime',
      difficulty: 'recipeComplexity',
    },
  )
  .user(
    'Great! {{suggestedRecipe}} takes {{estimatedTime}} minutes and is {{recipeComplexity}}',
  )
  .assistant();

// Partial extraction (Agent convenience method)
const agentPartial = Agent.create()
  .system('Analyze the request.')
  .user('Complex request with many details...')
  .extract(
    {
      provider: 'openai',
      schema: complexSchema,
    },
    ['title', 'priority'],
  ); // Only extract specific fields
```

### Extract Methods

**Agent.extract() (Recommended)**

```typescript
// Auto-extract all fields
Agent.create().extract({ provider: 'openai', schema });

// Extract specific fields
Agent.create().extract({ provider: 'openai', schema }, ['field1', 'field2']);

// Custom field mapping
Agent.create().extract({ provider: 'openai', schema }, { field: 'varName' });
```

**Assistant with Options (Alternative)**

```typescript
// Via constructor options
.assistant({
  provider: 'openai',
  schema: userSchema,
}, {
  extractToVars: true | ['fields'] | { mapping }
})
```

## Template Instantiation Patterns & Type Safety

PromptTrail.ts provides multiple ways to create and compose templates. Understanding the preferred patterns will help you write type-safe, maintainable code.

### 🎯 Preferred: Function-Based Agent Methods

The **Agent function-based API** is the recommended approach for creating templates because it provides superior type safety and developer experience.

#### Why Function-Based Methods Are Better

**Type Inheritance & Safety:**

```typescript
// ✅ GOOD: Function-based methods inherit Agent's type parameters
type MyVars = { userId: string; role: 'admin' | 'user' };
type MyAttrs = { timestamp: Date; requestId: string };

const agent = Agent.create<MyVars, MyAttrs>()
  .system('You are a helpful assistant')
  .user('Hello')
  .assistant()
  .conditional(
    (session) => session.getVar('role') === 'admin', // ✅ Type-safe access to MyVars
    (a) => a.system('Admin mode enabled').assistant(),
    (a) => a.system('Standard mode').assistant(),
  );

// ❌ BAD: Direct instantiation causes type mismatches
const agent = Agent.create<MyVars, MyAttrs>()
  .then(new User('Hello')) // ❌ Type error: User<any, any> ≠ Agent<MyVars, MyAttrs>
  .then(
    new Conditional({
      // ❌ Type error: Template types don't match
      condition: (session) => session.getVar('role') === 'admin',
      thenTemplate: new System('Admin mode'),
      elseTemplate: new System('Standard mode'),
    }),
  );
```

**The Problem with Direct Instantiation:**

- `new User("text")` creates `User<any, any>`
- `Agent<MyVars, MyAttrs>` expects templates with matching type parameters
- This causes TypeScript errors requiring ugly type casting

**The Solution with Function-Based Methods:**

- `agent.user("text")` automatically creates `User<MyVars, MyAttrs>`
- Types flow naturally through the entire composition
- No type casting or `any` types needed

### Template Creation Patterns

#### Message Templates

```typescript
// ✅ Preferred: Agent methods (type-safe, support various content sources)
const agent = Agent.create<UserContext, MessageAttrs>()
  .system('You are {{userRole}} assistant') // String content
  .system(Source.literal('Custom system message')) // Source content
  .system(
    async (session) => `Dynamic message for ${session.getVar('userName')}`,
  ) // Function content
  .user('{{userQuery}}')
  .assistant();

// ❌ Avoid: Direct instantiation (type issues)
const agent = Agent.create<UserContext, MessageAttrs>()
  .then(new System('You are {{userRole}} assistant')) // Type mismatch
  .then(new User('{{userQuery}}')) // Type mismatch
  .then(new Assistant()); // Type mismatch
```

#### Conditional Logic

```typescript
// ✅ Preferred: Function-based conditional
const agent = Agent.create()
  .system('You are a helpful assistant')
  .user('Process this request')
  .conditional(
    (session) => session.getVar('isUrgent', false),
    // Then branch - urgent handling
    (a) =>
      a.system('URGENT: Process immediately with high priority').assistant(),
    // Else branch - normal handling
    (a) => a.system('Process normally').assistant(),
  );

// ❌ Avoid: Direct Conditional instantiation
const urgentFlow = new Conditional({
  condition: (session) => session.getVar('isUrgent', false),
  thenTemplate: new System('URGENT: Process immediately'), // Type issues
  elseTemplate: new System('Process normally'), // Type issues
});
```

#### Loops and Iteration

```typescript
// ✅ Preferred: Function-based loop
const agent = Agent.create()
  .system('You are a helpful chatbot')
  .loop(
    (a) => a.user({ cli: 'Your message (or "quit" to exit): ' }).assistant(),
    (session) => {
      const lastMessage = session.getLastMessage();
      return lastMessage?.content.toLowerCase() !== 'quit';
    },
    10, // Max iterations
  );

// ❌ Avoid: Direct Loop instantiation
const chatLoop = new Loop({
  bodyTemplate: [
    new User({ cli: 'Your message: ' }), // Type issues
    new Assistant(), // Type issues
  ],
  loopIf: (session) => session.getVar('continue', true),
  maxIterations: 10,
});
```

#### Parallel Execution

```typescript
// ✅ Preferred: Function-based parallel with Agent
const agent = Agent.create()
  .system('You are a helpful assistant')
  .user('Compare approaches to this problem')
  .parallel((p) =>
    p
      .withSource(Source.llm().openai('gpt-4.1-mini'))
      .withSource(Source.llm().anthropic('claude-3.5-haiku'))
      .withStrategy('best'),
  );

// ❌ Avoid: Direct Parallel instantiation (type issues)
const parallel = new Parallel({
  sources: [
    { source: Source.llm().openai() },
    { source: Source.llm().anthropic() },
  ],
  strategy: 'best',
});
```

#### Subroutines

```typescript
// ✅ Preferred: Function-based subroutine
const agent = Agent.create()
  .system('You are a research assistant')
  .user('Research: {{topic}}')
  .assistant()
  .subroutine(
    (a) =>
      a
        .system('You are a fact-checker. Verify the research above.')
        .user('Please fact-check the research and rate its accuracy 1-10')
        .assistant(),
    { isolateContext: true },
  )
  .transform((session) => {
    // Extract fact-check score and add to vars
    const factCheckMessage = session.getLastMessage();
    const scoreMatch = factCheckMessage?.content.match(/(\d+)\/10/);
    return session.withVar('factCheckScore', scoreMatch?.[1] || '0');
  })
  .user(
    'Based on the fact-check score of {{factCheckScore}}/10, provide a final summary',
  );

// ❌ Avoid: Direct Subroutine instantiation (complex type management)
```

### Best Practices Summary

1. **Always start with `Agent.create()`** - provides the fluent interface
2. **Use function-based methods** (`agent.user()`, `agent.conditional()`, etc.) instead of direct instantiation
3. **Specify types early** - `Agent.create<MyVars, MyAttrs>()` for type safety
4. **Leverage nested builders** - function parameters in conditionals, loops, etc. provide clean, type-safe composition
5. **Direct instantiation is okay for simple cases** but avoid mixing with typed Agents

### When Direct Instantiation Is Acceptable

Direct instantiation is fine when:

- Creating standalone templates for testing
- Building utility functions that don't need strict typing
- Working with generic template compositions

```typescript
// OK for utility functions
function createWelcomeMessage(role: string): System {
  return new System(`Welcome, you are logged in as: ${role}`);
}

// OK for testing
it('should handle conditional logic', () => {
  const conditional = new Conditional({
    condition: () => true,
    thenTemplate: new User('then branch'),
    elseTemplate: new User('else branch'),
  });
  // Test the conditional...
});
```

### Migration from Direct Instantiation

If you have existing code using direct instantiation, consider refactoring:

```typescript
// Before (direct instantiation)
const agent = Agent.create()
  .then(new System('Hello'))
  .then(new User('Question'))
  .then(new Assistant());

// After (function-based)
const agent = Agent.create().system('Hello').user('Question').assistant();
```

## Model Comparison

- Your knowledge of LLM models maybe outdated, as the world of AI is rapidly evolving.
- Usually, use "gpt-4.1-mini" for most tasks due to its balance of speed and intelligence.
- For testing, use "gpt-4.1-nano", "claude-3.5-haiku", or "gemini-2.5-flash-preview" for lower costs.

| **Provider**           | **Model (API Name)**                                          | **Context Window**           | **Pricing (per 1k tokens)**         | **Status**  | **Notes / Variants**                                                                  |
| ---------------------- | ------------------------------------------------------------- | ---------------------------- | ----------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| **Google (Gemini)**    | **Gemini 2.5 Flash** _(Preview)_ (`gemini-2.5-flash-preview`) | 1 000 000 tokens _(exp.)_    | Input: \$0.00050; Output: \$0.01000 | **Preview** | Price-performance-optimised **Flash** model (experimental preview).                   |
|                        | **Gemini 2.5 Pro** _(Preview)_ (`gemini-2.5-pro-preview`)     | ≈ 1 000 000+ tokens _(exp.)_ | Input: \$0.00100; Output: \$0.02000 | **Preview** | Most-advanced **Pro** model in preview (experimental long-context).                   |
| **Anthropic (Claude)** | **Claude 3.5 Haiku** (`claude-3-5-haiku-20241022`)            | 200 000 tokens               | Input: \$0.00080; Output: \$0.00400 | Production  | Improved fast model (Claude 3.5 Haiku – higher speed & context vs 3 Haiku).           |
|                        | **Claude 4 Sonnet** (`claude-sonnet-4-20250514`)              | 200 000 tokens               | Input: \$0.00300; Output: \$0.01500 | Production  | Latest high-performance model (Claude 4 Sonnet: “smart, efficient for everyday use”). |
|                        | **Claude 4 Opus** (`claude-opus-4-20250514`)                  | 200 000 tokens               | Input: \$0.01500; Output: \$0.07500 | Production  | Latest most-powerful model (Claude 4 Opus: state-of-the-art capabilities).            |
| **OpenAI (GPT)**       | **GPT-4.1** (`gpt-4.1`)                                       | 1 047 576 tokens             | Input: \$0.0020; Output: \$0.0080   | Production  | Latest flagship GPT model (very high intelligence, 1 M-token long context).           |
|                        | **GPT-4.1 Mini** (`gpt-4.1-mini`)                             | 1 047 576 tokens             | Input: \$0.0004; Output: \$0.0016   | Production  | “Mini” variant – balanced speed vs. intelligence (much lower cost, ≈ 1 M context).    |
|                        | **GPT-4.1 Nano** (`gpt-4.1-nano`)                             | 1 048 576 tokens             | Input: \$0.0001; Output: \$0.0004   | Production  | “Nano” variant – fastest, low-latency model (smallest GPT-4.1, 1 M context).          |
| **OpenAI (o-series)**  | **o4-mini** (`o4-mini-2025-04-16`)                            | 200 000 tokens               | Input: \$0.00110; Output: \$0.00440 | Production  | Latest small o-series reasoning model (fast, affordable, text + vision).              |
|                        | **o3** (`o3-2025-04-16`)                                      | 200 000 tokens               | Input: \$0.00500; Output: \$0.02000 | Production  | Most-powerful o-series reasoning model (state-of-the-art deliberate reasoning).       |

## AI SDK Documentation

For comprehensive AI SDK documentation, see https://ai-sdk.dev/llms.txt

The AI SDK is available as a dependency in `node_modules/ai/` with full TypeScript types and examples.

For practical AI SDK usage examples and working tests, see `packages/core/src/__tests__/dependency/ai-sdk.test.ts` which demonstrates core APIs including text generation, tool usage, and structured output.
