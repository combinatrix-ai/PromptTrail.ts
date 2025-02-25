import {
  LinearTemplate,
  UserTemplate,
  AssistantTemplate,
  LoopTemplate,
} from '@prompttrail/core';

// Create a simple chat template
const chatTemplate = new LinearTemplate()
  .addSystem(
    'You are a helpful AI assistant. Be concise and friendly in your responses.',
  )
  .addLoop(
    new LoopTemplate({
      templates: [
        new UserTemplate({
          description: 'Your message (type "exit" to end):',
          default: '',
        }),
        new AssistantTemplate({ model: 'gpt-4o-mini' }),
      ],
      exitCondition: (session) => {
        const lastUserMessage = session.getMessagesByType('user').slice(-1)[0];
        return lastUserMessage?.content.toLowerCase().trim() === 'exit';
      },
    }),
  );

export default chatTemplate;
