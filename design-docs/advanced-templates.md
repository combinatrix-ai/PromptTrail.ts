# Advanced Template Patterns for PromptTrail

This document outlines several advanced template patterns that could be implemented in PromptTrail to enhance its capabilities for complex LLM interactions.

## 1. RankingTemplate

A template that supports inference-time scaling with simultaneous generation and ranking of multiple responses.

```typescript
class RankingTemplate extends Template {
  private templates: Template[] = [];
  private rankingStrategy: RankingStrategy;
  private count: number;

  constructor(options: {
    templates: Template[];
    rankingStrategy: RankingStrategy;
    count?: number;
  }) {
    super();
    this.templates = options.templates;
    this.rankingStrategy = options.rankingStrategy;
    this.count = options.count || 1;
  }

  async execute(session: Session): Promise<Session> {
    // Generate multiple responses in parallel
    const responseSessions = await Promise.all(
      this.templates.map(template => template.execute(session))
    );
    
    // Rank the responses using the provided strategy
    const rankedSessions = await this.rankingStrategy.rank(responseSessions);
    
    // Return the top N responses based on count
    const topResponses = rankedSessions.slice(0, this.count);
    
    // Merge the top responses into the session
    let resultSession = session;
    for (const response of topResponses) {
      resultSession = resultSession.addMessage(response.getLastMessage()!);
    }
    
    return resultSession;
  }
}

// Example ranking strategies
interface RankingStrategy {
  rank(sessions: Session[]): Promise<Session[]>;
}

class ModelBasedRanking implements RankingStrategy {
  constructor(private model: Model) {}
  
  async rank(sessions: Session[]): Promise<Session[]> {
    // Use the model to rank the sessions
    // Return sessions sorted by rank
  }
}

class HeuristicRanking implements RankingStrategy {
  async rank(sessions: Session[]): Promise<Session[]> {
    // Use heuristics to rank the sessions
    // Return sessions sorted by rank
  }
}
```

### Usage Example

```typescript
// Create multiple templates with different parameters
const templates = [
  new AssistantTemplate({ model: new OpenAIModel({ temperature: 0.2 }) }),
  new AssistantTemplate({ model: new OpenAIModel({ temperature: 0.5 }) }),
  new AssistantTemplate({ model: new OpenAIModel({ temperature: 0.8 }) }),
];

// Create a ranking template
const rankingTemplate = new RankingTemplate({
  templates,
  rankingStrategy: new ModelBasedRanking(rankingModel),
  count: 1, // Return only the top response
});

// Use in a conversation flow
const template = new LinearTemplate()
  .addSystem("You are a creative writing assistant.")
  .addUser("Write a short story about a robot learning to paint.")
  .addTemplate(rankingTemplate); // This will generate and rank multiple responses

const session = await template.execute(createSession());
```

## 2. SessionCompressorTransformer

A transformer that reduces session context length for managing token limits in long conversations.

```typescript
function createSessionCompressor<T extends Record<string, unknown>>(
  options: {
    strategy: 'summarize' | 'truncate' | 'select-important';
    model?: Model; // For summarization strategy
    maxTokens?: number;
    preserveTypes?: MessageType[]; // Message types to always preserve
  }
): SessionTransformer<T, T> {
  return createTransformer(async (session) => {
    switch (options.strategy) {
      case 'summarize':
        return summarizeSession(session, options);
      case 'truncate':
        return truncateSession(session, options);
      case 'select-important':
        return selectImportantMessages(session, options);
      default:
        return session;
    }
  });
}

// Helper functions
async function summarizeSession(session: Session, options: any): Promise<Session> {
  // Implementation that uses a model to summarize conversation history
  // and creates a new session with the summary as a system message
}

function truncateSession(session: Session, options: any): Session {
  // Implementation that keeps only the most recent messages
  // up to the specified token limit
}

async function selectImportantMessages(session: Session, options: any): Promise<Session> {
  // Implementation that selects important messages based on
  // relevance to the current conversation
}
```

### Usage Example

```typescript
// Create a template with context compression
const longConversationTemplate = new LinearTemplate()
  .addSystem("I'm a helpful assistant.")
  .addUser("Let's have a long conversation...")
  .addAssistant({ model })
  // ... more conversation ...
  .addTransformer(createSessionCompressor({
    strategy: 'summarize',
    model: summaryModel,
    maxTokens: 1000,
    preserveTypes: ['system']
  }))
  .addUser("Now, can you remember what we discussed earlier?")
  .addAssistant({ model });

const session = await longConversationTemplate.execute(createSession());
```

## 3. ParallelTemplate

A template that executes multiple sub-templates in parallel and combines their results.

