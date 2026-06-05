import { describe, expect, it } from 'vitest';
import { Agent } from '../../../templates';
import { Message } from '../../../message';
import { Session } from '../../../session';

describe('GenerateMessages template', () => {
  it('should append multiple generated messages', async () => {
    const agent = Agent.create().messages(async () => [
      Message.system('Generated system'),
      Message.assistant('Generated assistant'),
    ]);

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
    const agent = Agent.create()
      .user('Question')
      .messages((session) => [
        Message.assistant(`Saw ${session.messages.length} message`),
      ]);

    const session = await agent.execute(Session.create());

    expect(session.getLastMessage()?.content).toBe('Saw 1 message');
  });
});
