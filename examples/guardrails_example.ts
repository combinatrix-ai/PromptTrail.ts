import {
  createSession,
  LinearTemplate,
  AssistantTemplate,
  GuardrailTemplate,
  RegexMatchValidator,
  KeywordValidator,
  LengthValidator,
  AllValidator,
  OnFailAction,
  OpenAIModel
} from '../packages/core/src';

/**
 * This example demonstrates how to use GuardrailTemplate to ensure
 * that LLM responses meet specific quality criteria.
 */
async function main() {
  // Create an OpenAI model instance
  const model = new OpenAIModel({
    modelName: 'gpt-4o-mini',
    temperature: 0.7,
    apiKey: process.env.OPENAI_API_KEY || 'your-api-key-here',
  });

  // Create a template that asks for a pet name
  // (We'll use this structure later)

  // Create validators to ensure the response meets our criteria
  const validators = [
    // Ensure the name is a single word
    new RegexMatchValidator({
      regex: /^[A-Za-z]+$/,
      description: "Pet name must be a single word with only letters"
    }),
    
    // Ensure the name is between 3 and 10 characters
    new LengthValidator({
      min: 3,
      max: 10,
      description: "Pet name must be between 3 and 10 characters"
    }),
    
    // Ensure the name doesn't contain inappropriate words
    new KeywordValidator({
      keywords: ['inappropriate', 'offensive', 'rude', 'vulgar'],
      mode: 'exclude',
      description: "Pet name must not be inappropriate"
    })
  ];

  // Combine all validators with AND logic
  const combinedValidator = new AllValidator(validators);

  // Create a guardrail template
  const guardrailTemplate = new GuardrailTemplate({
    template: new AssistantTemplate({ model }),
    validators: [combinedValidator],
    onFail: OnFailAction.RETRY,
    maxAttempts: 3,
    onRejection: (result, content, attempt) => {
      console.log(`Attempt ${attempt} rejected: ${content}`);
      console.log(`Reason: ${result.feedback}`);
    }
  });

  // Create a new template with system and user messages
  const systemTemplate = new LinearTemplate()
    .addSystem("You are a helpful assistant that suggests pet names.")
    .addUser("Suggest a name for a pet cat.", "");

  // Note: In a future version, it would be nice to have an addTemplate method
  // on LinearTemplate to make this more elegant

  // Execute the templates in sequence
  let session = createSession();
  session = await systemTemplate.execute(session);
  
  // Execute the guardrail template directly
  session = await guardrailTemplate.execute(session);

  // Get the final response
  const response = session.getLastMessage();
  console.log("Final pet name:", response?.content);

  // Get guardrail metadata
  const guardrailInfo = session.metadata.get('guardrail');
  console.log("Guardrail info:", guardrailInfo);
}

main().catch(console.error);
