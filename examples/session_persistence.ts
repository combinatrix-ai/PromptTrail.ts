// Example: Session Persistence with Usage Tracking
import {
  Session,
  Source,
  Assistant,
  createInMemoryPersistence,
  createJSONFilePersistence,
} from '@prompttrail/core';

/**
 * Example 1: In-memory persistence (for testing/development)
 */
async function example1_InMemory() {
  console.log('\n=== Example 1: In-Memory Persistence ===\n');

  // Create persistence manager
  const persistence = createInMemoryPersistence();

  // Create a session with LLM calls
  let session = Session.create();

  // Mock LLM source with usage tracking
  const llmSource = Source.llm()
    .mock()
    .mockResponses(
      {
        content: 'Hello! How can I help you today?',
        usage: {
          promptTokens: 10,
          completionTokens: 8,
          totalTokens: 18,
          cost: 0.0001,
        },
      },
      {
        content: 'The capital of France is Paris.',
        usage: {
          promptTokens: 15,
          completionTokens: 7,
          totalTokens: 22,
          cost: 0.00012,
        },
      },
    );

  const assistant = new Assistant(llmSource);

  // First conversation turn
  session = session.addMessage({
    type: 'user',
    content: 'Hello',
  });
  session = await assistant.execute(session);

  // Second conversation turn
  session = session.addMessage({
    type: 'user',
    content: 'What is the capital of France?',
  });
  session = await assistant.execute(session);

  console.log('Session usage before save:');
  console.log(`  Total price: $${session.usage.totalPrice.toFixed(6)}`);
  console.log(`  Total tokens: ${session.usage.totalTokens}`);
  console.log(`  API calls: ${session.usage.callCount}`);

  // Save session with metadata
  const sessionId = await persistence.save(session, undefined, {
    userId: 'user_123',
    conversationTopic: 'General questions',
  });
  console.log(`\nSession saved with ID: ${sessionId}`);

  // Load session back
  const loadedSession = await persistence.load(sessionId);
  if (loadedSession) {
    console.log('\nSession loaded successfully:');
    console.log(`  Total price: $${loadedSession.usage.totalPrice.toFixed(6)}`);
    console.log(`  Total tokens: ${loadedSession.usage.totalTokens}`);
    console.log(`  API calls: ${loadedSession.usage.callCount}`);
    console.log(`  Messages: ${loadedSession.messages.length}`);
  }

  // List all sessions
  const allSessions = await persistence.list();
  console.log(`\nTotal sessions in storage: ${allSessions.length}`);

  // Get metadata without loading full session
  const metadata = await persistence.getMetadata(sessionId);
  if (metadata) {
    console.log('\nSession metadata:');
    console.log(`  Created at: ${metadata.createdAt}`);
    console.log(`  Updated at: ${metadata.updatedAt}`);
    console.log(`  User metadata:`, metadata.metadata);
  }
}

/**
 * Example 2: JSON file persistence (Node.js)
 */
async function example2_JSONFile() {
  console.log('\n=== Example 2: JSON File Persistence ===\n');

  // Create persistence manager with file storage
  const persistence = createJSONFilePersistence('./sessions.json');

  // Create a session
  let session = Session.create();

  const llmSource = Source.llm()
    .mock()
    .mockResponse({
      content: 'The weather is sunny today.',
      usage: {
        promptTokens: 12,
        completionTokens: 6,
        totalTokens: 18,
        cost: 0.0001,
      },
    });

  const assistant = new Assistant(llmSource);

  session = session.addMessage({
    type: 'user',
    content: 'What is the weather?',
  });
  session = await assistant.execute(session);

  // Save to file
  const sessionId = await persistence.save(session, 'weather_conversation');
  console.log(`Session saved to file with ID: ${sessionId}`);
  console.log(`Total price: $${session.usage.totalPrice.toFixed(6)}`);

  // Load from file
  const loadedSession = await persistence.load(sessionId);
  if (loadedSession) {
    console.log('\nSession loaded from file:');
    console.log(`  Messages: ${loadedSession.messages.length}`);
    console.log(`  Total price: $${loadedSession.usage.totalPrice.toFixed(6)}`);
  }
}

/**
 * Example 3: Custom database adapter (PostgreSQL example)
 */
class PostgresAdapter {
  // Implement PersistenceAdapter interface
  async save(session: any, sessionId?: string): Promise<string> {
    // Example SQL:
    // INSERT INTO sessions (id, messages, vars, usage, metadata, updated_at)
    // VALUES ($1, $2, $3, $4, $5, $6)
    // ON CONFLICT (id) DO UPDATE SET ...
    console.log('Saving to PostgreSQL...');
    return sessionId || 'generated_id';
  }