```typescript
class ParallelTemplate extends Template {
  constructor(
    private options: {
      templates: Template[];
      combineWith: (sessions: Session[]) => Session;
    }
  ) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    // Execute all templates in parallel
    const results = await Promise.all(
      this.options.templates.map(template => template.execute(session))
    );
    
    // Combine results using the provided function
    return this.options.combineWith(results);
  }
}
```

### Usage Example

```typescript
// Create a parallel template for multi-perspective analysis
const parallelTemplate = new ParallelTemplate({
  templates: [
    new LinearTemplate()
      .addSystem("You're a financial analyst.")
      .addUser("Analyze this company: ${company}")
      .addAssistant({ model }),
    
    new LinearTemplate()
      .addSystem("You're a market researcher.")
      .addUser("Analyze this company: ${company}")
      .addAssistant({ model }),
    
    new LinearTemplate()
      .addSystem("You're a risk assessment expert.")
      .addUser("Analyze this company: ${company}")
      .addAssistant({ model }),
  ],
  combineWith: (sessions) => {
    // Combine the results from all templates
    let combinedSession = createSession();
    combinedSession = combinedSession.addMessage({
      type: 'system',
      content: 'Multi-perspective analysis:',
      metadata: createMetadata(),
    });
    
    for (const session of sessions) {
      combinedSession = combinedSession.addMessage(session.getLastMessage()!);
    }
    
    return combinedSession;
  }
});

// Use in a conversation
const template = new LinearTemplate()
  .addSystem("I provide comprehensive company analysis.")
  .addUser("Analyze Apple Inc.")
  .addTemplate(parallelTemplate);

const session = await template.execute(
  createSession({ metadata: { company: 'Apple Inc.' } })
);
```

## 4. StreamingTemplate

A template specifically designed for streaming responses with progress tracking.

```typescript
class StreamingTemplate extends Template {
  constructor(
    private options: {
      template: Template;
      onChunk?: (chunk: string) => void;
      onProgress?: (progress: number) => void;
    }
  ) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    // Create a streaming model wrapper if needed
    const streamingModel = this.model?.supportsStreaming 
      ? this.model 
      : new StreamingModelAdapter(this.model!);
    
    // Execute with streaming
    let finalContent = '';
    let finalSession = session;
    
    for await (const chunk of streamingModel.sendAsync(session)) {
      finalContent += chunk.content;
      if (this.options.onChunk) {
        this.options.onChunk(chunk.content);
      }
      if (this.options.onProgress) {
        // Estimate progress (implementation depends on model)
        this.options.onProgress(0.5); // Example
      }
    }
    
    // Return the final session with complete response
    return finalSession.addMessage({
      type: 'assistant',
      content: finalContent,
      metadata: createMetadata(),
    });
  }
}
```

### Usage Example

```typescript
// Create a streaming template with progress tracking
const streamingTemplate = new StreamingTemplate({
  template: new LinearTemplate()
    .addSystem("You're a storyteller.")
    .addUser("Tell me a story about dragons.")
    .addAssistant({ model }),
  
  onChunk: (chunk) => {
    // Process each chunk as it arrives
    console.log(chunk);
  },
  
  onProgress: (progress) => {
    // Update progress bar
    updateProgressBar(progress);
  }
});

const session = await streamingTemplate.execute(createSession());
```

## 5. FewShotTemplate

A template that dynamically builds few-shot examples based on a database of examples.

```typescript
class FewShotTemplate extends Template {
  constructor(
    private options: {
      exampleDatabase: ExampleDatabase;
      exampleCount: number;
      selectionStrategy: 'random' | 'similar' | 'diverse';
      promptTemplate: Template;
    }
  ) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    // Select examples based on the strategy
    const examples = await this.selectExamples(session);
    
    // Build a session with the examples
    let exampleSession = session;
    for (const example of examples) {
      exampleSession = exampleSession.addMessage(example.input);
      exampleSession = exampleSession.addMessage(example.output);
    }
    
    // Execute the prompt template with the examples
    return this.options.promptTemplate.execute(exampleSession);
  }
  
  private async selectExamples(session: Session): Promise<Example[]> {
    // Implementation depends on the selection strategy
    switch (this.options.selectionStrategy) {
      case 'random':
        return this.options.exampleDatabase.getRandom(this.options.exampleCount);
      case 'similar':
        const query = session.getLastMessage()?.content || '';
        return this.options.exampleDatabase.getSimilar(query, this.options.exampleCount);
      case 'diverse':
        return this.options.exampleDatabase.getDiverse(this.options.exampleCount);
      default:
        return [];
    }
  }
}

interface Example {
  input: Message;
  output: Message;
  metadata?: Record<string, unknown>;
}

interface ExampleDatabase {
  getRandom(count: number): Promise<Example[]>;
  getSimilar(query: string, count: number): Promise<Example[]>;
  getDiverse(count: number): Promise<Example[]>;
}
```

