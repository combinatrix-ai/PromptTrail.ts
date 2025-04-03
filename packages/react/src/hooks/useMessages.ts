import { useMemo } from 'react';
import { Session, Message } from '@prompttrail/core';

/**
 * React hook that extracts and memoizes messages from a session
 * @param session The session to extract messages from
 * @returns Array of messages from the session
 */
export function useMessages<T extends Record<string, unknown>>(
  session: Session<T> | undefined
): Message[] {
  return useMemo(() => {
    if (!session) return [];
    return session.messages;
  }, [session]);
}

/**
 * React hook that extracts and memoizes messages of a specific type from a session
 * @param session The session to extract messages from
 * @param type The message type to filter by ('system', 'user', 'assistant', 'tool_result')
 * @returns Array of messages of the specified type
 */
export function useMessagesByType<T extends Record<string, unknown>, U extends Message['type']>(
  session: Session<T> | undefined,
  type: U
): Extract<Message, { type: U }>[] {
  return useMemo(() => {
    if (!session) return [];
    return session.getMessagesByType(type);
  }, [session, type]);
}
