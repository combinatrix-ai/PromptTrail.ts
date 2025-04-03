import { useState, useCallback } from 'react';
import type { Session, Message, Template } from '../types';

const createSession = <T extends Record<string, unknown>>(): Session<T> => {
  const messages: Message[] = [];
  const metadata = new Map<string, any>();
  
  const session: Session<T> = {
    messages,
    metadata,
    addMessage: (message: Message) => {
      messages.push(message);
      return session;
    },
    getMessagesByType: <U extends Message['type']>(type: U) => {
      return messages.filter(m => m.type === type) as Extract<Message, { type: U }>[];
    },
    updateMetadata: (newMetadata: Partial<T>) => {
      Object.entries(newMetadata).forEach(([key, value]) => {
        metadata.set(key, value);
      });
      return session;
    }
  };
  
  return session;
};

/**
 * React hook for managing a PromptTrail session
 * @param initialSession Optional initial session or function that returns a session
 * @returns Object containing session state and utility functions
 */
export function useSession<T extends Record<string, unknown>>(
  initialSession?: Session<T> | (() => Session<T>)
) {
  // Initialize session state
  const [session, setSession] = useState<Session<T> | undefined>(() => {
    if (initialSession === undefined) {
      return createSession<T>();
    }
    return typeof initialSession === 'function'
      ? initialSession()
      : initialSession;
  });

  // Loading and error states
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Execute a template with the current session
  const executeTemplate = useCallback(
    async <TInput, TOutput>(template: Template<TInput, TOutput>) => {
      if (!session) return;

      setIsLoading(true);
      setError(null);

      try {
        const newSession = await template.execute(session);
        setSession(newSession as Session<T>);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        setIsLoading(false);
      }
    },
    [session]
  );

  // Add a message to the session
  const addMessage = useCallback(
    (message: Message) => {
      if (!session) return;
      setSession(session.addMessage(message) as Session<T>);
    },
    [session]
  );

  // Update session metadata
  const updateMetadata = useCallback(
    (metadata: Partial<T>) => {
      if (!session) return;
      setSession(session.updateMetadata(metadata));
    },
    [session]
  );

  return {
    session,
    executeTemplate,
    addMessage,
    updateMetadata,
    setSession,
    isLoading,
    error,
  };
}
