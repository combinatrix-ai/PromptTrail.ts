# PromptTrail.ts Development Guide

## Build & Test Commands

- Build all packages: `pnpm -r build`
- Run all tests: `pnpm test` or `vitest --run --watch=false`
- Run single test: `cd packages/core && pnpm exec vitest --run --watch=false src/__tests__/filename.test.ts`
- Run tests with pattern: `cd packages/core && pnpm exec vitest --run --watch=false "pattern"`
- Check types: `pnpm -C packages/core typecheck`
- Lint code: `pnpm lint` (fix issues) or `pnpm lint:check`
- Format code: `pnpm format` (fix) or `pnpm format:check`

## Coding Style Guidelines

- Use TypeScript with strict typing; avoid `any` types
- Use named exports for improved tree-shaking
- Imports order: external modules, then internal modules
- Use async/await for asynchronous code
- Create abstract base classes for extensibility
- Use generics for type-safe components
- Prefix interfaces with 'I', type aliases with 'T'
- Use JSDoc comments for public APIs
- Error handling: use explicit error types and descriptive messages
- Prefer functional programming patterns when appropriate