  async load(sessionId: string): Promise<any | null> {
    // Example SQL:
    // SELECT * FROM sessions WHERE id = $1
    console.log('Loading from PostgreSQL...');
    return null;
  }

  async delete(sessionId: string): Promise<void> {
    // Example SQL:
    // DELETE FROM sessions WHERE id = $1
    console.log('Deleting from PostgreSQL...');
  }

  async list(): Promise<string[]> {
    // Example SQL:
    // SELECT id FROM sessions ORDER BY updated_at DESC
    console.log('Listing from PostgreSQL...');
    return [];
  }
}

/**
 * Example 4: Usage tracking across multiple sessions
 */
async function example4_UsageAggregation() {
  console.log('\n=== Example 4: Usage Aggregation ===\n');

  const persistence = createInMemoryPersistence();

  // Simulate multiple conversations with different costs
  const conversations = [
    { name: 'Support Chat', cost: 0.0015, tokens: 150 },
    { name: 'Sales Chat', cost: 0.0032, tokens: 320 },
    { name: 'General Query', cost: 0.0008, tokens: 80 },
  ];

  const sessionIds: string[] = [];

  for (const conv of conversations) {
    let session = Session.create();
    const llmSource = Source.llm()
      .mock()
      .mockResponse({
        content: `Response for ${conv.name}`,
        usage: {
          totalTokens: conv.tokens,
          cost: conv.cost,
        },
      });

    const assistant = new Assistant(llmSource);
    session = session.addMessage({ type: 'user', content: conv.name });
    session = await assistant.execute(session);

    const id = await persistence.save(session, undefined, { name: conv.name });
    sessionIds.push(id);
  }

  // Calculate total usage across all sessions
  let totalCost = 0;
  let totalTokens = 0;
  let totalCalls = 0;

  for (const id of sessionIds) {
    const metadata = await persistence.getMetadata(id);
    if (metadata) {
      totalCost += metadata.usage.totalPrice;
      totalTokens += metadata.usage.totalTokens;
      totalCalls += metadata.usage.callCount;
    }
  }

  console.log('Aggregated usage across all sessions:');
  console.log(`  Total sessions: ${sessionIds.length}`);
  console.log(`  Total cost: $${totalCost.toFixed(6)}`);
  console.log(`  Total tokens: ${totalTokens}`);
  console.log(`  Total API calls: ${totalCalls}`);
}

/**
 * Example 5: Resume conversation from database
 */
async function example5_ResumeConversation() {
  console.log('\n=== Example 5: Resume Conversation ===\n');

  const persistence = createInMemoryPersistence();

  // Start a conversation
  let session = Session.create();
  const llmSource = Source.llm()
    .mock()
    .mockResponses(
      {
        content: 'The capital is Paris.',
        usage: { totalTokens: 20, cost: 0.0001 },
      },
      {
        content: 'The population is about 2.2 million.',
        usage: { totalTokens: 25, cost: 0.00012 },
      },
    );

  const assistant = new Assistant(llmSource);

  session = session.addMessage({
    type: 'user',
    content: 'What is the capital of France?',
  });
  session = await assistant.execute(session);

  // Save the session
  const sessionId = await persistence.save(session);
  console.log('Initial conversation saved.');
  console.log(`Current cost: $${session.usage.totalPrice.toFixed(6)}`);

  // Later... resume the conversation
  let resumedSession = await persistence.load(sessionId);
  if (resumedSession) {
    console.log('\nResuming conversation...');
    console.log(
      `Loaded session with ${resumedSession.messages.length} messages`,
    );
    console.log(
      `Previous cost: $${resumedSession.usage.totalPrice.toFixed(6)}`,
    );

    // Continue the conversation
    resumedSession = resumedSession.addMessage({
      type: 'user',
      content: 'What is the population?',
    });
    resumedSession = await assistant.execute(resumedSession);

    // Save updated session
    await persistence.save(resumedSession, sessionId);

    console.log(`\nUpdated conversation:`);
    console.log(`  Messages: ${resumedSession.messages.length}`);
    console.log(
      `  Total cost: $${resumedSession.usage.totalPrice.toFixed(6)}`,
    );
    console.log(`  API calls: ${resumedSession.usage.callCount}`);
  }
}

// Run all examples
async function main() {
  await example1_InMemory();
  await example2_JSONFile();
  await example4_UsageAggregation();
  await example5_ResumeConversation();
}

main().catch(console.error);