### Usage Example

```typescript
// Create an example database
const exampleDatabase = new VectorExampleDatabase({
  examples: [
    {
      input: { type: 'user', content: 'Translate "hello" to French' },
      output: { type: 'assistant', content: 'In French, "hello" is "bonjour".' }
    },
    // More examples...
  ]
});

// Create a few-shot template
const fewShotTemplate = new FewShotTemplate({
  exampleDatabase,
  exampleCount: 3,
  selectionStrategy: 'similar',
  promptTemplate: new LinearTemplate()
    .addSystem("You are a language translation assistant. Follow the examples.")
    .addUser("Translate '${word}' to ${language}")
    .addAssistant({ model })
});

// Use in a conversation
const template = new LinearTemplate()
  .addTemplate(fewShotTemplate);

const session = await template.execute(
  createSession({ 
    metadata: { 
      word: 'goodbye', 
      language: 'Spanish' 
    } 
  })
);
```

## 6. AgentTemplate

A template that implements an agent pattern with planning and execution.

```typescript
class AgentTemplate extends Template {
  constructor(
    private options: {
      planningModel: Model;
      executionModel: Model;
      tools: Tool[];
      maxIterations?: number;
    }
  ) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    let currentSession = session;
    let iterations = 0;
    const maxIterations = this.options.maxIterations || 5;
    
    while (iterations < maxIterations) {
      // Planning phase
      const planningTemplate = new LinearTemplate()
        .addSystem("You are a planning agent. Create a plan to solve the user's request.")
        .addUser(currentSession.getLastMessage()?.content || '')
        .addAssistant({ model: this.options.planningModel });
      
      const planSession = await planningTemplate.execute(currentSession);
      const plan = planSession.getLastMessage()?.content || '';
      
      // Extract actions from plan
      const actions = this.extractActions(plan);
      
      // Execute actions
      for (const action of actions) {
        const tool = this.options.tools.find(t => t.name === action.tool);
        if (tool) {
          const result = await tool.execute(action.parameters);
          currentSession = currentSession.addMessage({
            type: 'tool_result',
            content: JSON.stringify(result),
            metadata: createMetadata().set('tool', action.tool),
          });
        }
      }
      
      // Generate response based on tool results
      const responseTemplate = new LinearTemplate()
        .addSystem("Generate a response based on the tool results.")
        .addAssistant({ model: this.options.executionModel });
      
      currentSession = await responseTemplate.execute(currentSession);
      
      // Check if we need another iteration
      if (this.isComplete(currentSession)) {
        break;
      }
      
      iterations++;
    }
    
    return currentSession;
  }
  
  private extractActions(plan: string): { tool: string; parameters: any }[] {
    // Implementation to extract actions from the plan
    return [];
  }
  
  private isComplete(session: Session): boolean {
    // Implementation to determine if the task is complete
    return false;
  }
}
```

### Usage Example

```typescript
// Create tools
const calculator = createTool({
  name: 'calculator',
  description: 'Perform calculations',
  schema: {
    properties: {
      expression: { type: 'string', description: 'Math expression to evaluate' }
    },
    required: ['expression']
  },
  execute: async (input) => eval(input.expression)
});

const weatherApi = createTool({
  name: 'weather',
  description: 'Get weather information',
  schema: {
    properties: {
      location: { type: 'string', description: 'City or location' }
    },
    required: ['location']
  },
  execute: async (input) => getWeatherData(input.location)
});

// Create an agent template
const agentTemplate = new AgentTemplate({
  planningModel: new OpenAIModel({ modelName: 'gpt-4o-mini' }),
  executionModel: new OpenAIModel({ modelName: 'gpt-4o-mini' }),
  tools: [calculator, weatherApi],
  maxIterations: 3
});

// Use in a conversation
const template = new LinearTemplate()
  .addSystem("I'm an AI assistant that can help with various tasks.")
  .addUser("What's the temperature in New York plus the temperature in Los Angeles divided by 2?")
  .addTemplate(agentTemplate);

const session = await template.execute(createSession());
```

## 7. VersioningTemplate

A template that supports versioning and A/B testing of prompts.

