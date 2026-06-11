import { describe, expect, it } from 'vitest';
import { Agent } from '../../../templates';
import { Message } from '../../../message';
import { Session } from '../../../session';

describe('GenerateMessages template', () => {
  it('should append multiple generated messages', async () => {
    const agent = Agent.quick().transform((session) =>
      session
        .addMessage(Message.system('Generated system'))
        .addMessage(Message.assistant('Generated assistant')),
    );

    const session = await agent.execute();

    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toMatchObject({
      type: 'system',
      content: 'Generated system',
    });
    expect(session.messages[1]).toMatchObject({
      type: 'assistant',
      content: 'Generated assistant',
    });
  });

  it('should receive the current session', async () => {
    const agent = Agent.quick()
      .user('Question')
      .transform((session) =>
        session.addMessage(
          Message.assistant(`Saw ${session.messages.length} message`),
        ),
      );

    const session = await agent.execute({ session: Session.create() });

    expect(session.getLastMessage()?.content).toBe('Saw 1 message');
  });
});
