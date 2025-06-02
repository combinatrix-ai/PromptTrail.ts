# PromptTrail Examples

## Quick Start

- `bun run examples/new_api_demo.ts` - **NEW! Direct API showcase**
- `bun run examples/backward_compatibility_demo.ts` - **Both APIs side-by-side**
- `bun run examples/chat.ts` - Simple interactive chat
- `bun run examples/gradual_typing_demo.ts` - TypeScript typing patterns

## Advanced Examples

- `bun run examples/coding_agent.ts` - AI coding assistant with tools
- `bun run examples/autonomous_researcher.ts` - Research agent with goal tracking

## Legacy Examples (Using Old Source API)

- `examples/enhanced_source_demo.ts` - Source middleware features
- `examples/ai_scientist.ts` - Multi-provider structured output

## API Approaches

PromptTrail now supports **both** a simple direct API and the powerful Source API:

**🆕 Direct API (Recommended):**

```typescript
.user({ cli: 'Enter name:' })
.assistant({ provider: 'openai', model: 'gpt-4' })
```

**⚡ Source API (Power Users):**

```typescript
import { Source } from '@prompttrail/core';

.user(Source.cli('Enter name:'))
.assistant(Source.llm().openai().model('gpt-4'))
```

**Key Benefits:**

- ✅ **No Breaking Changes**: Existing Source code still works
- 🆕 **Simple Direct API**: Covers 90% of use cases
- ⚡ **Advanced Source API**: Middleware, complex validation, custom logic
- 🔄 **Mix & Match**: Use both approaches in the same agent

See `MIGRATION.md` for detailed guidance on when to use each approach.