```typescript
class VersioningTemplate extends Template {
  constructor(
    private options: {
      versions: Record<string, Template>;
      activeVersion?: string;
      selectionStrategy?: 'fixed' | 'random' | 'weighted';
      weights?: Record<string, number>;
      onVersionSelected?: (version: string) => void;
    }
  ) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    // Select a version based on the strategy
    const version = this.selectVersion();
    
    // Notify about the selected version
    if (this.options.onVersionSelected) {
      this.options.onVersionSelected(version);
    }
    
    // Execute the selected version
    const template = this.options.versions[version];
    if (!template) {
      throw new Error(`Version ${version} not found`);
    }
    
    // Add version metadata
    const sessionWithVersion = session.updateMetadata({
      promptVersion: version,
    });
    
    // Execute the template
    const result = await template.execute(sessionWithVersion);
    
    return result;
  }
  
  private selectVersion(): string {
    switch (this.options.selectionStrategy) {
      case 'fixed':
        return this.options.activeVersion || Object.keys(this.options.versions)[0];
      case 'random':
        const versions = Object.keys(this.options.versions);
        return versions[Math.floor(Math.random() * versions.length)];
      case 'weighted':
        return this.selectWeightedVersion();
      default:
        return this.options.activeVersion || Object.keys(this.options.versions)[0];
    }
  }
  
  private selectWeightedVersion(): string {
    // Implementation for weighted random selection
    return '';
  }
}
```

### Usage Example

```typescript
// Create different versions of a prompt
const versions = {
  'v1': new LinearTemplate()
    .addSystem("You are a helpful assistant.")
    .addUser("${query}")
    .addAssistant({ model }),
  
  'v2': new LinearTemplate()
    .addSystem("You are a knowledgeable expert.")
    .addUser("${query}")
    .addAssistant({ model }),
  
  'v3': new LinearTemplate()
    .addSystem("You are a friendly guide.")
    .addUser("${query}")
    .addAssistant({ model })
};

// Create a versioning template for A/B testing
const versioningTemplate = new VersioningTemplate({
  versions,
  selectionStrategy: 'weighted',
  weights: { 'v1': 0.2, 'v2': 0.3, 'v3': 0.5 },
  onVersionSelected: (version) => {
    // Log the selected version for analytics
    logVersionSelection(version);
  }
});

// Use in a conversation
const template = new LinearTemplate()
  .addTemplate(versioningTemplate);

const session = await template.execute(
  createSession({ metadata: { query: 'Explain quantum computing' } })
);

// Access version information
const version = session.metadata.get('promptVersion');
console.log(`Used prompt version: ${version}`);
```

## 8. CachingTemplate

A template that caches responses for similar inputs.

```typescript
class CachingTemplate extends Template {
  constructor(
    private options: {
      template: Template;
      cacheKey?: (session: Session) => string;
      cacheTTL?: number; // Time to live in milliseconds
      similarityThreshold?: number; // For fuzzy matching
    }
  ) {
    super();
    this.cache = new Map();
  }

  private cache: Map<string, { response: Session; timestamp: number }>;

  async execute(session: Session): Promise<Session> {
    // Generate cache key
    const cacheKey = this.options.cacheKey 
      ? this.options.cacheKey(session)
      : this.defaultCacheKey(session);
    
    // Check cache
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return cached;
    }
    
    // Execute template
    const result = await this.options.template.execute(session);
    
    // Store in cache
    this.cache.set(cacheKey, {
      response: result,
      timestamp: Date.now(),
    });
    
    return result;
  }
  
  private defaultCacheKey(session: Session): string {
    // Default implementation uses the last user message
    const lastUserMessage = session.getMessagesByType('user').pop();
    return lastUserMessage?.content || '';
  }
  
  private getFromCache(key: string): Session | null {
    // Check exact match
    if (this.cache.has(key)) {
      const cached = this.cache.get(key)!;
      
      // Check TTL
      if (this.options.cacheTTL && 
          Date.now() - cached.timestamp > this.options.cacheTTL) {
        this.cache.delete(key);
        return null;
      }
      
      return cached.response;
    }
    
    // Check fuzzy match if threshold is set
    if (this.options.similarityThreshold) {
      // Implementation for fuzzy matching
    }
    
    return null;
  }
}
```

### Usage Example

```typescript
// Create a caching template for expensive operations
const cachingTemplate = new CachingTemplate({
  template: new LinearTemplate()
    .addSystem("You are a research assistant.")
    .addUser("Summarize the latest research on ${topic}")
    .addAssistant({ model }),
  
  cacheTTL: 24 * 60 * 60 * 1000, // 24 hours
  similarityThreshold: 0.8 // Allow fuzzy matching
});

// Use in a conversation
const template = new LinearTemplate()
  .addTemplate(cachingTemplate);

// First execution will call the model
const session1 = await template.execute(
  createSession({ metadata: { topic: 'quantum computing' } })
);

// Second execution with similar query will use cache
const session2 = await template.execute(
  createSession({ metadata: { topic: 'quantum computers' } })
);
```

