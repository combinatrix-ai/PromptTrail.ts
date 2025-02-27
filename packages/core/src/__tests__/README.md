# PromptTrail Test Organization

This directory contains tests for the PromptTrail library. The tests are organized in a hierarchical structure to improve maintainability, clarity, and coverage.

## Test Structure

The tests are organized in a hierarchical structure under `packages/core/src/__tests__/` that groups related tests together and separates unit tests from integration tests:

```
packages/core/src/__tests__/
├── unit/                           # Unit tests for individual components
│   ├── model/                      # Tests for model implementations
│   │   ├── openai.test.ts
│   │   ├── anthropic/
│   │   │   ├── model.test.ts
│   │   │   ├── mcp.test.ts
│   │   │   └── types.test.ts
│   │   └── base.test.ts
│   ├── templates/                  # Tests for template implementations
│   │   ├── linear.test.ts
│   │   ├── loop.test.ts
│   │   ├── system.test.ts
│   │   ├── user.test.ts
│   │   ├── assistant.test.ts
│   │   ├── subroutine.test.ts
│   │   ├── if.test.ts
│   │   ├── guardrail.test.ts
│   │   └── schema.test.ts
│   ├── utils/                      # Tests for utility functions
│   │   ├── extractors/
│   │   │   ├── markdown.test.ts
│   │   │   └── pattern.test.ts
│   │   ├── schema.test.ts
│   │   ├── session_transformer.test.ts
│   │   └── template_interpolation.test.ts
│   ├── validators/                 # Tests for validators
│   │   ├── base_validators.test.ts
│   │   ├── model_validators.test.ts
│   │   └── schema_validator.test.ts
│   ├── session.test.ts             # Core session tests
│   ├── metadata.test.ts            # Metadata tests
│   ├── input_source.test.ts        # Input source tests
│   └── tool.test.ts                # Tool tests
├── integration/                    # Integration tests
│   ├── mcp_integration.test.ts     # MCP integration tests
│   ├── schema_template.test.ts     # Schema template integration
│   ├── guardrail_template.test.ts  # Guardrail template integration
│   └── end_to_end.test.ts          # End-to-end workflow tests
├── fixtures/                       # Mock implementations and test data
│   ├── mcp_client/
│   ├── mcp_model/
│   ├── mcp_server/
│   └── test_data/                  # Test data for various scenarios
└── utils.ts                        # Common test utilities
```

## Import Paths

When writing tests, use relative paths for imports:

```typescript
// For files in unit/
import { createSession } from '../../session';
import { createMessage } from '../utils';

// For files in deeper directories like unit/model/anthropic/
import { AnthropicModel } from '../../../../model/anthropic/model';
import { createSession } from '../../../../session';
```

## Test Categories

### Unit Tests

Unit tests focus on testing individual components in isolation. They typically mock dependencies and focus on the behavior of a single unit of code.

### Integration Tests

Integration tests verify that different components work together correctly. They test the interactions between components and ensure that they integrate properly.

### Fixtures

Fixtures provide mock implementations and test data for use in tests. They help create a consistent testing environment and reduce duplication.


## Writing Tests

When writing tests, follow these guidelines:

1. **Test Organization**: Place tests in the appropriate directory based on the component being tested.
2. **Test Naming**: Name test files with the pattern `[component].test.ts`.
3. **Test Structure**: Use `describe` blocks to group related tests and `it` blocks for individual test cases.
4. **Assertions**: Use `expect` statements for assertions.
5. **Mocking**: Use fixtures and mocks to isolate the component being tested.
6. **Coverage**: Aim for comprehensive test coverage of all code paths.

## Test Utilities

Common test utilities are available in `utils.ts`. These include functions for creating test messages and other helper functions.

## Future Improvements

Consider the following improvements to the test suite:

1. **Consistent Test Patterns**: Standardize test structure across all files
2. **Better Mocking**: Enhance mock implementations for more realistic testing
3. **Test Coverage Analysis**: Add coverage reporting to identify gaps
4. **Test Documentation**: Add more descriptive comments explaining test scenarios
5. **Test Helpers**: Create additional helper functions for common test operations

## Running Tests

Tests can be run directly with vitest:

```bash
cd packages/core
pnpm exec vitest --run --watch=false
```

To run tests in watch mode during development:

```bash
cd packages/core
pnpm exec vitest
```

To run specific test files or directories:

```bash
cd packages/core
pnpm exec vitest run src/__tests__/unit/model --watch=false
```
