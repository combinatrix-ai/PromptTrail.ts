# API Redesign Proposal: Agent-based Interface

## Current Pain Points
1. Multiple setup steps required (model, input source, session, templates)
2. Separate LoggingSession wrapper needed for debugging
3. Complex import structure for basic usage

## Proposed Solution
Create a high-level `Agent` class that provides a more intuitive interface while maintaining the powerful underlying template system.

### New API Example
```typescript
import { Agent } from '@prompttrail/core';

// Simple chat example
const chat = new Agent({ debug: true })
  .addSystem("I'm a helpful assistant")
  .addLoop(
    new LoopTemplate()
      .addUser("What's on your mind?")
      .addAssistant({ model: 'gpt-4o-mini' })
  )
  .initWith({
    context: "You are a friendly AI assistant",
    metadata: { tone: 'casual' }
  });

// Start chatting
const result = await chat.start();
```

### Implementation Details

1. Agent Class
```typescript
interface AgentConfig {
  debug?: boolean;
  model?: string | ModelConfig;
  inputSource?: InputSource;
}

class Agent {
  private template: LinearTemplate;
  private debug: boolean;
  private model: Model;
  
  constructor(config: AgentConfig) {
    this.debug = config.debug ?? false;
    this.template = new LinearTemplate();
    // Initialize model based on config
  }

  // Template building methods
  addSystem(content: string): Agent { ... }
  addUser(content: string): Agent { ... }
  addAssistant(options: AssistantOptions): Agent { ... }
  addLoop(loop: LoopTemplate): Agent { ... }

  // Session initialization
  initWith(options: {
    context?: string;
    metadata?: Record<string, unknown>;
  }): Agent { ... }

  // Start conversation
  async start(): Promise<Session> { ... }
}
```

2. Internal Changes
- Create SessionFactory to handle debug/non-debug session creation
- Simplify model initialization with smart defaults
- Maintain compatibility with existing template system
- Add type inference for metadata

3. Migration Strategy
- Keep existing APIs functional
- Add deprecation warnings for old patterns
- Provide migration guide
- Include codemods for automated updates

## Benefits
1. More intuitive for new users
2. Less boilerplate code
3. Built-in debugging support
4. Maintains advanced capabilities
5. Type-safe metadata handling

## Considerations
1. Backward compatibility
2. Testing strategy
3. Documentation updates
4. Performance impact of abstraction

## Next Steps
1. Create proof of concept
2. Get feedback on API design
3. Implement core functionality
4. Add tests and documentation
5. Create migration tools