## 9. GuardrailTemplate

A template that evaluates responses against quality criteria and regenerates if necessary.

```typescript
class GuardrailTemplate extends Template {
  constructor(
    private options: {
      template: Template;
      evaluationModel: Model;
      evaluationPrompt?: string;
      maxAttempts?: number;
      scoreThreshold?: number;
      onRejection?: (score: number, content: string, attempt: number) => void;
      customEvaluator?: (session: Session) => Promise<{score: number; feedback?: string}>;
    }
  ) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    const maxAttempts = this.options.maxAttempts || 3;
    const scoreThreshold = this.options.scoreThreshold || 0.7; // Default threshold
    
    let attempts = 0;
    let resultSession: Session;
    let evaluationResult: {score: number; feedback?: string};
    
    do {
      attempts++;
      
      // Execute the template
      resultSession = await this.options.template.execute(session);
      
      // Evaluate the result
      if (this.options.customEvaluator) {
        evaluationResult = await this.options.customEvaluator(resultSession);
      } else {
        evaluationResult = await this.evaluateWithModel(resultSession);
      }
      
      // Call rejection handler if provided
      if (evaluationResult.score < scoreThreshold && this.options.onRejection) {
        this.options.onRejection(
          evaluationResult.score, 
          resultSession.getLastMessage()?.content || '',
          attempts
        );
      }
      
      // Add evaluation metadata
      resultSession = resultSession.updateMetadata({
        guardrail: {
          attempt: attempts,
          score: evaluationResult.score,
          feedback: evaluationResult.feedback,
          passed: evaluationResult.score >= scoreThreshold
        }
      });
      
    } while (evaluationResult.score < scoreThreshold && attempts < maxAttempts);
    
    return resultSession;
  }
  
  private async evaluateWithModel(session: Session): Promise<{score: number; feedback?: string}> {
    const lastMessage = session.getLastMessage();
    if (!lastMessage) {
      return { score: 0, feedback: "No message to evaluate" };
    }
    
    // Create evaluation prompt
    const evaluationPrompt = this.options.evaluationPrompt || 
      `Evaluate the following AI response for quality, accuracy, and safety.
       
       Response to evaluate:
       "${lastMessage.content}"
       
       Provide a score between 0.0 and 1.0, where:
       - 0.0 means completely unacceptable (unsafe, incorrect, or inappropriate)
       - 1.0 means perfect (safe, accurate, and helpful)
       
       Format your response as:
       Score: [number between 0.0 and 1.0]
       Feedback: [explanation of the score]`;
    
    // Create evaluation session
    const evaluationSession = createSession().addMessage({
      type: 'system',
      content: evaluationPrompt,
      metadata: createMetadata(),
    });
    
    // Get evaluation from model
    const evaluationResponse = await this.options.evaluationModel.send(evaluationSession);
    
    // Parse score and feedback
    const scoreMatch = evaluationResponse.content.match(/Score:\s*([\d.]+)/i);
    const feedbackMatch = evaluationResponse.content.match(/Feedback:\s*(.*)/is);
    
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
    const feedback = feedbackMatch ? feedbackMatch[1].trim() : undefined;
    
    return { score, feedback };
  }
}
```

### Usage Example

```typescript
// Create a guardrail template that ensures safe and high-quality responses
const guardrailTemplate = new GuardrailTemplate({
  template: new LinearTemplate()
    .addSystem("You are a helpful assistant.")
    .addUser("Tell me about nuclear energy.")
    .addAssistant({ model: mainModel }),
  
  evaluationModel: evaluationModel, // A separate model for evaluation
  
  evaluationPrompt: `
    Evaluate the following AI response for accuracy, balance, and educational value.
    
    Response to evaluate:
    "\${response}"
    
    Score from 0.0 to 1.0 based on:
    - Scientific accuracy (0.0-0.4)
    - Balanced perspective (0.0-0.3)
    - Educational value (0.0-0.3)
    
    Format:
    Score: [total score]
    Feedback: [detailed explanation]
  `,
  
  maxAttempts: 3,
  scoreThreshold: 0.8,
  
  onRejection: (score, content, attempt) => {
    console.log(`Attempt ${attempt} rejected with score ${score}`);
    console.log(`Rejected content: ${content.substring(0, 100)}...`);
  }
});

// Execute the template
const session = await guardrailTemplate.execute(createSession());

// Access the final response and metadata
const response = session.getLastMessage()?.content;
const guardrailInfo = session.metadata.get('guardrail');
console.log(`Final response (score: ${guardrailInfo.score}) after ${guardrailInfo.attempt} attempts`);
```

## Integration Patterns

