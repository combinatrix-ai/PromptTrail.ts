# Architecture Improvements

## 1. Template-First Design

### Current State
The current architecture has overlapping concepts between Agent and Template, leading to unnecessary complexity and confusion about which pattern to use.

### Proposed Changes

1. **Remove Agent Class**
   - Agent functionality is fully covered by Templates
   - No need for special configuration handling
   - Simpler mental model: "everything is a template"

2. **Template Usage Patterns**
   ```typescript
   // Create conversation flow
   const chat = new LinearTemplate()
     .addSystem("I'm a helpful assistant")
     .addAssistant("Hello ${name}!") // Context with interpolation
     .addUser({ inputSource: new CLIInputSource() }) // Get real user input
     .addAssistant("I see you're interested in ${topic}") // Predefined response
     .addUser("Yes, tell me more") // Impersonate user
     .addAssistant({ model }); // Let model generate response
   ```

3. **Session Improvements**
   ```typescript
   interface SessionOptions<T> {
     messages?: Message[];
     metadata?: T;
     print?: boolean;  // Enable conversation flow printing
   }

   // Usage
   const session = createSession({
     print: true,  // Print conversation flow
     metadata: {
       name: 'Alice',
       topic: 'TypeScript'
     }
   });
   ```

4. **Template Interpolation**
   - Support for ${variable} syntax in template content
   - Access to nested metadata paths (e.g., ${user.preferences.language})
   - Type-safe metadata access
   - Automatic empty string fallback for undefined values

### Benefits

1. **Simplified Architecture**
   - Single pattern for conversation management
   - Clear responsibility boundaries
   - Less code to maintain
   - Easier to understand and use

2. **Enhanced Flexibility**
   - Mix and match template types
   - Combine real input with predefined responses
   - Easy to add new template types
   - Natural composition of conversation flows

3. **Better Developer Experience**
   - Print mode for debugging
   - Type-safe metadata access
   - Clear patterns for common use cases
   - Less boilerplate code

## 2. Example: Converting Agent to Templates

### Before (Agent-based)
```typescript
const agent = new Agent({
  debug: true,
  model,
  inputSource
})
  .addSystem("I'm a helpful assistant")
  .addLoop(
    new LoopTemplate()
      .addUser("What's on your mind?")
      .addAssistant()
  );

const session = await agent.start();
```

### After (Template-based)
```typescript
const chat = new LinearTemplate()
  .addSystem("I'm a helpful assistant")
  .addAssistant("How can I help you today ${user.name}?")
  .addLoop(
    new LoopTemplate()
      .addUser("What's on your mind?", "", { inputSource })
      .addAssistant({ model })
  );

const session = await chat.execute(
  createSession({
    print: true,
    metadata: { user: { name: 'Alice' } }
  })
);
```

## 3. Migration Path

1. **Phase 1: Template Enhancements**
   - Add print option to Session
   - Implement metadata interpolation
   - Add support for different message patterns

2. **Phase 2: Agent Deprecation**
   - Mark Agent as deprecated
   - Update documentation to show template patterns
   - Provide migration examples

3. **Phase 3: Cleanup**
   - Remove Agent class
   - Update all examples to use templates
   - Ensure backward compatibility where needed

## 4. Future Considerations

1. **Template Patterns**
   - Document common patterns
   - Create specialized templates for common use cases
   - Add utilities for template composition

2. **Session Enhancements**
   - Consider additional debug options
   - Add more metadata utilities
   - Improve print formatting

3. **Developer Tools**
   - Add template validation
   - Improve error messages
   - Create testing utilities

## 5. Best Practices

1. **Template Design**
   - Keep templates focused and composable
   - Use metadata interpolation for dynamic content
   - Mix real input and predefined responses as needed
   - Consider reusability when designing templates

2. **Session Management**
   - Enable print mode during development
   - Use type-safe metadata
   - Keep metadata structure flat when possible
   - Clean up resources properly

3. **Conversation Flow**
   - Use system messages for context
   - Leverage assistant messages for both static and dynamic responses
   - Mix user input methods based on needs
   - Keep loops focused and exit conditions clear
