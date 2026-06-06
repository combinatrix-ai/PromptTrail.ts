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
    if (
      binding &&
      (!provider || binding.provider === provider) &&
      conversationBindingMatchesSessionPrefix(session, message, index)
    ) {
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

export function createConversationHistoryFingerprint(
  messages: readonly Message<any>[],
): string {
  return fnv1a(stableStringify(messages.map(canonicalizeMessageForBinding)));
}

function conversationBindingMatchesSessionPrefix(
  session: Session<any, any>,
  message: Message<any>,
  index: number,
): boolean {
  const expected = getConversationHistoryFingerprint(message);
  if (!expected) {
    return true;
  }

  return (
    createConversationHistoryFingerprint(
      session.messages.slice(0, index + 1),
    ) === expected
  );
}

function getConversationHistoryFingerprint(
  message: Message<any>,
): string | undefined {
  const attrs = message.attrs as Record<string, unknown> | undefined;
  const openai = attrs?.openai as Record<string, unknown> | undefined;
  return typeof openai?.historyFingerprint === 'string'
    ? openai.historyFingerprint
    : undefined;
}

function canonicalizeMessageForBinding(message: Message<any>) {
  return {
    type: message.type,
    content: message.content,
    contentParts: message.contentParts,
    cache: message.cache,
    structuredContent: message.structuredContent,
    toolCalls: message.toolCalls,
  };
}

function stableStringify(value: unknown): string {
  if (value instanceof Uint8Array) {
    return JSON.stringify({
      __type: 'Uint8Array',
      data: Array.from(value),
    });
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