These templates can be combined in powerful ways to create sophisticated conversation flows:

### Ranking with Guardrails

```typescript
// Generate multiple responses, rank them, and apply guardrails
const template = new GuardrailTemplate({
  template: new RankingTemplate({
    templates: [
      new AssistantTemplate({ model: model1 }),
      new AssistantTemplate({ model: model2 }),
      new AssistantTemplate({ model: model3 }),
    ],
    rankingStrategy: new ModelBasedRanking(rankingModel),
    count: 1
  }),
  evaluationModel: evaluationModel,
  // other options
});
```

### Parallel Processing with Caching

```typescript
// Process multiple tasks in parallel with caching
const template = new CachingTemplate({
  template: new ParallelTemplate({
    templates: [
      new LinearTemplate().addSystem("Task 1").addAssistant({ model }),
      new LinearTemplate().addSystem("Task 2").addAssistant({ model }),
      new LinearTemplate().addSystem("Task 3").addAssistant({ model }),
    ],
    combineWith: (sessions) => {
      // Combine results
    }
  }),
  cacheTTL: 3600000 // 1 hour
});
```

### Agent with Context Compression

```typescript
// Agent with context compression for long-running tasks
const template = new LinearTemplate()
  .addSystem("I'm an AI assistant that can help with various tasks.")
  .addUser("${query}")
  .addTemplate(new AgentTemplate({
    planningModel,
    executionModel,
    tools: [calculator, weatherApi, searchTool],
    maxIterations: 5
  }))
  .addTransformer(createSessionCompressor({
    strategy: 'summarize',
    model: summaryModel,
    maxTokens: 2000
  }))
  .addUser("Can you explain your reasoning?")
  .addAssistant({ model });
```

## 10. VectorSearchTemplate

A template that implements Retrieval-Augmented Generation (RAG) by searching a vector database for relevant context before generating responses.

```typescript
class VectorSearchTemplate extends Template {
  constructor(
    private options: {
      vectorStore: VectorStore;
      queryGenerator?: (session: Session) => string | Promise<string>;
      queryModel?: Model;
      retrievalCount?: number;
      similarityThreshold?: number;
      contextTemplate: Template;
      includeMetadata?: boolean;
      reranker?: (documents: Document[], query: string) => Promise<Document[]>;
    }
  ) {
    super();
  }

  async execute(session: Session): Promise<Session> {
    // 1. Generate search query from the session
    const query = await this.generateQuery(session);
    
    // 2. Retrieve relevant documents from vector store
    let documents = await this.options.vectorStore.search({
      query,
      limit: this.options.retrievalCount || 5,
      similarityThreshold: this.options.similarityThreshold,
    });
    
    // 3. Optional reranking step
    if (this.options.reranker && documents.length > 0) {
      documents = await this.options.reranker(documents, query);
    }
    
    // 4. Add retrieved context to session
    let contextSession = session;
    
    if (documents.length > 0) {
      // Add system message with retrieved context
      const contextContent = this.formatDocumentsAsContext(documents);
      contextSession = contextSession.addMessage({
        type: 'system',
        content: `Here is relevant information to help answer the query:\n\n${contextContent}`,
        metadata: createMetadata().set('source', 'vector_search'),
      });
      
      // Optionally add document metadata to session metadata
      if (this.options.includeMetadata) {
        const docsMetadata = documents.map(doc => ({
          id: doc.id,
          score: doc.score,
          metadata: doc.metadata,
        }));
        
        contextSession = contextSession.updateMetadata({
          retrievedDocuments: docsMetadata,
        });
      }
    }
    
    // 5. Execute the context template with the augmented session
    return this.options.contextTemplate.execute(contextSession);
  }
  
  private async generateQuery(session: Session): Promise<string> {
    // If custom query generator is provided, use it
    if (this.options.queryGenerator) {
      return this.options.queryGenerator(session);
    }
    
    // If query model is provided, use it to generate a search query
    if (this.options.queryModel) {
      const queryGenSession = createSession().addMessage({
        type: 'system',
        content: `Generate a search query to find information that would help answer the user's question. 
                 The query should be concise and focus on the key concepts.
                 
                 User's question: "${session.getLastMessage()?.content || ''}"
                 
                 Search query:`,
        metadata: createMetadata(),
      });
      
      const response = await this.options.queryModel.send(queryGenSession);
      return response.content.trim();
    }
    
    // Default: use the last user message as the query
    const lastUserMessage = session.getMessagesByType('user').pop();
    return lastUserMessage?.content || '';
  }
  
  private formatDocumentsAsContext(documents: Document[]): string {
    return documents.map((doc, index) => {
      let content = `[Document ${index + 1}]`;
      
      if (doc.metadata?.title) {
        content += `\nTitle: ${doc.metadata.title}`;
      }
      
      if (doc.metadata?.source) {
        content += `\nSource: ${doc.metadata.source}`;
      }
      
      content += `\n\n${doc.content}\n\n`;
      
      return content;
    }).join('---\n\n');
  }
}

// Vector store interface
interface VectorStore {
  search(options: {
    query: string;
    limit?: number;
    similarityThreshold?: number;
    filter?: Record<string, any>;
  }): Promise<Document[]>;
  
  add(documents: Document[]): Promise<void>;
  delete(ids: string[]): Promise<void>;
}

// Document interface
interface Document {
  id: string;
  content: string;
  metadata?: Record<string, any>;
  score?: number; // Similarity score from search
}
```

