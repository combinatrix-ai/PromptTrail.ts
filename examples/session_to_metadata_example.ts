// NOTE: This is a proposed implementation example for the Session to Metadata conversion feature.
// The interfaces and functions defined here would need to be added to the core library.
//
// IMPORTANT: This file is for documentation purposes only and is not meant to be compiled or run as-is.
// It contains TypeScript errors because it references proposed APIs that don't exist yet.
// The purpose is to demonstrate how the Session to Metadata conversion feature would work
// once implemented in the core library.

// Import types from the core library
// In a real implementation, these would be properly imported
import type { LinearTemplate, OpenAIModel, Session } from '@prompttrail/core';

// Mock function to avoid TypeScript errors
const createSession = () => ({}) as any;

// These types would be defined in the core library
export type MessageRole =
  | 'system'
  | 'user'
  | 'assistant'
  | 'tool_result'
  | 'control';

/**
 * Session transformer interface - would be added to core
 */
export interface SessionTransformer<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
> {
  transform(
    session: Session<TInput>,
  ): Promise<Session<TOutput>> | Session<TOutput>;
}

/**
 * Create a transformer from a function - would be added to core
 */
export function createTransformer<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput extends Record<string, unknown> = TInput,
>(
  transformFn: (
    session: Session<TInput>,
  ) => Promise<Session<TOutput>> | Session<TOutput>,
): SessionTransformer<TInput, TOutput> {
  return {
    transform: (session) => transformFn(session),
  };
}

// This method would be added to LinearTemplate
declare module '@prompttrail/core' {
  interface LinearTemplate {
    addTransformer<U extends Record<string, unknown>>(
      transformer: SessionTransformer<Record<string, unknown>, U>,
    ): this;
  }
}

/**
 * Example implementation of the markdown extractor
 */
interface MarkdownExtractorOptions<T extends Record<string, unknown>> {
  messageTypes?: MessageRole[];
  headingMap?: Record<string, keyof T>;
  codeBlockMap?: Record<string, keyof T>;
}

/**
 * Create a markdown extractor transformer
 */
function extractMarkdown<T extends Record<string, unknown>>(
  options: MarkdownExtractorOptions<T>,
): SessionTransformer<Record<string, unknown>, Record<string, unknown> & T> {
  return createTransformer((session: Session<Record<string, unknown>>) => {
    const messageTypes = options.messageTypes || ['assistant'];

    // Get relevant messages
    const messages = session.messages.filter((msg) =>
      messageTypes.includes(msg.type as MessageRole),
    );

    let updatedSession = session;

    for (const message of messages) {
      // Extract headings and their content
      if (options.headingMap) {
        const headingPattern = /##\s+([^\n]+)\n([\s\S]*?)(?=\n##\s+|$)/g;
        let match;
        while ((match = headingPattern.exec(message.content)) !== null) {
          const [, heading, content] = match;
          const trimmedHeading = heading.trim();

          if (options.headingMap[trimmedHeading]) {
            const key = options.headingMap[trimmedHeading] as keyof T;
            updatedSession = updatedSession.updateMetadata({
              [key]: content.trim(),
            } as unknown as Partial<T>);
          }
        }
      }

      // Extract code blocks
      if (options.codeBlockMap) {
        const codeBlockPattern = /```(\w+)\n([\s\S]*?)```/g;
        let match;
        while ((match = codeBlockPattern.exec(message.content)) !== null) {
          const [, language, code] = match;

          if (options.codeBlockMap[language]) {
            const key = options.codeBlockMap[language] as keyof T;
            updatedSession = updatedSession.updateMetadata({
              [key]: code.trim(),
            } as unknown as Partial<T>);
          }
        }
      }
    }

    return updatedSession;
  });
}

/**
 * Example: Code generation with extraction
 *
 * NOTE: This is a conceptual example showing how the API would work
 * once implemented in the core library.
 */
