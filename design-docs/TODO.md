- Support caching
- Support multiple Source output types
- Use same metadata/context throughout the template
  - No updateContext and updateMetadata to include non predefined fields
  - No separate metadata and context for subroutines
- ModelOutput.metadata is not decided
- We need `walk` method for templates, because Conditional and Composite templates both have children
- Tests are redundant and useless
- Let Metadata and Context be updatable with immer
