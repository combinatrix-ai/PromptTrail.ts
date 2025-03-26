import React, { useState } from 'react';
import styled from '@emotion/styled';
import {
  LinearTemplate,
  createGenerateOptions,
  createSession,
  type GenerateOptions,
} from '../../../packages/core/src/index';
import type { Message } from '../../../packages/core/src/types';

const Container = styled.div`
  max-width: 800px;
  margin: 20px auto;
  padding: 20px;
  background: #ffffff;
  border-radius: 12px;
  box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
`;

const Title = styled.h1`
  color: #2c3e50;
  text-align: center;
  margin-bottom: 24px;
  font-size: 2em;
`;

const ApiKeyInput = styled.input`
  width: 100%;
  padding: 12px;
  margin-bottom: 24px;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  font-size: 1em;
  transition: border-color 0.3s;

  &:focus {
    outline: none;
    border-color: #3498db;
  }
`;

const ChatContainer = styled.div`
  height: 500px;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
  overflow-y: auto;
  background: #f8f9fa;

  &::-webkit-scrollbar {
    width: 8px;
  }

  &::-webkit-scrollbar-track {
    background: #f1f1f1;
    border-radius: 4px;
  }

  &::-webkit-scrollbar-thumb {
    background: #c0c0c0;
    border-radius: 4px;
  }
`;

const InputContainer = styled.div`
  display: flex;
  gap: 12px;
`;

const MessageInput = styled.input`
  flex: 1;
  padding: 12px;
  border: 2px solid #e0e0e0;
  border-radius: 8px;
  font-size: 1em;
  transition: border-color 0.3s;

  &:focus {
    outline: none;
    border-color: #3498db;
  }
`;

const SendButton = styled.button`
  padding: 12px 24px;
  background: #3498db;
  color: white;
  border: none;
  border-radius: 8px;
  font-size: 1em;
  cursor: pointer;
  transition: background-color 0.3s;

  &:hover {
    background: #2980b9;
  }

  &:disabled {
    background: #95a5a6;
    cursor: not-allowed;
  }
`;

interface MessageProps {
  isUser: boolean;
}

const Message = styled.div<MessageProps>`
  background-color: ${(props: MessageProps) =>
    props.isUser ? '#3498db' : '#f8f9fa'};
  color: ${(props: MessageProps) => (props.isUser ? '#ffffff' : '#2c3e50')};
  padding: 12px 16px;
  border-radius: 12px;
  margin-bottom: 12px;
  max-width: 80%;
  word-wrap: break-word;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
  margin-left: ${(props: MessageProps) => (props.isUser ? 'auto' : '0')};
  margin-right: ${(props: MessageProps) => (props.isUser ? '0' : 'auto')};
`;

interface ChatMessage {
  content: string;
  isUser: boolean;
}

function App() {
  const [apiKey, setApiKey] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [session, setSession] = useState(() => createSession());

  const sendMessage = async () => {
    if (!input.trim() || !apiKey.trim() || isLoading) return;

    setIsLoading(true);
    // Add user message to UI
    const newMessages = [...messages, { content: input, isUser: true }];
    setMessages(newMessages);

    try {
      // Define generateOptions for OpenAI
      const generateOptions: GenerateOptions = createGenerateOptions({
        provider: {
          type: 'openai',
          apiKey: apiKey,
          modelName: 'gpt-4o-mini',
          dangerouslyAllowBrowser: true,
        },
        temperature: 0.7,
      });

      const template = new LinearTemplate()
        .addSystem(
          'You are a helpful AI assistant. Be concise and friendly in your responses.',
        )
        .addUser('User message:', input)
        .addAssistant({ generateOptions: generateOptions });

      // Execute template
      const newSession = await template.execute(session);
      setSession(newSession);

      // Get assistant's response
      const response = newSession.getMessagesByType('assistant').slice(-1)[0];
      if (response) {
        setMessages([
          ...newMessages,
          { content: response.content, isUser: false },
        ]);
      }
    } catch (error) {
      console.error('Error:', error);
      setMessages([
        ...newMessages,
        { content: 'Error: Failed to get response', isUser: false },
      ]);
    } finally {
      setIsLoading(false);
      setInput('');
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <Container>
      <Title>PromptTrail Chat</Title>
      <ApiKeyInput
        type="password"
        placeholder="Enter your OpenAI API key"
        value={apiKey}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
          setApiKey(e.target.value)
        }
      />
      <ChatContainer>
        {messages.map((message, index) => (
          <Message key={index} isUser={message.isUser}>
            {message.content}
          </Message>
        ))}
      </ChatContainer>
      <InputContainer>
        <MessageInput
          placeholder="Type your message..."
          value={input}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setInput(e.target.value)
          }
          onKeyPress={handleKeyPress}
          disabled={isLoading}
        />
        <SendButton
          onClick={sendMessage}
          disabled={isLoading || !input.trim() || !apiKey.trim()}
        >
          {isLoading ? 'Sending...' : 'Send'}
        </SendButton>
      </InputContainer>
    </Container>
  );
}

export default App;
