import { Agent, Parallel, Session, Source } from '@prompttrail/core';

async function demoBasicParallel() {
  console.log('=== Basic Parallel Template ===');

  // Create a parallel template that uses multiple LLM sources
  // and automatically selects the best response
  const parallel = new Parallel()
    .withSource(
      Source.llm().openai('gpt-4.1-mini').dangerouslyAllowBrowser(), // For demo purposes only
      1,
    )
    .withSource(
      Source.llm()
        .anthropic('claude-3-5-haiku-20241022')
        .dangerouslyAllowBrowser(), // For demo purposes only
      1,
    )
    .withStrategy('best'); // Uses built-in LangChain-style scoring

  // Create an agent that uses the parallel template
  const agent = Agent.create()
    .system('You are a helpful AI assistant.')
    .user('Explain the concept of recursion in programming.')
    .then(parallel); // Execute multiple models in parallel

  const session = await agent.execute(Session.create());
  console.log('Selected best response:', session.getLastMessage()?.content);
}

async function demoDirectParallel() {
  console.log('\n=== Direct Parallel Template ===');

  // Using direct instantiation
  const parallel = new Parallel()
    .withSource(Source.llm().openai('gpt-4.1-mini').dangerouslyAllowBrowser())
    .withSource(
      Source.llm()
        .anthropic('claude-3-5-haiku-20241022')
        .dangerouslyAllowBrowser(),
      2,
    )
    .withStrategy('best');

  const agent = Agent.create()
    .system('You are a programming tutor.')
    .user('What are the key benefits of using TypeScript?')
    .then(parallel);

  const session = await agent.execute(Session.create());
  console.log('Direct result:', session.getLastMessage()?.content);
}

async function demoAgentIntegratedParallel() {
  console.log('\n=== Agent-integrated Function-based Parallel ===');

  // Using Agent's parallel method with builder function
  const agent = Agent.create()
    .system('You are a helpful AI assistant.')
    .user('Compare the advantages of microservices vs monolithic architecture.')
    .parallel(
      (p) =>
        p
          .withSource(
            Source.llm().openai('gpt-4.1-mini').dangerouslyAllowBrowser(),
          )
          .withSource(
            Source.llm()
              .anthropic('claude-3-5-haiku-20241022')
              .dangerouslyAllowBrowser(),
          )
          .withStrategy('best'), // Automatic LangChain-style scoring
    );

  const session = await agent.execute(Session.create());
  console.log('Agent-integrated result:', session.getLastMessage()?.content);
}

async function main() {
  try {
    await demoBasicParallel();
    await demoDirectParallel();
    await demoAgentIntegratedParallel();
  } catch (error) {
    console.error('Demo error:', error);
  }

  // Show the evaluation prompt that would be used
  // (In a real implementation, this would be sent to an LLM)
  console.log('\n--- LangChain-style Evaluation Prompt Example ---');
  console.log(`
You are an expert evaluator of AI responses. Your task is to analyze and rank the following responses based on their quality, relevance, completeness, and accuracy.

Context:
System Context: You are a helpful AI assistant.
User Query: Explain the concept of recursion in programming.

Responses to evaluate:
--- Response 1 ---
[Response from OpenAI GPT-4.1 Mini]

--- Response 2 ---
[Response from Anthropic Claude 3.5 Haiku]

Please evaluate these responses based on the following criteria:
1. Relevance to the user's query
2. Accuracy and correctness
3. Completeness of the answer
4. Clarity and coherence
5. Helpfulness and practical value

Return only the number (1-based index) of the best response.
  `);
}

// Run the example
if (import.meta.main) {
  main().catch(console.error);
}
