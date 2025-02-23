# PromptTrail Architecture Improvements

## 1. Template System Enhancements

### Template Registry Pattern
```typescript
// Central registry for template types
class TemplateRegistry {
  private static templates = new Map<string, typeof Template>();

  static register(name: string, template: typeof Template) {
    this.templates.set(name, template);
  }

  static create(name: string, config: any): Template {
    const TemplateClass = this.templates.get(name);
    if (!TemplateClass) throw new Error(`Template ${name} not found`);
    return new TemplateClass(config);
  }
}

// Register built-in templates
TemplateRegistry.register('linear', LinearTemplate);
TemplateRegistry.register('loop', LoopTemplate);
TemplateRegistry.register('if', IfTemplate);
TemplateRegistry.register('subroutine', SubroutineTemplate);

// Usage
const template = TemplateRegistry.create('loop', {
  templates: [...],
  exitCondition: (session) => boolean
});
```

## 2. Model Management

### ModelProvider Pattern
```typescript
interface ModelProvider {
  getModel(config: Partial<ModelConfig>): Model;
  withTools(tools: Tool[]): ModelProvider;
}

class OpenAIProvider implements ModelProvider {
  private baseConfig: Partial<OpenAIConfig>;
  private tools: Tool[] = [];

  constructor(config: Partial<OpenAIConfig>) {
    this.baseConfig = config;
  }

  withTools(tools: Tool[]): ModelProvider {
    const provider = new OpenAIProvider(this.baseConfig);
    provider.tools = [...this.tools, ...tools];
    return provider;
  }

  getModel(config: Partial<OpenAIConfig>): Model {
    return new OpenAIModel({
      ...this.baseConfig,
      ...config,
      tools: this.tools
    });
  }
}

// Usage
const provider = new OpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY
})
.withTools([calculator, weather]);

const preciseModel = provider.getModel({
  temperature: 0.1,
  modelName: 'gpt-4o-mini'
});

const creativeModel = provider.getModel({
  temperature: 0.7,
  modelName: 'gpt-4o-mini'
});
```

## 3. Session Transformation

### SessionTransformer Utility
```typescript
class SessionTransformer {
  static transform<T, U>(
    session: Session<T>,
    options: {
      includeMessages?: boolean;
      messageFilter?: (message: Message) => boolean;
      metadataTransform?: (metadata: T) => U;
    }
  ): Session<U> {
    const messages = options.includeMessages
      ? (options.messageFilter
          ? session.messages.filter(options.messageFilter)
          : session.messages)
      : [];

    const metadata = options.metadataTransform
      ? options.metadataTransform(session.metadata.toObject())
      : {};

    return createSession<U>({ messages, metadata });
  }
}

// Usage in SubroutineTemplate
init_with: (parentSession) => 
  SessionTransformer.transform(parentSession, {
    includeMessages: false,
    metadataTransform: (metadata) => ({
      projectId: metadata.projectId,
      preferences: metadata.preferences
    })
  });
```

## 4. Tool Management

### ToolProvider Pattern
```typescript
interface ToolProvider {
  getTool(name: string): Tool;
  register(tool: Tool): void;
  getToolsForModel(model: Model): Tool[];
}

class DefaultToolProvider implements ToolProvider {
  private tools = new Map<string, Tool>();
  private modelTools = new Map<string, Set<string>>();

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  assignToModel(modelName: string, toolNames: string[]) {
    this.modelTools.set(
      modelName,
      new Set(toolNames)
    );
  }

  getTool(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool ${name} not found`);
    return tool;
  }

  getToolsForModel(model: Model): Tool[] {
    const toolNames = this.modelTools.get(model.name) || new Set();
    return Array.from(toolNames).map(name => this.getTool(name));
  }
}

// Usage
const toolProvider = new DefaultToolProvider();
toolProvider.register(calculator);
toolProvider.register(weather);

toolProvider.assignToModel('gpt-4o-mini', ['calculator', 'weather']);
toolProvider.assignToModel('claude-3-5-haiku-latest', ['calculator']);

const model = new OpenAIModel({
  modelName: 'gpt-4o-mini',
  tools: toolProvider.getToolsForModel(model)
});
```

## 5. Improved Agent Configuration

### Builder Pattern with Type Safety
```typescript
class AgentBuilder<T extends Record<string, unknown>> {
  private config: Partial<AgentConfig> = {};
  private metadata: Partial<T> = {};
  private templates: Template[] = [];

  withModel(model: Model | ModelConfig): AgentBuilder<T> {
    this.config.model = model;
    return this;
  }

  withDebug(debug: boolean): AgentBuilder<T> {
    this.config.debug = debug;
    return this;
  }

  withMetadata(metadata: Partial<T>): AgentBuilder<T> {
    this.metadata = { ...this.metadata, ...metadata };
    return this;
  }

  addTemplate(template: Template): AgentBuilder<T> {
    this.templates.push(template);
    return this;
  }

  build(): Agent<T> {
    const agent = new Agent<T>(this.config);
    for (const template of this.templates) {
      agent.addTemplate(template);
    }
    agent.initWith({ metadata: this.metadata as T });
    return agent;
  }
}

// Usage
const agent = new AgentBuilder<ChatMetadata>()
  .withModel(model)
  .withDebug(true)
  .withMetadata({
    userId: 'user123',
    preferences: { language: 'en' }
  })
  .addTemplate(systemTemplate)
  .addTemplate(loopTemplate)
  .build();
```

## Benefits

1. **Modularity**
   - Clear separation of concerns
   - Easy to extend with new templates/models/tools
   - Better testing isolation

2. **Type Safety**
   - Improved type inference
   - Better error messages
   - Compile-time checks

3. **Reusability**
   - Share configurations across instances
   - Compose functionality
   - Reduce duplication

4. **Maintainability**
   - Centralized registration
   - Consistent patterns
   - Clear dependencies

## Migration Strategy

1. **Phase 1: Tool Management**
   - Implement ToolProvider
   - Update existing tool usage
   - Add tool registration

2. **Phase 2: Model Providers**
   - Create provider interfaces
   - Implement for OpenAI/Anthropic
   - Update model creation

3. **Phase 3: Template Registry**
   - Add registry system
   - Register built-in templates
   - Update template creation

4. **Phase 4: Session Utilities**
   - Add transformation utilities
   - Update session handling
   - Improve type safety