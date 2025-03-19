import {
  createSession,
  LinearTemplate,
  AssistantTemplate,
  GuardrailTemplate,
  ModelValidator,
  ToxicLanguageValidator,
  CompetitorCheckValidator,
  OnFailAction,
  OpenAIModel,
} from '../packages/core/src';

/**
 * This example demonstrates how to use model-based validators with GuardrailTemplate
 * to ensure that LLM responses meet specific quality criteria.
 */
async function main() {
  // Create OpenAI models for generation and validation
  const apiKey = process.env.OPENAI_API_KEY || 'your-api-key-here';

  const generationModel = new OpenAIModel({
    modelName: 'gpt-4o-mini',
    temperature: 0.7,
    apiKey,
  });

  const validationModel = new OpenAIModel({
    modelName: 'gpt-4o-mini',
    temperature: 0.1, // Lower temperature for more consistent validation
    apiKey,
  });

  // Create model-based validators
  const validators = [
    // General quality validator
    new ModelValidator({
      model: validationModel,
      prompt: `
        Evaluate the following product description for quality, accuracy, and professionalism.
        
        Text to evaluate:
        "{text}"
        
        Rate on a scale from 0.0 to 1.0, where:
        - 0.0 means poor quality (unprofessional, inaccurate, or poorly written)
        - 1.0 means excellent quality (professional, accurate, and well-written)
        
        Consider these factors:
        - Clarity and conciseness
        - Professional tone
        - Grammatical correctness
        - Factual accuracy
        - Marketing effectiveness
        
        Format your response as:
        Score: [number between 0.0 and 1.0]
        Feedback: [explanation of the score]
      `,
      scoreThreshold: 0.7,
    }),

    // Toxic language check
    new ToxicLanguageValidator({
      model: validationModel,
      threshold: 0.3,
      validationMethod: 'sentence',
    }),

    // Competitor check
    new CompetitorCheckValidator({
      model: validationModel,
      competitors: ['Apple', 'Microsoft', 'Google', 'Amazon', 'Meta'],
    }),
  ];

  // Create a guardrail template
  const guardrailTemplate = new GuardrailTemplate({
    template: new AssistantTemplate({ model: generationModel }),
    validators,
    onFail: OnFailAction.RETRY,
    maxAttempts: 3,
    onRejection: (result, content, attempt) => {
      console.log(`\nAttempt ${attempt} rejected:`);
      console.log(`Content: ${content.substring(0, 100)}...`);
      console.log(`Reason: ${result.feedback}`);
    },
  });

  // Create a template for product description
  const productTemplate = new LinearTemplate()
    .addSystem(
      `
      You are a professional product description writer.
      Create compelling, accurate, and professional product descriptions.
      Focus on benefits, features, and unique selling points.
      Use a professional tone and avoid mentioning competitors.
    `,
    )
    .addUser(
      "Write a product description for a new smartphone called 'Quantum X' with advanced AI features, a 6.7-inch display, and 48-hour battery life.",
      '',
    );

  // Execute the templates in sequence
  console.log('Generating product description with guardrails...');
  let session = createSession();
  session = await productTemplate.execute(session);
  session = await guardrailTemplate.execute(session);

  // Get the final response
  const response = session.getLastMessage();
  console.log('\nFinal product description:');
  console.log(response?.content);

  // Get guardrail metadata
  const guardrailInfo = session.metadata.get('guardrail') as
    | {
        attempt: number;
        passed: boolean;
        validationResults: Array<{
          passed: boolean;
          score?: number;
          feedback?: string;
        }>;
      }
    | undefined;

  if (guardrailInfo) {
    console.log('\nGuardrail info:');
    console.log(`- Attempts: ${guardrailInfo.attempt}`);
    console.log(`- Passed: ${guardrailInfo.passed}`);

    // Show validation scores if available
    if (guardrailInfo.validationResults) {
      console.log('\nValidation scores:');
      guardrailInfo.validationResults.forEach((result, index: number) => {
        console.log(
          `- Validator ${index + 1}: ${result.passed ? 'PASSED' : 'FAILED'} ${result.score ? `(Score: ${result.score})` : ''}`,
        );
      });
    }
  } else {
    console.log('\nNo guardrail metadata available');
  }
}

main().catch(console.error);