async function codeGenerationExample() {
  // Initialize model with your API key
  const model = new OpenAIModel({
    apiKey: process.env.OPENAI_API_KEY || 'your-api-key',
    modelName: 'gpt-4o-mini',
    temperature: 0.7, // Required by OpenAIConfig
  });

  // Create a template that generates code and explanation
  // NOTE: addTransformer would be added to LinearTemplate in the core library
  const codeTemplate = new LinearTemplate()
    .addSystem(
      "You're a TypeScript expert. Always include code examples in ```typescript blocks and use ## headings for sections.",
    )
    .addUser(
      'Write a function to calculate the factorial of a number with explanation.',
    )
    .addAssistant({ model: model })
    // This is how the API would look once implemented:
    .addTransformer(
      extractMarkdown({
        headingMap: {
          Explanation: 'explanation',
          'Usage Example': 'usageExample',
        },
        codeBlockMap: { typescript: 'code' },
      }),
    );

  // Note: In a real implementation, this would be properly typed

  // Execute the template
  console.log('Generating code and extracting structured data...');
  const session = await codeTemplate.execute(createSession());

  // Access the extracted data
  console.log('\n--- EXTRACTED CODE ---');
  console.log(session.metadata.get('code'));

  console.log('\n--- EXTRACTED EXPLANATION ---');
  console.log(session.metadata.get('explanation'));

  console.log('\n--- EXTRACTED USAGE EXAMPLE ---');
  console.log(session.metadata.get('usageExample'));

  return session;
}

/**
 * Example: Technical analysis with extraction
 *
 * NOTE: This is a conceptual example showing how the API would work
 * once implemented in the core library.
 */
async function technicalAnalysisExample() {
  // Initialize model with your API key
  const model = new OpenAIModel({
    apiKey: process.env.OPENAI_API_KEY || 'your-api-key',
    modelName: 'gpt-4o-mini',
    temperature: 0.7, // Required by OpenAIConfig
  });

  // Sample code to analyze
  const codeToAnalyze = `
function quickSort(arr: number[]): number[] {
  if (arr.length <= 1) return arr;
  
  const pivot = arr[0];
  const left = arr.slice(1).filter(x => x < pivot);
  const right = arr.slice(1).filter(x => x >= pivot);
  
  return [...quickSort(left), pivot, ...quickSort(right)];
}
  `;

  // Create a template that analyzes code
  // NOTE: addTransformer would be added to LinearTemplate in the core library
  const analysisTemplate = new LinearTemplate()
    .addSystem(
      "You're a code reviewer. Organize your analysis with ## headings for Summary, Strengths, Weaknesses, and Suggestions.",
    )
    .addUser(
      `Analyze this TypeScript code:\n\`\`\`typescript\n${codeToAnalyze}\n\`\`\``,
    )
    .addAssistant({ model: model })
    // This is how the API would look once implemented:
    .addTransformer(
      extractMarkdown({
        headingMap: {
          Summary: 'summary',
          Strengths: 'strengths',
          Weaknesses: 'weaknesses',
          Suggestions: 'suggestions',
        },
      }),
    );

  // Note: In a real implementation, this would be properly typed

  // Execute the template
  console.log('Analyzing code and extracting structured feedback...');
  const session = await analysisTemplate.execute(createSession());

  // Access the extracted data
  console.log('\n--- ANALYSIS SUMMARY ---');
  console.log(session.metadata.get('summary'));

  console.log('\n--- STRENGTHS ---');
  console.log(session.metadata.get('strengths'));

  console.log('\n--- WEAKNESSES ---');
  console.log(session.metadata.get('weaknesses'));

  console.log('\n--- SUGGESTIONS ---');
  console.log(session.metadata.get('suggestions'));

  return session;
}

/**
 * Run the examples
 *
 * NOTE: This function is for demonstration purposes only.
 * The actual implementation would require the Session to Metadata
 * conversion feature to be added to the core library.
 */
async function main() {
  console.log(
    'NOTE: This is a conceptual example of the Session to Metadata conversion feature.',
  );
  console.log(
    'The actual implementation would require adding the feature to the core library.',
  );
  console.log(
    'This file demonstrates the proposed API design and usage patterns.',
  );

  try {
    // These would work once the feature is implemented
    console.log('\nExample code for code generation with extraction:');
    console.log('await codeGenerationExample();');

    console.log('\nExample code for technical analysis with extraction:');
    console.log('await technicalAnalysisExample();');
  } catch (error) {
    console.error('Error running examples:', error);
  }
}

// Run the examples if this file is executed directly
if (require.main === module) {
  main();
}

export { extractMarkdown, codeGenerationExample, technicalAnalysisExample };
