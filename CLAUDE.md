# CLAUDE.md - PromptTrail.ts Project Guidelines

## Project Overview

PromptTrail.ts is a TypeScript-first framework for building structured LLM conversations with type safety and composability. Built on top of Vercel's ai-sdk, it provides a fluent API for creating complex conversation flows with immutable state management.

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
- **Structured**: Schema-validated output

### Sources

- **Source.llm()**: Generate via LLM
- **Source.cli()**: User input from terminal
- **Source.literal()**: Fixed content
- **Source.callback()**: Custom logic
- **Source.random()**: Random from list
- **Source.list()**: Sequential from list
- **Source.schema()**: Structured generation

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

## Known Issues and TODOs

From `design-docs/TODO.md`:

- Support caching mechanisms
- Multiple Source output types
- Improve session creation ergonomics
- Make Metadata and Context updatable with immer
- Add `walk` method for template traversal

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

### With MCP (Model Context Protocol)

- MCP server configuration support
- Tool registration for Anthropic models

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

## Future Roadmap

- React integration package (`@prompttrail/react`)
- Additional provider support
- Enhanced caching mechanisms
- Improved browser compatibility
- More built-in validators and tools

---

Remember: This is a type-safe, immutable, composable framework. When in doubt, follow these principles and check existing implementations for patterns.
