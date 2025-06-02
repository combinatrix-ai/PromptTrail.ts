- Support caching
- Support multiple Source output types
- Use same metadata/context throughout the template
  - No updateContext and updateMetadata to include non predefined fields
  - No separate metadata and context for subroutines
- ModelOutput.metadata is not decided
- We need `walk` method for templates, because Conditional and Composite templates both have children
- Tests are redundant and useless
- Let Metadata and Context be updatable with immer

Areas for Improvement

1. API Consistency

Naming: Mixed patterns (withVar vs withVars, addTool vs withTool)
=> withVar / withVars are singular/plural, thus consistent
=> but addTool should be withTool, also add withTools for consistency
Builder patterns: Some use add(), others use specific methods
=> Should be looked deeper
Static vs instance methods: Inconsistent factory patterns

1. Type Safety Improvements

Generic type parameters are complex (<TAttrs, TVars>) and could be simplified
The any types in several places reduce type safety
Message type unions could be better discriminated

1. Documentation

Missing comprehensive API reference
Limited inline JSDoc comments
Examples scattered across test files
No migration guide from ai-sdk

4. Error Handling

Validation errors could be more descriptive
Debug mode errors are helpful but could be configurable per source
Async error boundaries not well defined

5. Testing

Integration tests rely on actual API calls (expensive, flaky)
Mock support is good but could be more ergonomic
Missing performance benchmarks

6. Developer Experience

The fluent API creates new instances - could be memory intensive
=> You can ignore this level of memory optimization, as it is not a bottleneck
No built-in retry/backoff for API failures
Limited middleware/plugin system
No request/response interceptors

1. Feature Gaps

No built-in conversation memory/history management
Limited support for multimodal (images, audio)
No automatic token counting/management
Missing conversation branching/merging

8. Architecture Concerns

Tight coupling with ai-sdk (what if you want to use a different base?)
The Source abstraction could be more powerful (middleware, transformations)
Template composition could be more flexible

9. Specific Code Issues

generate.ts is doing too much - should be split
The mock system in LlmSource feels bolted on
Validation retry logic is duplicated across sources
The Scenario API compiles to Agent - why not make it first-class?

10. Performance & Optimization

No request batching
No caching layer
Immutable approach might create many intermediate objects
No streaming support in high-level APIs
