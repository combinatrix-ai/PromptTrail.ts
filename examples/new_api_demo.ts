/**
 * New Direct API Demo
 *
 * This example showcases the new direct configuration API that replaced
 * the Source abstraction. Much simpler and more intuitive!
 */

import { Agent, Session, Validation } from '../packages/core/src/index';

async function main() {
  console.log('🚀 PromptTrail New Direct API Demo\n');

  // 1. Basic usage with defaults
  console.log('1. Basic conversation with defaults:');
  const basicAgent = Agent.create()
    .system('You are a helpful assistant.')
    .user('What is TypeScript?')
    .assistant(); // Uses OpenAI GPT-4o-mini by default

  await basicAgent.execute(Session.debug());
  console.log('\n---\n');

  // 2. Custom LLM configuration
  console.log('2. Custom LLM configuration:');
  const customAgent = Agent.create()
    .system('You are a creative writer.')
    .user('Write a haiku about coding.')
    .assistant({
      provider: 'openai',
      model: 'gpt-4',
      temperature: 0.9,
      maxTokens: 100,
    });

  await customAgent.execute(Session.debug());
  console.log('\n---\n');

  // 3. Different content types for User templates
  console.log('3. User template content types:');

  // CLI input (commented out to avoid blocking in demo)
  // .user({ cli: 'Enter your question: ' })

  // Array with cycling
  const arrayAgent = Agent.create()
    .system('Respond to each prompt differently.')
    .user(['Question 1', 'Question 2', 'Question 3'], { loop: true })
    .assistant()
    .user(['Follow-up A', 'Follow-up B'])
    .assistant();

  await arrayAgent.execute(Session.debug());
  console.log('\n---\n');

  // 4. Validation and retry
  console.log('4. Validation with automatic retry:');
  const validatedAgent = Agent.create()
    .system('Always include the word "TypeScript" in your response.')
    .user('Tell me about programming languages.')
    .assistant(
      {
        provider: 'openai',
      },
      {
        validation: Validation.keyword(['TypeScript'], { mode: 'include' }),
        maxAttempts: 3,
      },
    );

  await validatedAgent.execute(Session.debug());
  console.log('\n---\n');

  // 5. Multiple providers
  console.log('5. Different providers:');
  const multiProviderDemo = Agent.create()
    .system('You are knowledgeable about AI.')
    .user('Explain what makes a good language model.')
    .assistant({ provider: 'openai', model: 'gpt-4o-mini' })
    .user('What about training data?')
    .assistant({ provider: 'anthropic', model: 'claude-3-5-haiku-latest' });

  await multiProviderDemo.execute(Session.debug());
  console.log('\n---\n');

  // 6. Role flexibility
  console.log('6. Role flexibility:');
  const roleFlexAgent = Agent.create()
    .system('We are simulating a conversation between two AI assistants.')
    .user('Hello, I am Assistant A.', { role: 'assistant' })
    .assistant('Hello Assistant A, I am Assistant B.', { role: 'assistant' })
    .user('What do you think about this new direct API?', { role: 'user' })
    .assistant({ provider: 'openai' }, { role: 'assistant' });

  await roleFlexAgent.execute(Session.debug());
  console.log('\n---\n');

  // 7. Custom callback content
  console.log('7. Custom callback content:');
  const callbackAgent = Agent.create()
    .system('You will receive dynamically generated content.')
    .user(async (session) => {
      const timestamp = new Date().toLocaleTimeString();
      return `Current time is ${timestamp}. What time zone are you in?`;
    })
    .assistant(async (session) => {
      const userMessage = session.getLastMessage()?.content || '';
      return {
        content: `I received: "${userMessage}". I operate in UTC time zone.`,
        metadata: { generatedAt: Date.now() },
      };
    });

  await callbackAgent.execute(Session.debug());

  console.log('\n✅ Demo complete! Notice how much cleaner the new API is:');
  console.log('- No more Source imports');
  console.log('- Direct object configuration');
  console.log('- Better TypeScript support');
  console.log('- More flexible role assignment');
  console.log('- Built-in validation options');
}

main().catch(console.error);
