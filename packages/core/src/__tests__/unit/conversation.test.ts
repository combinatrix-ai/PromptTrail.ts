import { describe, expect, it } from 'vitest';
import {
  createConversationHistoryFingerprint,
  deriveConversationBinding,
  deriveConversationBindingFromMessage,
  getMessagesAfterBinding,
} from '../../conversation';
import { Session } from '../../session';

describe('ConversationBinding helpers', () => {
  it('derives provider bindings from assistant attrs', () => {
    expect(
      deriveConversationBindingFromMessage(
        {
          type: 'assistant',
          content: 'ok',
          attrs: { openai: { responseId: 'resp-1' } },
        },
        3,
      ),
    ).toEqual({ provider: 'openai', id: 'resp-1', messageIndex: 3 });

    expect(
      deriveConversationBindingFromMessage({
        type: 'assistant',
        content: 'ok',
        attrs: { codex: { threadId: 'thread-1' } },
      }),
    ).toEqual({ provider: 'codex', id: 'thread-1', messageIndex: -1 });

    expect(
      deriveConversationBindingFromMessage(
        {
          type: 'assistant',
          content: 'ok',
          attrs: {
            google: {
              cachedContent: 'cachedContents/prefix',
              cachedContentBinding: {
                id: 'cachedContents/prefix',
                messageIndex: 1,
              },
            },
          },
        },
        4,
      ),
    ).toEqual({
      provider: 'google',
      id: 'cachedContents/prefix',
      messageIndex: 1,
    });
  });

  it('derives the last matching binding from a session without session state', () => {
    const session = Session.create()
      .addMessage({ type: 'user', content: 'one' })
      .addMessage({
        type: 'assistant',
        content: 'two',
        attrs: { openai: { responseId: 'resp-1' } },
      })
      .addMessage({ type: 'user', content: 'three' });

    const binding = deriveConversationBinding(session, 'openai');
    expect(binding).toEqual({
      provider: 'openai',
      id: 'resp-1',
      messageIndex: 1,
    });
    expect(
      getMessagesAfterBinding(session, binding).map(
        (message) => message.content,
      ),
    ).toEqual(['three']);
  });

  it('drops provider bindings when the canonical prefix diverged', () => {
    const assistant = {
      type: 'assistant' as const,
      content: 'two',
    };
    const historyFingerprint = createConversationHistoryFingerprint([
      { type: 'user', content: 'one' },
      assistant,
    ]);
    const session = Session.create()
      .addMessage({ type: 'user', content: 'edited' })
      .addMessage({
        ...assistant,
        attrs: {
          openai: {
            responseId: 'resp-1',
            historyFingerprint,
          },
        },
      })
      .addMessage({ type: 'user', content: 'three' });

    expect(deriveConversationBinding(session, 'openai')).toBeUndefined();
    expect(
      deriveConversationBinding(
        Session.create()
          .addMessage({ type: 'user', content: 'one' })
          .addMessage({
            ...assistant,
            attrs: {
              openai: {
                responseId: 'resp-1',
                historyFingerprint,
              },
            },
          })
          .addMessage({ type: 'user', content: 'three' }),
        'openai',
      ),
    ).toEqual({
      provider: 'openai',
      id: 'resp-1',
      messageIndex: 1,
    });
  });
});
