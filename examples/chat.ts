import {
  LinearTemplate,
  LoopTemplate,
  UserTemplate,
  AssistantTemplate,
  createSession,
  createGenerateOptions,
} from '../packages/core/src/index';
import { CLIInputSource } from '../packages/core/src/input_source';
import type { Session } from '../packages/core/src/session';
import type { Message } from '../packages/core/src/types';
import type { Metadata } from '../packages/core/src/metadata';

// Wrapper session that logs messages
class LoggingSession<T extends Record<string, unknown>> implements Session<T> {
  constructor(private session: Session<T>) {}

  get messages(): readonly Message[] {
    return this.session.messages;
  }

  get metadata(): Metadata<T> {
    return this.session.metadata;
  }

  get print(): boolean {
    return true; // LoggingSession always prints
  }

  addMessage(message: Message): Session<T> {
    // Create new session with the message
    return new LoggingSession(this.session.addMessage(message));
  }

  updateMetadata<U extends Record<string, unknown>>(
    metadata: U,
  ): Session<T & U> {
    return new LoggingSession(this.session.updateMetadata(metadata));
  }

  getLastMessage(): Message | undefined {
    return this.session.getLastMessage();
  }

  getMessagesByType<U extends Message['type']>(
    type: U,
  ): Extract<Message, { type: U }>[] {
    return this.session.getMessagesByType(type);
  }

  validate(): void {
    this.session.validate();
  }

  toJSON(): Record<string, unknown> {
    return this.session.toJSON();
  }
}

// Helper function to create a logging session
function createLoggingSession<
  T extends Record<string, unknown> = Record<string, unknown>,
>(
  options: {
    messages?: Message[];
    metadata?: T;
  } = {},
): Session<T> {
  return new LoggingSession(createSession<T>({ ...options, print: true }));
}

// Get API key from environment variable
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error('OPENAI_API_KEY environment variable is required');
}

async function main() {
  // Create input source for CLI interaction
  const inputSource = new CLIInputSource();

  try {
    // Create generateOptions for OpenAI
    const generateOptions = createGenerateOptions({
      provider: {
        type: 'openai',
        apiKey: apiKey as string, // We've checked it's not undefined above
        modelName: 'gpt-4o-mini',
      },
      temperature: 0.7,
    });

    // Create user template with validation
    const userTemplate = new UserTemplate({
      description: 'Your message (type "exit" to end):',
      inputSource,
      validate: async (input: string) => {
        const trimmedInput = input.trim();
        if (!trimmedInput) {
          console.log(
            '\nPlease enter a message or type "exit" to end the chat.',
          );
          return false;
        }
        return true;
      },
      onInput: async () => {
        // Clear the line to avoid duplicate prompts
        process.stdout.write('\x1B[1A\x1B[2K');
      },
    });

    // Create conversation template
    const template = new LinearTemplate()
      .addSystem(
        'You are a helpful AI assistant. Be concise and friendly in your responses.',
      )
      .addLoop(
        new LoopTemplate({
          templates: [userTemplate, new AssistantTemplate({ generateOptions })],
          exitCondition: (session) => {
            const lastUserMessage = session
              .getMessagesByType('user')
              .slice(-1)[0];
            return lastUserMessage?.content.toLowerCase().trim() === 'exit';
          },
        }),
      );

    // Create initial session with logging
    const session = createLoggingSession();

    // Execute the template
    console.log('\nStarting chat with GPT-4o-mini (type "exit" to end)...\n');
    await template.execute(session);
    console.log('\nChat ended. Goodbye!\n');
  } finally {
    // Clean up resources
    inputSource.close();
  }
}

// Start the chat
main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