### Usage Example

```typescript
// Create a vector store implementation
class SimpleVectorStore implements VectorStore {
  constructor(private documents: Document[] = []) {}
  
  async search(options: { query: string; limit?: number; similarityThreshold?: number }): Promise<Document[]> {
    // In a real implementation, this would use vector embeddings and similarity search
    // This is just a simple example using keyword matching
    const results = this.documents
      .map(doc => ({
        ...doc,
        score: this.calculateScore(doc.content, options.query),
      }))
      .filter(doc => doc.score > (options.similarityThreshold || 0))
      .sort((a, b) => b.score! - a.score!)
      .slice(0, options.limit || 5);
    
    return results;
  }
  
  async add(documents: Document[]): Promise<void> {
    this.documents.push(...documents);
  }
  
  async delete(ids: string[]): Promise<void> {
    this.documents = this.documents.filter(doc => !ids.includes(doc.id));
  }
  
  private calculateScore(content: string, query: string): number {
    // Simple keyword matching for demonstration
    const words = query.toLowerCase().split(/\s+/);
    const contentLower = content.toLowerCase();
    
    let matches = 0;
    for (const word of words) {
      if (contentLower.includes(word)) {
        matches++;
      }
    }
    
    return matches / words.length;
  }
}

// Create a vector store with some documents
const vectorStore = new SimpleVectorStore([
  {
    id: '1',
    content: 'TypeScript is a strongly typed programming language that builds on JavaScript.',
    metadata: { title: 'TypeScript Overview', source: 'docs' }
  },
  {
    id: '2',
    content: 'React is a JavaScript library for building user interfaces, particularly single-page applications.',
    metadata: { title: 'React Introduction', source: 'docs' }
  },
  {
    id: '3',
    content: 'Node.js is a JavaScript runtime built on Chrome\'s V8 JavaScript engine.',
    metadata: { title: 'Node.js Overview', source: 'docs' }
  }
]);

// Create a vector search template
const vectorSearchTemplate = new VectorSearchTemplate({
  vectorStore,
  retrievalCount: 2,
  similarityThreshold: 0.3,
  contextTemplate: new LinearTemplate()
    .addSystem("You are a helpful programming assistant. Use the provided context to answer the user's question.")
    .addUser("${query}")
    .addAssistant({ model }),
  includeMetadata: true
});

// Use in a conversation
const template = new LinearTemplate()
  .addSystem("I'm a programming assistant with access to documentation.")
  .addUser("Tell me about TypeScript")
  .addTemplate(vectorSearchTemplate);

const session = await template.execute(
  createSession({ metadata: { query: 'Tell me about TypeScript' } })
);
```

### Advanced Features

#### 1. Multi-Query Retrieval

For better coverage of the information space, you can implement multi-query retrieval:

```typescript
class VectorSearchTemplate extends Template {
  // ... existing implementation
  
  private async generateMultipleQueries(session: Session): Promise<string[]> {
    if (!this.options.queryModel) {
      return [this.getLastUserMessage(session)];
    }
    
    const queryGenSession = createSession().addMessage({
      type: 'system',
      content: `Generate 3 different search queries to find information that would help answer the user's question.
               Each query should focus on different aspects of the question.
               Format your response as a numbered list with one query per line.
               
               User's question: "${session.getLastMessage()?.content || ''}"
               
               Queries:`,
      metadata: createMetadata(),
    });
    
    const response = await this.options.queryModel.send(queryGenSession);
    
    // Parse the numbered list of queries
    const queries = response.content
      .split('\n')
      .filter(line => /^\d+\./.test(line))
      .map(line => line.replace(/^\d+\.\s*/, '').trim());
    
    return queries.length > 0 ? queries : [this.getLastUserMessage(session)];
  }
  
  private async multiQuerySearch(queries: string[]): Promise<Document[]> {
    // Perform searches for each query
    const searchResults = await Promise.all(
      queries.map(query => 
        this.options.vectorStore.search({
          query,
          limit: Math.ceil((this.options.retrievalCount || 5) / queries.length),
          similarityThreshold: this.options.similarityThreshold,
        })
      )
    );
    
    // Merge and deduplicate results
    const seenIds = new Set<string>();
    const mergedResults: Document[] = [];
    
    for (const results of searchResults) {
      for (const doc of results) {
        if (!seenIds.has(doc.id)) {
          seenIds.add(doc.id);
          mergedResults.push(doc);
        }
      }
    }
    
    return mergedResults.slice(0, this.options.retrievalCount || 5);
  }
}
```

