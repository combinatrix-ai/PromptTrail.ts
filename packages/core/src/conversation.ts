import type { Message } from './message';
import type { Session } from './session';

export type ConversationBindingProvider =
  | 'openai'
  | 'codex'
  | 'claude-agent'
  | 'google';

export interface ConversationBinding {
  provider: ConversationBindingProvider;
  id: string;
  messageIndex: number;
}

export function deriveConversationBinding(
  session: Session<any, any>,
  provider?: ConversationBindingProvider,
): ConversationBinding | undefined {
  for (let index = session.messages.length - 1; index >= 0; index--) {
    const message = session.messages[index];
    if (message.type !== 'assistant') {
      continue;
    }

    const binding = deriveConversationBindingFromMessage(message, index);
    if (binding && (!provider || binding.provider === provider)) {
      return binding;
    }
  }

  return undefined;
}

export function deriveConversationBindingFromMessage(
  message: Message<any>,
  messageIndex = -1,
): ConversationBinding | undefined {
  const attrs = message.attrs as Record<string, unknown> | undefined;
  const openai = attrs?.openai as Record<string, unknown> | undefined;
  if (typeof openai?.responseId === 'string') {
    return {
      provider: 'openai',
      id: openai.responseId,
      messageIndex,
    };
  }

  const codex = attrs?.codex as Record<string, unknown> | undefined;
  if (typeof codex?.threadId === 'string') {
    return {
      provider: 'codex',
      id: codex.threadId,
      messageIndex,
    };
  }

  const claudeAgent = attrs?.claudeAgent as Record<string, unknown> | undefined;
  if (typeof claudeAgent?.sessionId === 'string') {
    return {
      provider: 'claude-agent',
      id: claudeAgent.sessionId,
      messageIndex,
    };
  }

  const google = attrs?.google as Record<string, unknown> | undefined;
  const googleCachedContentBinding = google?.cachedContentBinding as
    | Record<string, unknown>
    | undefined;
  if (
    typeof googleCachedContentBinding?.id === 'string' &&
    typeof googleCachedContentBinding?.messageIndex === 'number'
  ) {
    return {
      provider: 'google',
      id: googleCachedContentBinding.id,
      messageIndex: googleCachedContentBinding.messageIndex,
    };
  }
  if (typeof google?.cachedContent === 'string') {
    return {
      provider: 'google',
      id: google.cachedContent,
      messageIndex,
    };
  }

  return undefined;
}

export function getMessagesAfterBinding(
  session: Session<any, any>,
  binding: ConversationBinding | undefined,
): readonly Message<any>[] {
  if (!binding || binding.messageIndex < 0) {
    return session.messages;
  }
  return session.messages.slice(binding.messageIndex + 1);
}
