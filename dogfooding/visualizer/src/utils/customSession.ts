import { Session, Message, createSession, Model } from '@prompttrail/core';
import { useSessionStore } from './sessionStore';

/**
 * Create a custom session that captures messages and updates the UI
 */
export function createCustomSession(options?: { print?: boolean }): Session {
  const baseSession = createSession(options);

  // Create a proxy to intercept addMessage calls
  const sessionProxy = new Proxy(baseSession, {
    get(target, prop, receiver) {
      // Intercept the addMessage method
      if (prop === 'addMessage') {
        return function (message: Message): Session {
          // Update the UI based on the message type
          if (message.type === 'system') {
            useSessionStore
              .getState()
              .addChatMessage('system', message.content);
          } else if (message.type === 'user') {
            useSessionStore.getState().addChatMessage('user', message.content);
          } else if (message.type === 'assistant') {
            useSessionStore
              .getState()
              .addChatMessage('assistant', message.content);
          }

          // Log the message for debugging
          console.log(
            `Added message to session: ${message.type} - ${message.content.substring(0, 50)}${message.content.length > 50 ? '...' : ''}`,
          );

          // Call the original method
          const newSession = target.addMessage(message);

          // Return a new proxy for the new session
          return createCustomSessionFromExisting(newSession);
        };
      }

      // Add a custom method to handle model responses
      if (prop === 'executeWithModel') {
        return async function (model: Model): Promise<Session> {
          try {
            // Get the response from the model
            const response = await model.send(target);

            // Add the response as an assistant message to the UI
            useSessionStore
              .getState()
              .addChatMessage('assistant', response.content);

            // Add the message to the session
            const newSession = target.addMessage(response);

            // Return a new proxy for the new session
            return createCustomSessionFromExisting(newSession);
          } catch (error) {
            console.error('Error sending message to model:', error);

            // Add error message to the UI
            useSessionStore
              .getState()
              .addChatMessage(
                'system',
                `Error: ${error instanceof Error ? error.message : String(error)}`,
              );

            // Return the current session
            return sessionProxy;
          }
        };
      }

      // For all other properties, use the original
      return Reflect.get(target, prop, receiver);
    },
  });

  return sessionProxy;
}

/**
 * Create a custom session from an existing session
 */
function createCustomSessionFromExisting(session: Session): Session {
  return new Proxy(session, {
    get(target, prop, receiver) {
      // Intercept the addMessage method
      if (prop === 'addMessage') {
        return function (message: Message): Session {
          // Update the UI based on the message type
          if (message.type === 'system') {
            useSessionStore
              .getState()
              .addChatMessage('system', message.content);
          } else if (message.type === 'user') {
            useSessionStore.getState().addChatMessage('user', message.content);
          } else if (message.type === 'assistant') {
            useSessionStore
              .getState()
              .addChatMessage('assistant', message.content);
          }

          // Log the message for debugging
          console.log(
            `Added message to session (existing): ${message.type} - ${message.content.substring(0, 50)}${message.content.length > 50 ? '...' : ''}`,
          );

          // Call the original method
          const newSession = target.addMessage(message);

          // Return a new proxy for the new session
          return createCustomSessionFromExisting(newSession);
        };
      }

      // Add a custom method to handle model responses
      if (prop === 'executeWithModel') {
        return async function (model: Model): Promise<Session> {
          try {
            // Get the response from the model
            const response = await model.send(target);

            // Add the response as an assistant message to the UI
            useSessionStore
              .getState()
              .addChatMessage('assistant', response.content);

            // Add the message to the session
            const newSession = target.addMessage(response);

            // Return a new proxy for the new session
            return createCustomSessionFromExisting(newSession);
          } catch (error) {
            console.error('Error sending message to model:', error);

            // Add error message to the UI
            useSessionStore
              .getState()
              .addChatMessage(
                'system',
                `Error: ${error instanceof Error ? error.message : String(error)}`,
              );

            // Return the current session
            return receiver;
          }
        };
      }

      // For all other properties, use the original
      return Reflect.get(target, prop, receiver);
    },
  });
}