#### 2. Hybrid Search

Combine vector search with traditional keyword search for better results:

```typescript
interface KeywordIndex {
  search(query: string, limit?: number): Promise<Document[]>;
}

class VectorSearchTemplate extends Template {
  constructor(
    private options: {
      // ... existing options
      keywordIndex?: KeywordIndex;
      hybridRatio?: number; // 0 = all keyword, 1 = all vector
    }
  ) {
    super();
  }
  
  private async hybridSearch(query: string): Promise<Document[]> {
    const hybridRatio = this.options.hybridRatio ?? 0.5;
    const limit = this.options.retrievalCount || 5;
    
    // Allocate limits based on hybrid ratio
    const vectorLimit = Math.ceil(limit * hybridRatio);
    const keywordLimit = Math.ceil(limit * (1 - hybridRatio));
    
    // Perform vector search
    const vectorResults = await this.options.vectorStore.search({
      query,
      limit: vectorLimit,
      similarityThreshold: this.options.similarityThreshold,
    });
    
    // Perform keyword search if available
    let keywordResults: Document[] = [];
    if (this.options.keywordIndex) {
      keywordResults = await this.options.keywordIndex.search(query, keywordLimit);
    }
    
    // Combine and deduplicate results
    const seenIds = new Set<string>();
    const mergedResults: Document[] = [];
    
    // Add vector results first
    for (const doc of vectorResults) {
      seenIds.add(doc.id);
      mergedResults.push(doc);
    }
    
    // Add keyword results if not already included
    for (const doc of keywordResults) {
      if (!seenIds.has(doc.id)) {
        seenIds.add(doc.id);
        mergedResults.push(doc);
      }
    }
    
    return mergedResults.slice(0, limit);
  }
}
```

#### 3. Contextual Compression

Compress retrieved documents to fit more context within token limits:

```typescript
class VectorSearchTemplate extends Template {
  constructor(
    private options: {
      // ... existing options
      compressDocuments?: boolean;
      compressionModel?: Model;
    }
  ) {
    super();
  }
  
  private async compressDocuments(documents: Document[], query: string): Promise<Document[]> {
    if (!this.options.compressionModel) {
      return documents;
    }
    
    const compressedDocs = await Promise.all(
      documents.map(async doc => {
        const compressionSession = createSession().addMessage({
          type: 'system',
          content: `Compress the following document to contain only information relevant to the query: "${query}"
                   Preserve key facts, but remove irrelevant details.
                   
                   Document:
                   ${doc.content}
                   
                   Compressed version:`,
          metadata: createMetadata(),
        });
        
        const response = await this.options.compressionModel.send(compressionSession);
        
        return {
          ...doc,
          content: response.content.trim(),
          metadata: {
            ...doc.metadata,
            compressed: true,
            originalLength: doc.content.length,
            compressedLength: response.content.trim().length,
          }
        };
      })
    );
    
    return compressedDocs;
  }
}
```

## Conclusion

These advanced template patterns extend PromptTrail's capabilities while maintaining its core principles of type safety, immutability, and composability. By implementing these patterns, developers can create more sophisticated, efficient, and reliable LLM applications.

Each template addresses specific challenges in LLM application development:

1. **RankingTemplate**: Improves response quality through multiple generation and selection
2. **SessionCompressorTransformer**: Manages context length in long conversations
3. **ParallelTemplate**: Enables concurrent processing for efficiency and multi-perspective analysis
4. **StreamingTemplate**: Enhances user experience with real-time response streaming
5. **FewShotTemplate**: Improves performance through dynamic example selection
6. **AgentTemplate**: Enables complex reasoning and tool use
7. **VersioningTemplate**: Facilitates prompt engineering and A/B testing
8. **CachingTemplate**: Improves efficiency and reduces costs
9. **GuardrailTemplate**: Ensures response quality and safety
10. **VectorSearchTemplate**: Implements Retrieval-Augmented Generation (RAG) for knowledge-grounded responses

These templates can be implemented incrementally, starting with those that address the most pressing needs for your specific use case.
