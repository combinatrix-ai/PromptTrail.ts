/**
 * Backward Compatibility Demo
 *
 * This example shows that both the old Source API and new direct API
 * work side by side for maximum flexibility.
 */

import { Agent, Session, Source, Validation } from '../packages/core/src/index';

async function main() {
  console.log('🔄 PromptTrail Backward Compatibility Demo\n');

  // 1. Old Source API still works (for power users who need advanced customization)
  console.log('1. Using the old Source API (still available):');
  const oldStyleAgent = Agent.create()
    .system('You are a helpful assistant.')
    .user(Source.literal('What is the Source abstraction?'))
    .assistant(
      Source.llm()
        .openai()
        .model('gpt-4o-mini')
        .temperature(0.7)
        .validate(Validation.length({ max: 200 }))
        .withMaxAttempts(2),
    );

  await oldStyleAgent.execute(Session.debug());
  console.log('\n---\n');

  // 2. New direct API (recommended for most users)
  console.log('2. Using the new direct API (recommended):');
  const newStyleAgent = Agent.create()
    .system('You are a helpful assistant.')
    .user('What is the new direct API?')
    .assistant(
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        temperature: 0.7,
      },
      {
        validation: Validation.length({ max: 200 }),
        maxAttempts: 2,
      },
    );

  await newStyleAgent.execute(Session.debug());
  console.log('\n---\n');

  // 3. Mixed usage in the same agent
  console.log(
    '3. Mixed usage - Source API for advanced features, direct API for simplicity:',
  );
  const mixedAgent = Agent.create()
    .system('You are comparing different APIs.')

    // Use Source for advanced middleware/customization
    .user(Source.literal('Compare these two approaches:'))

    // Use direct API for simple configuration
    .assistant({ provider: 'openai', temperature: 0.3 })

    // Use Source with complex validation logic
    .user(
      Source.callback(async ({ context }) => {
        // Note: context contains session vars, not full session
        return `Can you elaborate on your previous response?`;
      }).validate(Validation.length({ min: 10 })),
    )

    // Use direct API with simple validation
    .assistant(
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
      },
      {
        validation: Validation.keyword(['elaborate', 'explain'], {
          mode: 'include',
        }),
      },
    );

  await mixedAgent.execute(Session.debug());
  console.log('\n---\n');

  // 4. Source API with advanced middleware (power user features)
  console.log('4. Source API with advanced middleware (power user features):');
  const advancedSource = Source.llm().openai().model('gpt-4o-mini');

  const advancedAgent = Agent.create()
    .system('You are demonstrating advanced features.')
    .user('Show me advanced Source capabilities.')
    .assistant(advancedSource);

  await advancedAgent.execute(Session.debug());

  console.log('\n✅ Demo complete! Key takeaways:');
  console.log('- 🆕 Direct API: Simple, intuitive, recommended for most users');
  console.log(
    '- ⚡ Source API: Advanced customization, middleware, power users',
  );
  console.log('- 🔄 Both work together: Mix and match as needed');
  console.log(
    '- 📈 Gradual migration: No breaking changes, migrate at your pace',
  );
}

main().catch(console.error);
